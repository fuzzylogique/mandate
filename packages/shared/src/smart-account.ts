// Signing for the mandate smart account. Node-only (uses the Stellar SDK).
//
// A classic Stellar account signs an auth entry with "public key + signature".
// The smart account instead expects an `AuthPayload`: which signers signed,
// and which context rule each auth context should be checked against.
import {
  Address,
  buildAuthorizationEntryPreimage,
  hash,
  xdr,
  Keypair,
} from "@stellar/stellar-sdk";

export interface SmartAccountSigner {
  /** The smart account (C-address) being authorized. */
  smartAccount: string;
  /** Deployed signature verifier contract (C-address). */
  verifier: string;
  /** Key registered on the rule as `Signer::External(verifier, public key)`. */
  keypair: Keypair;
  /** Agent-aware mandate verifier: registry identity bound into the signature. */
  agentId?: string;
}

const symbol = (name: string) => xdr.ScVal.scvSymbol(name);
const mapEntry = (key: string, val: xdr.ScVal) => new xdr.ScMapEntry({ key: symbol(key), val });

/** `Signer::External(verifier, raw ed25519 public key)` as the contract sees it. */
export function externalSigner(verifier: string, keypair: Keypair): xdr.ScVal {
  return xdr.ScVal.scvVec([
    symbol("External"),
    Address.fromString(verifier).toScVal(),
    xdr.ScVal.scvBytes(keypair.rawPublicKey()),
  ]);
}

/**
 * A rule signer for an agent: the agent verifier plus (account, agent public key).
 * `key` is the agent's keypair, or just its public key (G-address) when the
 * agent holds the secret itself.
 */
export function agentSigner(verifier: string, key: Keypair | string, account: string): xdr.ScVal {
  const publicKey = typeof key === "string" ? Keypair.fromPublicKey(key).rawPublicKey() : key.rawPublicKey();
  const keyData = xdr.ScVal.scvMap([
    mapEntry("account", Address.fromString(account).toScVal()),
    mapEntry("public_key", xdr.ScVal.scvBytes(publicKey)),
  ]);
  return xdr.ScVal.scvVec([symbol("External"), Address.fromString(verifier).toScVal(), xdr.ScVal.scvBytes(keyData.toXDR())]);
}

/** Address credentials of an auth entry, for both credential versions. */
function addressCredentials(entry: xdr.SorobanAuthorizationEntry): xdr.SorobanAddressCredentials | null {
  const credentials = entry.credentials();
  switch (credentials.switch().name) {
    case "sorobanCredentialsAddress":
      return credentials.address();
    case "sorobanCredentialsAddressV2":
      return credentials.addressV2();
    default:
      return null;
  }
}

/** The address an auth entry is for, or null if it uses source-account credentials. */
export function authEntryAddress(entry: xdr.SorobanAuthorizationEntry): string | null {
  const credentials = addressCredentials(entry);
  return credentials ? Address.fromScAddress(credentials.address()).toString() : null;
}

/**
 * Signs `entry` in place on behalf of the smart account.
 *
 * @param contextRuleIds one rule id per auth context in the entry, in order.
 *   A plain token transfer has exactly one context.
 */
export function signSmartAccountAuthEntry(
  entry: xdr.SorobanAuthorizationEntry,
  signer: SmartAccountSigner,
  contextRuleIds: number[],
  expirationLedger: number,
  networkPassphrase: string,
): void {
  const credentials = addressCredentials(entry);
  if (!credentials) {
    throw new Error(`Unsupported credential type: ${entry.credentials().switch().name}`);
  }
  if (authEntryAddress(entry) !== signer.smartAccount) {
    throw new Error(`Auth entry is for ${authEntryAddress(entry)}, not ${signer.smartAccount}`);
  }

  // The payload the Stellar smart contract host hands to __check_auth.
  const signaturePayload = hash(
    buildAuthorizationEntryPreimage(entry, expirationLedger, networkPassphrase).toXDR(),
  );

  // Signers do not sign that payload directly. They sign the digest of an
  // AuthDigestPreimage binding account + rule ids + payload, so a signature
  // collected under one rule cannot be replayed under a weaker one.
  // Map keys must stay in sorted order.
  const ruleIds = xdr.ScVal.scvVec(contextRuleIds.map((id) => xdr.ScVal.scvU32(id)));
  const digestPreimage = xdr.ScVal.scvMap([
    mapEntry("account", Address.fromString(signer.smartAccount).toScVal()),
    mapEntry("context_rule_ids", ruleIds),
    mapEntry("signature_payload", xdr.ScVal.scvBytes(signaturePayload)),
  ]);
  const payload = hash(digestPreimage.toXDR());
  const agentDigest = signer.agentId ? xdr.ScVal.scvMap([
    mapEntry("agent_id", xdr.ScVal.scvString(signer.agentId)),
    mapEntry("payload", xdr.ScVal.scvBytes(payload)),
  ]) : undefined;
  const signature = signer.keypair.sign(agentDigest ? hash(agentDigest.toXDR()) : payload);
  const signatureData = signer.agentId ? xdr.ScVal.scvMap([
    mapEntry("agent_id", xdr.ScVal.scvString(signer.agentId)),
    mapEntry("signature", xdr.ScVal.scvBytes(signature)),
  ]).toXDR() : signature;

  // AuthPayload { context_rule_ids, signers: Map<Signer, Bytes> }
  const authPayload = xdr.ScVal.scvMap([
    mapEntry("context_rule_ids", ruleIds),
    mapEntry(
      "signers",
      xdr.ScVal.scvMap([
        new xdr.ScMapEntry({
          key: signer.agentId ? agentSigner(signer.verifier, signer.keypair, signer.smartAccount) : externalSigner(signer.verifier, signer.keypair),
          val: xdr.ScVal.scvBytes(signatureData),
        }),
      ]),
    ),
  ]);

  credentials.signatureExpirationLedger(expirationLedger);
  credentials.signature(authPayload);
}
