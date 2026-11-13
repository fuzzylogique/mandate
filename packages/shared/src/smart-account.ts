// Signing for the mandate smart account. Node-only (uses the Stellar SDK).
//
// A classic Stellar account signs an auth entry with "public key + signature".
// The smart account instead expects an `AuthPayload`: which signers signed,
// and which context rule each auth context should be checked against.
import {
  Address,
  buildAuthorizationEntryPreimage,
  contract,
  hash,
  nativeToScVal,
  rpc,
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

export interface SmartAccountCall {
  rpcUrl: string;
  networkPassphrase: string;
  /** Contract to call and the function on it. */
  contractId: string;
  method: string;
  args: xdr.ScVal[];
  /** Classic account that submits the transaction and pays the fee. */
  feePayer: Keypair;
  /** Who signs on behalf of the smart account, and under which rule. */
  signer: SmartAccountSigner;
  contextRuleId: number;
}

/**
 * Calls a contract function that needs the smart account's authorization:
 * simulate, sign the account's auth entry, simulate again, submit.
 * Returns the transaction hash and the function's return value.
 */
export async function invokeAsSmartAccount(
  call: SmartAccountCall,
): Promise<{ txHash: string; result: xdr.ScVal }> {
  const server = new rpc.Server(call.rpcUrl);
  const tx = await contract.AssembledTransaction.build({
    contractId: call.contractId,
    method: call.method,
    args: call.args,
    networkPassphrase: call.networkPassphrase,
    rpcUrl: call.rpcUrl,
    publicKey: call.feePayer.publicKey(),
    parseResultXdr: (result: xdr.ScVal) => result,
  });

  const operation = tx.built?.operations[0];
  if (!operation || operation.type !== "invokeHostFunction") {
    throw new Error("Expected a single invokeHostFunction operation");
  }
  const expirationLedger = (await server.getLatestLedger()).sequence + 60;
  for (const entry of operation.auth ?? []) {
    if (authEntryAddress(entry) === call.signer.smartAccount) {
      signSmartAccountAuthEntry(
        entry,
        call.signer,
        [call.contextRuleId],
        expirationLedger,
        call.networkPassphrase,
      );
    }
  }

  // Simulate again with the signature attached, so the footprint and fees
  // cover what __check_auth, the verifier and the policies read and write.
  await tx.simulate();

  const { signTransaction } = contract.basicNodeSigner(call.feePayer, call.networkPassphrase);
  const sent = await tx.signAndSend({ signTransaction, force: true });
  const txHash = sent.sendTransactionResponse?.hash ?? "";
  return { txHash, result: sent.result as xdr.ScVal };
}

export interface MandateParams {
  /** Token the agent may spend (C-address). */
  token: string;
  /** Label stored on chain, at most 20 bytes. */
  name: string;
  /** Limit per period, in token base units. */
  limitBaseUnits: bigint;
  /** Length of the rolling window, in ledgers (about 5 seconds each). */
  periodLedgers: number;
  /** Ledger after which the mandate stops working; omit for no expiry. */
  validUntilLedger?: number;
  /** The agent's public key. */
  agent: Keypair;
  verifier: string;
  spendingLimitPolicy: string;
  verifiedSellerPolicy: string;
  sellerRegistry: string;
}

/** Arguments for `add_context_rule` that create one agent mandate. */
export function mandateArgs(params: MandateParams): xdr.ScVal[] {
  const address = (id: string) => Address.fromString(id).toScVal();
  const struct = (fields: Record<string, xdr.ScVal>) =>
    xdr.ScVal.scvMap(
      Object.keys(fields)
        .sort()
        .map((key) => mapEntry(key, fields[key]!)),
    );

  // Policy address -> install parameters. Map keys must be sorted by address.
  const policies = [
    {
      id: params.spendingLimitPolicy,
      params: struct({
        spending_limit: nativeToScVal(params.limitBaseUnits, { type: "i128" }),
        period_ledgers: xdr.ScVal.scvU32(params.periodLedgers),
      }),
    },
    {
      id: params.verifiedSellerPolicy,
      params: struct({ registry: address(params.sellerRegistry) }),
    },
  ].sort((a, b) =>
    Buffer.compare(Address.fromString(a.id).toBuffer(), Address.fromString(b.id).toBuffer()),
  );

  return [
    xdr.ScVal.scvVec([symbol("CallContract"), address(params.token)]),
    nativeToScVal(params.name, { type: "string" }),
    params.validUntilLedger ? xdr.ScVal.scvU32(params.validUntilLedger) : xdr.ScVal.scvVoid(),
    xdr.ScVal.scvVec([externalSigner(params.verifier, params.agent)]),
    xdr.ScVal.scvMap(
      policies.map((policy) => new xdr.ScMapEntry({ key: address(policy.id), val: policy.params })),
    ),
  ];
}
