// x402 "exact" client scheme that pays from a mandate smart account.
//
// The stock client in @x402/stellar signs auth entries in the classic-account
// format (public key + signature). A smart account expects an `AuthPayload`
// instead. This class follows the same steps as the stock client and swaps
// only the signing step. The signing itself is proven on testnet (see
// scripts/agent-transfer.ts); whether a facilitator accepts the result is a
// separate question, answered in the README.
//
// Keep @stellar/stellar-sdk on the same major version as @x402/stellar (16.x).
import { contract, nativeToScVal, rpc, type Keypair, type xdr } from "@stellar/stellar-sdk";
import type { PaymentPayload, PaymentRequirements, SchemeNetworkClient } from "@x402/core/types";
import { authEntryAddress, signSmartAccountAuthEntry } from "@mandate/shared/smart-account";
import {
  findDefaultAsset,
  getEstimatedLedgerCloseTimeSeconds,
  getNetworkPassphrase,
  getRpcClient,
  getRpcUrl,
  type RpcConfig,
} from "@x402/stellar";

export interface SmartAccountPayerConfig {
  /** The mandate smart account (C-address) holding the USDC. */
  smartAccount: string;
  /** Id of the agent's context rule on that account. */
  contextRuleId: number;
  /** Deployed ed25519 verifier contract (C-address). */
  verifier: string;
  /** The agent's own key, registered as an External signer on the rule. */
  agentKeypair: Keypair;
}

export class SmartAccountExactStellarScheme implements SchemeNetworkClient {
  readonly scheme = "exact";
  // Lets the x402 client recognise USDC as a default asset, as the stock scheme does.
  readonly findDefaultAsset = findDefaultAsset;

  private readonly config: SmartAccountPayerConfig;
  private readonly rpcConfig?: RpcConfig;

  constructor(config: SmartAccountPayerConfig, rpcConfig?: RpcConfig) {
    this.config = config;
    this.rpcConfig = rpcConfig;
  }

  async createPaymentPayload(
    x402Version: number,
    requirements: PaymentRequirements,
  ): Promise<Pick<PaymentPayload, "x402Version" | "payload">> {
    const { network, payTo, asset, amount, maxTimeoutSeconds } = requirements;
    const { smartAccount } = this.config;
    const networkPassphrase = getNetworkPassphrase(network);

    const rpcServer = getRpcClient(network, this.rpcConfig);
    const { sequence: currentLedger } = await rpcServer.getLatestLedger();
    const ledgerSeconds = await getEstimatedLedgerCloseTimeSeconds(network);
    const expirationLedger = currentLedger + Math.ceil(maxTimeoutSeconds / ledgerSeconds);

    // SEP-41 transfer(from, to, amount), with the smart account as `from`.
    const tx = await contract.AssembledTransaction.build({
      contractId: asset,
      method: "transfer",
      args: [
        nativeToScVal(smartAccount, { type: "address" }),
        nativeToScVal(payTo, { type: "address" }),
        nativeToScVal(amount, { type: "i128" }),
      ],
      networkPassphrase,
      rpcUrl: getRpcUrl(network, this.rpcConfig),
      parseResultXdr: (result: xdr.ScVal) => result,
    });

    const operation = tx.built?.operations[0];
    if (!operation || operation.type !== "invokeHostFunction") {
      throw new Error("Expected a single invokeHostFunction operation");
    }
    const authEntries = operation.auth ?? [];
    let signed = 0;

    for (const entry of authEntries) {
      const entryAddress = authEntryAddress(entry);
      if (entryAddress !== smartAccount) {
        throw new Error(`Unexpected signer required: ${entryAddress}`);
      }
      signSmartAccountAuthEntry(
        entry,
        { smartAccount, verifier: this.config.verifier, keypair: this.config.agentKeypair },
        [this.config.contextRuleId],
        expirationLedger,
        networkPassphrase,
      );
      signed += 1;
    }

    if (signed !== 1) {
      throw new Error(`Expected exactly one auth entry for ${smartAccount}, signed ${signed}`);
    }

    // Simulate again with the signature attached, so the footprint and fees
    // cover what __check_auth, the verifier and the policies read and write.
    await tx.simulate();
    if (!tx.simulation || rpc.Api.isSimulationError(tx.simulation)) {
      // With the signature attached, simulation runs the account's rules. A
      // failure here means the mandate does not allow this payment. (Skipping
      // this check would not get the payment through: the facilitator and the
      // network run the same rules.)
      throw new Error("The smart account refused to authorize this payment (mandate rules)");
    }

    return { x402Version, payload: { transaction: tx.built!.toXDR() } };
  }
}
