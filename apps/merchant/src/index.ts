// Demo store: a shop that takes payment over x402. It stands in for anywhere a
// shopper might buy from. It is a fixture for the demo, not part of the product.
import express from "express";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { paymentMiddleware, x402ResourceServer } from "@x402/express";
import { ExactStellarScheme } from "@x402/stellar/exact/server";
import { NETWORK } from "@mandate/shared";
import { requireEnv } from "@mandate/shared/env";

const port = Number(process.env.MERCHANT_PORT ?? 4021);
// Must be a classic G-address with a USDC trustline.
const payTo = requireEnv("MERCHANT_ADDRESS");
const facilitatorUrl = process.env.FACILITATOR_URL ?? "https://x402.org/facilitator";

// Optional: charge in another SEP-41 token (C-address) instead of USDC, e.g.
// testnet XLM while waiting on the USDC faucet. Amounts are then base units.
const asset = process.env.MERCHANT_ASSET;
const price = (usd: string, baseUnits: string) => (asset ? { amount: baseUnits, asset } : usd);

// A second, look-alike store that is not in the seller registry. The shopper's
// rules should refuse to pay it. Demo fixture only.
const impostorPayTo = process.env.IMPOSTOR_ADDRESS;

const resourceServer = new x402ResourceServer(
  new HTTPFacilitatorClient({ url: facilitatorUrl }),
).register(NETWORK, new ExactStellarScheme());

const app = express();

app.use(
  paymentMiddleware(
    {
      "GET /herbs": {
        accepts: [{ scheme: "exact", price: price("$2.40", "24000000"), network: NETWORK, payTo }],
        description: "Fresh herbs bundle",
      },
      "GET /mixer": {
        // Priced above a typical limit, to show a blocked payment.
        accepts: [{ scheme: "exact", price: price("$120.00", "1200000000"), network: NETWORK, payTo }],
        description: "Commercial stand mixer",
      },
      ...(impostorPayTo
        ? {
            "GET /lookalike/herbs": {
              accepts: [
                { scheme: "exact" as const, price: price("$2.40", "24000000"), network: NETWORK, payTo: impostorPayTo },
              ],
              description: "Fresh herbs bundle",
            },
          }
        : {}),
    },
    resourceServer,
  ),
);

const order = (item: string) => ({ order: "confirmed", item, pickup: "Tomorrow, 8 am" });

app.get("/herbs", (_req, res) => {
  res.json(order("Fresh herbs bundle"));
});

app.get("/lookalike/herbs", (_req, res) => {
  res.json(order("Fresh herbs bundle"));
});

app.get("/mixer", (_req, res) => {
  res.json(order("Commercial stand mixer"));
});

app.get("/health", (_req, res) => {
  res.json({ ok: true, payTo, network: NETWORK });
});

app.listen(port, () => {
  console.log(`merchant listening on http://localhost:${port} (payTo ${payTo})`);
});
