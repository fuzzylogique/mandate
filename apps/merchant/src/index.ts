// Demo seller: a paid API behind x402. It stands in for any service an agent
// might buy from. It is a fixture for the demo, not part of the product.
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

// A second, look-alike seller that is not in the seller registry. The agent's
// mandate should refuse to pay it. Demo fixture only.
const impostorPayTo = process.env.IMPOSTOR_ADDRESS;

const resourceServer = new x402ResourceServer(
  new HTTPFacilitatorClient({ url: facilitatorUrl }),
).register(NETWORK, new ExactStellarScheme());

const app = express();

app.use(
  paymentMiddleware(
    {
      "GET /weather": {
        accepts: [{ scheme: "exact", price: price("$0.01", "100000"), network: NETWORK, payTo }],
        description: "Current weather report",
      },
      "GET /premium-report": {
        // Priced above the demo mandate's limit, to show a blocked payment.
        accepts: [{ scheme: "exact", price: price("$5.00", "50000000"), network: NETWORK, payTo }],
        description: "Premium market report",
      },
      ...(impostorPayTo
        ? {
            "GET /impostor/weather": {
              accepts: [
                { scheme: "exact" as const, price: price("$0.01", "100000"), network: NETWORK, payTo: impostorPayTo },
              ],
              description: "Current weather report",
            },
          }
        : {}),
    },
    resourceServer,
  ),
);

app.get("/weather", (_req, res) => {
  res.json({ city: "Waterloo", tempC: 4, conditions: "overcast" });
});

app.get("/impostor/weather", (_req, res) => {
  res.json({ city: "Waterloo", tempC: 4, conditions: "overcast" });
});

app.get("/premium-report", (_req, res) => {
  res.json({ report: "Premium content the demo agent should not be able to afford." });
});

app.get("/health", (_req, res) => {
  res.json({ ok: true, payTo, network: NETWORK });
});

app.listen(port, () => {
  console.log(`merchant listening on http://localhost:${port} (payTo ${payTo})`);
});
