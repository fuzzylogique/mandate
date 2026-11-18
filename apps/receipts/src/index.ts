import { fileURLToPath } from "node:url";
import { createPaymentApp } from "./payments/http.ts";
import { StellarGateway, stellarConfig } from "./payments/stellar.ts";
import { StellarPaymentService } from "./payments/stellar-service.ts";

const port = Number(process.env.RECEIPTS_PORT ?? 4022);
// 0.0.0.0 lets a phone on the same network reach the API; the default keeps it on this Mac.
const host = process.env.RECEIPTS_HOST || "127.0.0.1";
const path = process.env.PAYMENTS_CHAIN_DB ?? fileURLToPath(new URL("../workspace.sqlite", import.meta.url));
const gateway = new StellarGateway(path, stellarConfig(process.env));
await gateway.check();
const service = new StellarPaymentService(path, gateway);
const server = createPaymentApp(service).listen(port, host, () => {
  console.log(`Mandate API: http://localhost:${port}${host === "127.0.0.1" ? "" : ` (listening on ${host})`}`);
});
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => server.close(() => { service.close(); process.exit(0); }));
}
