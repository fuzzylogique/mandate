// Everything the dashboard reads from or writes to Stellar.
//
// DEMO ONLY: this service signs as the owner with OWNER_SECRET, so the
// dashboard can create and revoke mandates without a wallet. A real deployment
// has the owner sign in their own wallet or with a passkey.
import {
  Account,
  Address,
  Keypair,
  Networks,
  Operation,
  rpc,
  scValToNative,
  TransactionBuilder,
  xdr,
} from "@stellar/stellar-sdk";
import type { MandatePeriod } from "@mandate/shared";
import { invokeAsSmartAccount, mandateArgs } from "@mandate/shared/smart-account";

const OWNER_RULE_ID = 0;

/** Rolling window lengths in ledgers (about 5 seconds each). */
export const PERIOD_LEDGERS: Record<MandatePeriod, number> = {
  day: 17_280,
  week: 120_960,
  month: 518_400,
};

export interface ChainConfig {
  rpcUrl: string;
  smartAccount: string;
  verifier: string;
  spendingLimitPolicy: string;
  verifiedSellerPolicy: string;
  sellerRegistry: string;
  ownerSecret: string;
}

export interface MandateOnChain {
  /** Limit per period, base units. */
  limit: bigint;
  /** Spent inside the current rolling window, base units. */
  spent: bigint;
  period: MandatePeriod | null;
}

interface SpendingLimitData {
  spending_limit: bigint;
  period_ledgers: number;
  spending_history: { amount: bigint; ledger_sequence: number }[];
}

export class Chain {
  private readonly server: rpc.Server;
  private readonly owner: Keypair;
  private readonly config: ChainConfig;
  /** Owner transactions share one sequence number, so they run one at a time. */
  private ownerQueue: Promise<unknown> = Promise.resolve();

  constructor(config: ChainConfig) {
    this.config = config;
    this.server = new rpc.Server(config.rpcUrl);
    this.owner = Keypair.fromSecret(config.ownerSecret);
  }

  /** Calls a read-only contract function by simulating it. */
  private async read<T>(contractId: string, method: string, args: xdr.ScVal[]): Promise<T> {
    const tx = new TransactionBuilder(new Account(this.owner.publicKey(), "0"), {
      fee: "100",
      networkPassphrase: Networks.TESTNET,
    })
      .addOperation(Operation.invokeContractFunction({ contract: contractId, function: method, args }))
      .setTimeout(30)
      .build();
    const simulation = await this.server.simulateTransaction(tx);
    if (rpc.Api.isSimulationError(simulation) || !simulation.result) {
      throw new Error(`${method} failed`);
    }
    return scValToNative(simulation.result.retval) as T;
  }

  private address(id: string): xdr.ScVal {
    return Address.fromString(id).toScVal();
  }

  /** Token balance of the smart account, base units. */
  async balance(token: string): Promise<bigint> {
    return this.read<bigint>(token, "balance", [this.address(this.config.smartAccount)]);
  }

  async isVerifiedSeller(seller: string): Promise<boolean> {
    return this.read<boolean>(this.config.sellerRegistry, "is_verified", [this.address(seller)]);
  }

  /** Limit and spend of one mandate, or null if the rule no longer exists. */
  async mandate(ruleId: number): Promise<MandateOnChain | null> {
    try {
      await this.read(this.config.smartAccount, "get_context_rule", [xdr.ScVal.scvU32(ruleId)]);
    } catch {
      return null;
    }
    const [data, latest] = await Promise.all([
      this.read<SpendingLimitData>(this.config.spendingLimitPolicy, "get_spending_limit_data", [
        xdr.ScVal.scvU32(ruleId),
        this.address(this.config.smartAccount),
      ]),
      this.server.getLatestLedger(),
    ]);
    // The policy only drops old entries when it next runs, so apply the
    // window here to show what is spendable right now.
    const windowStart = latest.sequence - data.period_ledgers;
    const spent = data.spending_history
      .filter((entry) => entry.ledger_sequence > windowStart)
      .reduce((total, entry) => total + entry.amount, 0n);
    const period =
      (Object.keys(PERIOD_LEDGERS) as MandatePeriod[]).find(
        (key) => PERIOD_LEDGERS[key] === data.period_ledgers,
      ) ?? null;
    return { limit: data.spending_limit, spent, period };
  }

  private asOwner<T>(task: () => Promise<T>): Promise<T> {
    const run = this.ownerQueue.then(task, task);
    this.ownerQueue = run.catch(() => undefined);
    return run;
  }

  /** Creates a mandate for `agent` and returns its rule id. */
  createMandate(input: {
    name: string;
    token: string;
    limitBaseUnits: bigint;
    period: MandatePeriod;
    agent: Keypair;
  }): Promise<number> {
    const { smartAccount, verifier } = this.config;
    return this.asOwner(async () => {
      const { result } = await invokeAsSmartAccount({
        rpcUrl: this.config.rpcUrl,
        networkPassphrase: Networks.TESTNET,
        contractId: smartAccount,
        method: "add_context_rule",
        args: mandateArgs({
          token: input.token,
          name: input.name,
          limitBaseUnits: input.limitBaseUnits,
          periodLedgers: PERIOD_LEDGERS[input.period],
          agent: input.agent,
          verifier,
          spendingLimitPolicy: this.config.spendingLimitPolicy,
          verifiedSellerPolicy: this.config.verifiedSellerPolicy,
          sellerRegistry: this.config.sellerRegistry,
        }),
        feePayer: this.owner,
        signer: { smartAccount, verifier, keypair: this.owner },
        contextRuleId: OWNER_RULE_ID,
      });
      return (scValToNative(result) as { id: number }).id;
    });
  }

  /** Removes the agent's rule. Its key can no longer authorize anything. */
  revokeMandate(ruleId: number): Promise<void> {
    const { smartAccount, verifier } = this.config;
    return this.asOwner(async () => {
      await invokeAsSmartAccount({
        rpcUrl: this.config.rpcUrl,
        networkPassphrase: Networks.TESTNET,
        contractId: smartAccount,
        method: "remove_context_rule",
        args: [xdr.ScVal.scvU32(ruleId)],
        feePayer: this.owner,
        signer: { smartAccount, verifier, keypair: this.owner },
        contextRuleId: OWNER_RULE_ID,
      });
    });
  }
}
