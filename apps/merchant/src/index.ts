// Demo sellers: three services that take payment over x402, so agents have
// something to compare. They stand in for the data, compute and API providers
// a builder's agents buy from.
// This is a fixture for the demo, not part of the product.
//
//   GET /catalog            free: every store and what it sells
//   GET /<store>/<item>     paid: x402, settles to that store's own address
//
// Atlas Data and Forge Compute are Mandate accounts, so their smart accounts
// are verified sellers (`pnpm setup:stores` creates them). Atlass Data is a
// look-alike whose address is not verified, and it undercuts both on price.
import express from "express";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { paymentMiddleware, x402ResourceServer } from "@x402/express";
import { ExactStellarScheme } from "@x402/stellar/exact/server";
import { NETWORK, toBaseUnits } from "@mandate/shared";

const port = Number(process.env.MERCHANT_PORT ?? 4021);
const facilitatorUrl = process.env.FACILITATOR_URL ?? "http://localhost:4023";
// Mandate's demo USD token contract. Without it, prices are in USDC.
const asset = process.env.MERCHANT_ASSET;

interface Item { id: string; title: string; price: string }
interface StoreConfig { slug: string; name: string; domain: string; payTo?: string; looksLike?: string; items: Item[] }

const stores: StoreConfig[] = [
  {
    slug: "atlas",
    name: "Atlas Data",
    domain: "atlasdata.example",
    payTo: process.env.STORE_ATLAS_ADDRESS,
    items: [
      { id: "lookup", title: "Company lookup, 100 records", price: "2.40" },
      { id: "search", title: "Web search, 1,000 queries", price: "3.20" },
      { id: "news", title: "News feed, 1 month", price: "9.50" },
      { id: "export", title: "Full dataset export", price: "120.00" },
    ],
  },
  {
    slug: "forge",
    name: "Forge Compute",
    domain: "forgecompute.example",
    payTo: process.env.STORE_FORGE_ADDRESS,
    items: [
      { id: "gpu-hour", title: "GPU hour", price: "2.10" },
      { id: "transcribe", title: "Transcription, 60 minutes", price: "3.60" },
      { id: "embeddings", title: "Embeddings, 10M tokens", price: "8.75" },
      { id: "credits", title: "Model API credits", price: "14.00" },
    ],
  },
  {
    slug: "atlass",
    name: "Atlass Data",
    domain: "atlassdata.example",
    payTo: process.env.STORE_LOOKALIKE_ADDRESS,
    looksLike: "Atlas Data",
    items: [
      { id: "lookup", title: "Company lookup, 100 records", price: "1.20" },
      { id: "search", title: "Web search, 1,000 queries", price: "1.50" },
      { id: "news", title: "News feed, 1 month", price: "4.00" },
    ],
  },
];
const open = stores.filter((store): store is StoreConfig & { payTo: string } => Boolean(store.payTo));

const price = (dollars: string) => (asset ? { amount: toBaseUnits(dollars), asset } : `$${dollars}`);

type Routes = Parameters<typeof paymentMiddleware>[0];
const routes: Routes = {};
for (const store of open) {
  for (const item of store.items) {
    routes[`GET /${store.slug}/${item.id}`] = {
      accepts: [{ scheme: "exact", price: price(item.price), network: NETWORK, payTo: store.payTo }],
      description: `${item.title} from ${store.name}`,
    };
  }
}

// `pnpm dev` starts everything at once. The x402 middleware asks the
// facilitator what it supports as soon as it is created, so wait for it first.
for (let attempt = 0; attempt < 30; attempt++) {
  const up = await fetch(`${facilitatorUrl}/supported`).then((response) => response.ok, () => false);
  if (up) break;
  await new Promise((resolve) => setTimeout(resolve, 500));
}

const resourceServer = new x402ResourceServer(
  new HTTPFacilitatorClient({ url: facilitatorUrl }),
).register(NETWORK, new ExactStellarScheme());

const app = express();

// Free: the catalog shoppers compare.
app.get("/catalog", (req, res) => {
  // STORES_URL is the public address when hosted, where the proxy hides the real scheme and port.
  const base = process.env.STORES_URL?.replace(/\/$/, "") || `${req.protocol}://${req.get("host")}`;
  res.json({
    stores: open.map((store) => ({
      slug: store.slug,
      name: store.name,
      domain: store.domain,
      payTo: store.payTo,
      looksLike: store.looksLike,
      items: store.items.map((item) => ({ ...item, url: `${base}/${store.slug}/${item.id}` })),
    })),
  });
});

app.get("/health", (_req, res) => {
  res.json({ ok: true, network: NETWORK, stores: open.map((store) => store.slug) });
});

app.use(paymentMiddleware(routes, resourceServer));

for (const store of open) {
  for (const item of store.items) {
    app.get(`/${store.slug}/${item.id}`, (_req, res) => {
      res.json({ order: "confirmed", store: store.name, item: item.title, price: item.price, delivery: "Added to your API key" });
    });
  }
}

if (!open.length) console.warn("No store addresses in .env. Run pnpm setup:stores.");
// MERCHANT_HOST=0.0.0.0 exposes the stores when hosted; the default keeps them on this machine.
app.listen(port, process.env.MERCHANT_HOST || "127.0.0.1", () => {
  console.log(`demo stores on http://localhost:${port}: ${open.map((store) => store.name).join(", ")}`);
});
