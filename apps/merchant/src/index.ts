// Demo stores: three shops that take payment over x402, so agents have
// something to compare. They stand in for anywhere an agent might buy from.
// This is a fixture for the demo, not part of the product.
//
//   GET /catalog            free: every store and what it sells
//   GET /<store>/<item>     paid: x402, settles to that store's own address
//
// FreshMart and GreenLeaf are Mandate accounts, so their smart accounts are
// verified sellers (`pnpm setup:stores` creates them). FreshMarrt is a
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
    slug: "freshmart",
    name: "FreshMart",
    domain: "freshmart.example",
    payTo: process.env.STORE_FRESHMART_ADDRESS,
    items: [
      { id: "herbs", title: "Fresh herbs bundle", price: "2.40" },
      { id: "basil", title: "Basil, 4 bunches", price: "3.20" },
      { id: "olive-oil", title: "Olive oil, 1 L", price: "9.50" },
      { id: "mixer", title: "Commercial stand mixer", price: "120.00" },
    ],
  },
  {
    slug: "greenleaf",
    name: "GreenLeaf Market",
    domain: "greenleaf.example",
    payTo: process.env.STORE_GREENLEAF_ADDRESS,
    items: [
      { id: "herbs", title: "Fresh herbs bundle", price: "2.10" },
      { id: "basil", title: "Basil, 4 bunches", price: "3.60" },
      { id: "olive-oil", title: "Olive oil, 1 L", price: "8.75" },
      { id: "napkins", title: "Linen napkins, 12", price: "14.00" },
    ],
  },
  {
    slug: "freshmarrt",
    name: "FreshMarrt",
    domain: "freshmarrt.example",
    payTo: process.env.STORE_LOOKALIKE_ADDRESS,
    looksLike: "FreshMart",
    items: [
      { id: "herbs", title: "Fresh herbs bundle", price: "1.20" },
      { id: "basil", title: "Basil, 4 bunches", price: "1.50" },
      { id: "olive-oil", title: "Olive oil, 1 L", price: "4.00" },
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
  const base = `${req.protocol}://${req.get("host")}`;
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
      res.json({ order: "confirmed", store: store.name, item: item.title, price: item.price, delivery: "Tomorrow, 8 am" });
    });
  }
}

if (!open.length) console.warn("No store addresses in .env. Run pnpm setup:stores.");
app.listen(port, "127.0.0.1", () => {
  console.log(`demo stores on http://localhost:${port}: ${open.map((store) => store.name).join(", ")}`);
});
