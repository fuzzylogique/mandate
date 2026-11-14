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
  type Keypair,
} from "@stellar/stellar-sdk";

export interface SmartAccountSigner {
  /** The smart account (C-address) being authorized. */
  smartAccount: string;
  /** Deployed ed25519 verifier contract (C-address). */
  verifier: string;
  /** Key registered on the rule as `Signer::External(verifier, public key)`. */
  keypair: Keypair;
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
  const signature = signer.keypair.sign(hash(digestPreimage.toXDR()));

  // AuthPayload { context_rule_ids, signers: Map<Signer, Bytes> }
  const authPayload = xdr.ScVal.scvMap([
    mapEntry("context_rule_ids", ruleIds),
    mapEntry(
      "signers",
      xdr.ScVal.scvMap([
        new xdr.ScMapEntry({
          key: externalSigner(signer.verifier, signer.keypair),
          val: xdr.ScVal.scvBytes(signature),
        }),
      ]),
    ),
  ]);

  credentials.signatureExpirationLedger(expirationLedger);
  credentials.signature(authPayload);
}
