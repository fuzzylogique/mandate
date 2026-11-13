// Reads `PaymentAuthorized` events from the verified-seller policy contract
// and turns each one into a receipt.
import { rpc, scValToNative, xdr } from "@stellar/stellar-sdk";
import type { Receipt } from "@mandate/shared";
import type { ReceiptStore } from "./store.ts";

// Topics: ["payment_authorized", smart_account, seller]
// Data:   { amount, context_rule_id, token }
const EVENT_NAME = "payment_authorized";

interface PaymentAuthorizedData {
  amount: bigint;
  context_rule_id: number;
  token: string;
}

export interface IndexerOptions {
  rpcUrl: string;
  policyContractId: string;
  store: ReceiptStore;
  onReceipt?: (receipt: Omit<Receipt, "annotation">) => void | Promise<void>;
  pollMs?: number;
  /** How far back a first run scans. 17,280 ledgers is about a day. */
  lookbackLedgers?: number;
}

export function startIndexer(options: IndexerOptions): () => void {
  const { rpcUrl, policyContractId, store, onReceipt, pollMs = 5000, lookbackLedgers = 17_280 } = options;
  const server = new rpc.Server(rpcUrl);
  const filters: rpc.Api.EventFilter[] = [
    {
      type: "contract",
      contractIds: [policyContractId],
      topics: [[xdr.ScVal.scvSymbol(EVENT_NAME).toXDR("base64"), "*", "*"]],
    },
  ];
  let stopped = false;

  // A first run looks back about a day, or as far as the RPC still keeps events.
  async function firstLedger(): Promise<number> {
    const health = await server.getHealth();
    return Math.max(health.oldestLedger, health.latestLedger - lookbackLedgers, 1);
  }

  async function poll(): Promise<void> {
    const cursor = store.getCursor();
    const page = cursor
      ? await server.getEvents({ filters, cursor, limit: 100 })
      : await server.getEvents({ filters, startLedger: await firstLedger(), limit: 100 });

    for (const event of page.events) {
      const [, smartAccount, seller] = event.topic.map((topic) => scValToNative(topic) as string);
      const data = scValToNative(event.value) as PaymentAuthorizedData;
      if (!smartAccount || !seller) continue;

      const receipt: Omit<Receipt, "annotation"> = {
        id: event.id,
        txHash: event.txHash,
        ledger: event.ledger,
        paidAt: event.ledgerClosedAt,
        smartAccount,
        contextRuleId: Number(data.context_rule_id),
        seller,
        token: data.token,
        amount: data.amount.toString(),
      };
      if (store.insert(receipt)) {
        await onReceipt?.(receipt);
      }
    }
    if (page.cursor) store.setCursor(page.cursor);
  }

  async function loop(): Promise<void> {
    while (!stopped) {
      try {
        await poll();
      } catch (error) {
        console.error("[indexer] poll failed:", error);
      }
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
  }

  void loop();
  return () => {
    stopped = true;
  };
}
