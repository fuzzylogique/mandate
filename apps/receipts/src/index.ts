// Mandate API: sign-in, accounts, shoppers and their rules, the owner's
// decisions, receipts indexed from chain, and the API assistants call.
import { fileURLToPath } from "node:url";
import { createApp } from "./http.ts";
import { startIndexer } from "./indexer.ts";
import { StellarGateway, stellarConfig } from "./payments/stellar.ts";
import { MandateService } from "./service.ts";
import { ReceiptStore } from "./store.ts";

const env = process.env;
const port = Number(env.RECEIPTS_PORT ?? 4022);
const host = env.RECEIPTS_HOST ?? "0.0.0.0";
const dbPath = env.PAYMENTS_CHAIN_DB ?? fileURLToPath(new URL("../workspace.sqlite", import.meta.url));
const config = stellarConfig(env);

const gateway = new StellarGateway(dbPath, config);
await gateway.check();
const receipts = new ReceiptStore(env.RECEIPTS_DB ?? fileURLToPath(new URL("../receipts.sqlite", import.meta.url)));
const service = new MandateService(dbPath, gateway, {
  merchantUrl: env.MERCHANT_URL ?? "http://localhost:4021",
  verifier: config.verifier!,
  rpcUrl: config.rpcUrl,
  explorerUrl: config.explorerUrl.replace(/\/$/, ""),
  receipts,
});

// Every payment that passes a shopper's rules emits PaymentAuthorized from the
// trusted-store policy. That event, not the shopper's word, makes the receipt.
const stopIndexer = config.verifiedSmartPolicy
  ? startIndexer({ rpcUrl: config.rpcUrl, policyContractId: config.verifiedSmartPolicy, store: receipts, pollMs: 2000 })
  : () => {};

// Hosted shoppers run their jobs when due.
const jobs = setInterval(() => { void service.runDue().catch((error) => console.error("[jobs]", error)); }, 15_000);

const server = createApp(service).listen(port, host, () => {
  console.log(`Mandate API on http://localhost:${port}`);
});
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    clearInterval(jobs);
    stopIndexer();
    server.close(() => { service.close(); process.exit(0); });
  });
}
