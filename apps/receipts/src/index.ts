// Receipt service: indexes agent payments from chain, stores them, and serves
// them to the dashboard.
import express from "express";
import { formatAmount, type Receipt, type ReceiptAnnotation } from "@mandate/shared";
import { startIndexer } from "./indexer.ts";
import { ReceiptStore } from "./store.ts";

const port = Number(process.env.RECEIPTS_PORT ?? 4022);
const rpcUrl = process.env.RPC_URL ?? "https://soroban-testnet.stellar.org";
const policyContractId = process.env.VERIFIED_SELLER_POLICY_ID;

const store = new ReceiptStore(process.env.RECEIPTS_DB ?? "receipts.sqlite");

// TODO: send a real email (Resend, Postmark, ...) to the account owner.
// Needs an owner-email lookup keyed by smart account.
async function notifyOwner(receipt: Omit<Receipt, "annotation">): Promise<void> {
  console.log(
    `[receipt] account ${receipt.smartAccount} rule ${receipt.contextRuleId} paid ` +
      `${formatAmount(receipt.amount)} to ${receipt.seller} (tx ${receipt.txHash})`,
  );
}

if (policyContractId) {
  startIndexer({ rpcUrl, policyContractId, store, onReceipt: notifyOwner });
} else {
  console.warn("[receipts] VERIFIED_SELLER_POLICY_ID not set: serving stored receipts only");
}

const app = express();
app.use(express.json());
app.use((_req, res, next) => {
  // Dashboard runs on another port in development.
  res.setHeader("access-control-allow-origin", "*");
  res.setHeader("access-control-allow-headers", "content-type");
  next();
});

app.get("/receipts", (req, res) => {
  const account = typeof req.query.account === "string" ? req.query.account : undefined;
  res.json(store.list(account));
});

// TODO: authenticate this. Anyone who can reach it can describe any payment.
app.post("/annotations", (req, res) => {
  const body = req.body as Partial<ReceiptAnnotation> | undefined;
  if (!body?.txHash || !body.resource) {
    res.status(400).json({ error: "txHash and resource are required" });
    return;
  }
  store.annotate({
    txHash: body.txHash,
    resource: body.resource,
    description: body.description,
    agentName: body.agentName,
    sellerDomain: body.sellerDomain,
  });
  res.status(204).end();
});

app.get("/health", (_req, res) => {
  res.json({ ok: true, indexing: Boolean(policyContractId) });
});

app.listen(port, () => {
  console.log(`receipt service listening on http://localhost:${port}`);
});
