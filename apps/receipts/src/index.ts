// Dashboard API: everything the owner's dashboard shows and does.
//
// - indexes agent payments from chain into receipts
// - reads balance, mandates and spend from the smart account
// - creates and revokes mandates on the owner's behalf (demo: see chain.ts)
// - sends an agent on a demo purchase and records refusals
import express, { type NextFunction, type Request, type Response } from "express";
import { Keypair } from "@stellar/stellar-sdk";
import { createPayingFetch, settlementTxHash } from "@mandate/agent/purchase";
import {
  toBaseUnits,
  type Activity,
  type CatalogItem,
  type Mandate,
  type MandatePeriod,
  type Overview,
  type PurchaseResult,
  type Receipt,
  type ReceiptAnnotation,
  type Seller,
  type TokenInfo,
} from "@mandate/shared";
import { Chain, PERIOD_LEDGERS } from "./chain.ts";
import { startIndexer } from "./indexer.ts";
import { ReceiptStore } from "./store.ts";

const TESTNET_USDC = "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA";
const TOKEN_SYMBOLS: Record<string, string> = {
  [TESTNET_USDC]: "USDC",
  CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC: "XLM",
};
/** On-chain rule names are capped at 20 bytes. */
const MAX_NAME_BYTES = 20;

const env = process.env;
const port = Number(env.RECEIPTS_PORT ?? 4022);
const rpcUrl = env.RPC_URL ?? "https://soroban-testnet.stellar.org";
const merchantUrl = env.MERCHANT_URL ?? "http://localhost:4021";
const ownerName = env.OWNER_NAME ?? "Maple Analytics";
// The token agents pay in: whatever the demo seller charges, USDC by default.
const tokenId = env.MERCHANT_ASSET || TESTNET_USDC;

const store = new ReceiptStore(env.RECEIPTS_DB ?? "receipts.sqlite");

const tokenInfo = (id: string): TokenInfo => ({
  id,
  symbol: TOKEN_SYMBOLS[id] ?? `${id.slice(0, 4)}…${id.slice(-4)}`,
});

// ---------- chain access (optional: needs deployed contracts) ----------

const chain =
  env.SMART_ACCOUNT_ID &&
  env.ED25519_VERIFIER_ID &&
  env.SPENDING_LIMIT_POLICY_ID &&
  env.VERIFIED_SELLER_POLICY_ID &&
  env.SELLER_REGISTRY_ID &&
  env.OWNER_SECRET
    ? new Chain({
        rpcUrl,
        smartAccount: env.SMART_ACCOUNT_ID,
        verifier: env.ED25519_VERIFIER_ID,
        spendingLimitPolicy: env.SPENDING_LIMIT_POLICY_ID,
        verifiedSellerPolicy: env.VERIFIED_SELLER_POLICY_ID,
        sellerRegistry: env.SELLER_REGISTRY_ID,
        ownerSecret: env.OWNER_SECRET,
      })
    : null;

if (env.VERIFIED_SELLER_POLICY_ID) {
  startIndexer({
    rpcUrl,
    policyContractId: env.VERIFIED_SELLER_POLICY_ID,
    store,
    pollMs: 2000,
    // TODO: send a real email (Resend, Postmark, ...) to the account owner.
    onReceipt: (receipt) => console.log(`[receipt] rule ${receipt.contextRuleId} paid ${receipt.amount} (tx ${receipt.txHash})`),
  });
} else {
  console.warn("[api] VERIFIED_SELLER_POLICY_ID not set: serving stored receipts only");
}

// ---------- demo data ----------

// Display names for sellers. Whether a seller is verified always comes from
// the on-chain registry, never from this table.
if (env.MERCHANT_ADDRESS) {
  store.upsertSeller({ address: env.MERCHANT_ADDRESS, name: "FreshMart", domain: "freshmart.example" });
}
if (env.IMPOSTOR_ADDRESS) {
  // A look-alike store that is NOT in the registry, to show a blocked payment.
  store.upsertSeller({ address: env.IMPOSTOR_ADDRESS, name: "FreshMarrt", domain: "freshmarrt.example" });
}

/** First run: adopt mandates created from the command line. */
async function adoptExistingMandates(): Promise<void> {
  if (!chain || !env.AGENT_SECRET || store.agents().length > 0) return;
  const names = ["Supplies", "Research"];
  for (const [index, name] of names.entries()) {
    const ruleId = index + 1;
    if (await chain.mandate(ruleId)) {
      store.addAgent({ ruleId, name, secret: env.AGENT_SECRET, token: tokenId, createdAt: new Date().toISOString() });
    }
  }
}

// ---------- views ----------

const verifiedCache = new Map<string, { value: boolean; at: number }>();
async function isVerified(address: string): Promise<boolean> {
  if (!chain) return false;
  const cached = verifiedCache.get(address);
  if (cached && Date.now() - cached.at < 30_000) return cached.value;
  const value = await chain.isVerifiedSeller(address).catch(() => false);
  verifiedCache.set(address, { value, at: Date.now() });
  return value;
}

async function sellerView(address: string): Promise<Seller> {
  const known = store.sellers().find((seller) => seller.address === address);
  return {
    address,
    name: known?.name ?? `${address.slice(0, 4)}…${address.slice(-4)}`,
    domain: known?.domain ?? "",
    verified: await isVerified(address),
  };
}

// Records written before the rewording keep their original text in the
// database; they are shown in today's words.
const EARLIER_WORDING: Record<string, string> = {
  "Weather report": "Fresh herbs bundle",
  "Premium market report": "Commercial stand mixer",
  "Seller is not verified": "Not a trusted store",
  "This agent's access was revoked": "This shopper was stopped",
  "Over the daily spending limit": "Over its daily limit",
  "Over the weekly spending limit": "Over its weekly limit",
  "Over the monthly spending limit": "Over its monthly limit",
  "Over the spending limit": "Over its limit",
  "Refused by the account's rules": "Blocked by your account's rules",
  Refused: "Blocked",
};
const EARLIER_NAMES: Record<string, string> = {
  "Procurement bot": "Supplies",
  "Research assistant": "Research",
  "Travel booker": "Travel",
  "Grocery Shopper": "Groceries",
};
const today = (text: string) => EARLIER_WORDING[text] ?? text;
const shopperName = (name: string) => EARLIER_NAMES[name] ?? name;

async function catalog(): Promise<CatalogItem[]> {
  const items: CatalogItem[] = [];
  if (env.MERCHANT_ADDRESS) {
    const seller = await sellerView(env.MERCHANT_ADDRESS);
    items.push(
      { id: "herbs", title: "Fresh herbs bundle", seller, price: "2.4" },
      { id: "mixer", title: "Commercial stand mixer", seller, price: "120" },
    );
  }
  if (env.IMPOSTOR_ADDRESS) {
    items.push({
      id: "lookalike/herbs",
      title: "Fresh herbs bundle",
      seller: await sellerView(env.IMPOSTOR_ADDRESS),
      price: "2.4",
    });
  }
  return items;
}

async function mandateView(ruleId: number): Promise<Mandate | null> {
  const agent = store.agent(ruleId);
  if (!agent || !chain) return null;
  const base = { ruleId, name: shopperName(agent.name), token: tokenInfo(agent.token), createdAt: agent.createdAt };
  const onChain = agent.revokedAt ? null : await chain.mandate(ruleId);
  if (!onChain) {
    if (!agent.revokedAt) store.markRevoked(ruleId, new Date().toISOString());
    return { ...base, status: "revoked", limit: null, spent: "0", period: null };
  }
  return {
    ...base,
    status: "active",
    limit: onChain.limit.toString(),
    spent: onChain.spent.toString(),
    period: onChain.period,
  };
}

async function overview(): Promise<Overview> {
  if (!chain || !env.SMART_ACCOUNT_ID) throw new HttpError(503, "Contracts are not configured in .env");
  const [balance, mandates, items] = await Promise.all([
    chain.balance(tokenId),
    Promise.all(store.agents().map((agent) => mandateView(agent.ruleId))),
    catalog(),
  ]);
  const sellers = await Promise.all(store.sellers().map((seller) => sellerView(seller.address)));
  return {
    owner: { name: ownerName },
    account: { address: env.SMART_ACCOUNT_ID, token: tokenInfo(tokenId), balance: balance.toString() },
    mandates: mandates.filter((mandate): mandate is Mandate => mandate !== null),
    sellers: sellers.filter((seller) => seller.verified),
    catalog: items,
  };
}

async function activity(): Promise<Activity[]> {
  const agentName = (ruleId: number) => shopperName(store.agent(ruleId)?.name ?? `Shopper ${ruleId}`);
  const items = await catalog();
  // Payments made from the command line carry only the URL that was bought.
  const itemFor = (annotation: ReceiptAnnotation | null) =>
    today(
      annotation?.description ??
        items.find((item) => annotation?.resource.endsWith(`/${item.id}`))?.title ??
        "Purchase",
    );
  const paid = await Promise.all(
    store.list(env.SMART_ACCOUNT_ID).map(async (receipt): Promise<Activity> => ({
      id: receipt.id,
      kind: "paid",
      at: receipt.paidAt,
      agent: { ruleId: receipt.contextRuleId, name: agentName(receipt.contextRuleId) },
      seller: await sellerView(receipt.seller),
      item: itemFor(receipt.annotation),
      amount: receipt.amount,
      token: tokenInfo(receipt.token),
      txHash: receipt.txHash,
    })),
  );
  const declined = await Promise.all(
    store.declines().map(async (decline): Promise<Activity> => ({
      id: `declined-${decline.id}`,
      kind: "declined",
      at: decline.at,
      agent: { ruleId: decline.ruleId, name: agentName(decline.ruleId) },
      seller: await sellerView(decline.seller),
      item: today(decline.item),
      amount: decline.amount,
      token: tokenInfo(decline.token),
      reason: today(decline.reason),
    })),
  );
  return [...paid, ...declined].sort((a, b) => b.at.localeCompare(a.at));
}

// ---------- actions ----------

class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function createMandate(body: { name?: string; limit?: string; period?: string }): Promise<Mandate> {
  if (!chain) throw new HttpError(503, "Contracts are not configured in .env");
  const name = body.name?.trim() ?? "";
  if (!name) throw new HttpError(400, "Give your shopper a name");
  if (Buffer.byteLength(name) > MAX_NAME_BYTES) throw new HttpError(400, "Name must be 20 characters or fewer");
  if (!body.limit || !/^\d+(\.\d{1,7})?$/.test(body.limit) || Number(body.limit) <= 0) {
    throw new HttpError(400, "Enter a limit greater than zero");
  }
  const period = body.period as MandatePeriod;
  if (!(period in PERIOD_LEDGERS)) throw new HttpError(400, "Choose a period");

  // The agent gets its own fresh key. It needs no funded account of its own:
  // it only signs, and the facilitator pays network fees.
  const agent = Keypair.random();
  const ruleId = await chain.createMandate({
    name,
    token: tokenId,
    limitBaseUnits: BigInt(toBaseUnits(body.limit)),
    period,
    agent,
  });
  store.addAgent({ ruleId, name, secret: agent.secret(), token: tokenId, createdAt: new Date().toISOString() });
  const mandate = await mandateView(ruleId);
  if (!mandate) throw new HttpError(500, "Your shopper was set up but could not be read back");
  return mandate;
}

/** Why the account said no, in plain words. The chain itself only says "no". */
async function explainRefusal(ruleId: number, item: CatalogItem, amount: bigint): Promise<string> {
  if (!chain) return "Blocked";
  if (!(await chain.isVerifiedSeller(item.seller.address))) return "Not a trusted store";
  const mandate = await chain.mandate(ruleId);
  if (!mandate) return "This shopper was stopped";
  if (mandate.spent + amount > mandate.limit) {
    return mandate.period ? `Over its ${mandate.period === "day" ? "daily" : `${mandate.period}ly`} limit` : "Over its limit";
  }
  const balance = await chain.balance(tokenId).catch(() => null);
  if (balance !== null && balance < amount) return "Not enough money in your account";
  return "Blocked by your account's rules";
}

async function purchase(body: { ruleId?: number; itemId?: string }): Promise<PurchaseResult> {
  if (!chain || !env.SMART_ACCOUNT_ID || !env.ED25519_VERIFIER_ID) {
    throw new HttpError(503, "Contracts are not configured in .env");
  }
  const agent = body.ruleId === undefined ? undefined : store.agent(body.ruleId);
  const item = (await catalog()).find((entry) => entry.id === body.itemId);
  if (!agent || !item) throw new HttpError(400, "Unknown shopper or item");

  const amount = BigInt(toBaseUnits(item.price));
  const payingFetch = createPayingFetch({
    payer: {
      mode: "smart-account",
      agentSecret: agent.secret,
      smartAccount: env.SMART_ACCOUNT_ID,
      contextRuleId: agent.ruleId,
      verifier: env.ED25519_VERIFIER_ID,
    },
    extraAsset: tokenId === TESTNET_USDC ? undefined : tokenId,
  });

  let txHash: string | undefined;
  try {
    const response = await payingFetch(`${merchantUrl}/${item.id}`);
    txHash = response.ok ? settlementTxHash(response) : undefined;
  } catch {
    // The smart account refused to authorize the payment.
  }

  if (txHash) {
    const annotation: ReceiptAnnotation = {
      txHash,
      resource: `${merchantUrl}/${item.id}`,
      description: item.title,
      agentName: agent.name,
      sellerDomain: item.seller.domain,
    };
    store.annotate(annotation);
    return { status: "paid", txHash };
  }

  const reason = await explainRefusal(agent.ruleId, item, amount);
  store.addDecline({
    at: new Date().toISOString(),
    ruleId: agent.ruleId,
    seller: item.seller.address,
    token: tokenId,
    amount: amount.toString(),
    item: item.title,
    reason,
  });
  return { status: "declined", reason };
}

// ---------- HTTP ----------

const app = express();
app.use(express.json());
app.use((req, res, next) => {
  // Dashboard runs on another port in development.
  res.setHeader("access-control-allow-origin", "*");
  res.setHeader("access-control-allow-headers", "content-type");
  res.setHeader("access-control-allow-methods", "GET,POST,DELETE,OPTIONS");
  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }
  next();
});

app.get("/overview", async (_req, res) => {
  res.json(await overview());
});

app.get("/activity", async (_req, res) => {
  res.json(await activity());
});

// TODO: none of the routes below are authenticated. Fine on localhost, not beyond.
app.post("/mandates", async (req, res) => {
  res.status(201).json(await createMandate(req.body ?? {}));
});

app.delete("/mandates/:ruleId", async (req, res) => {
  if (!chain) throw new HttpError(503, "Contracts are not configured in .env");
  const ruleId = Number(req.params.ruleId);
  if (!store.agent(ruleId)) throw new HttpError(404, "Unknown shopper");
  await chain.revokeMandate(ruleId);
  store.markRevoked(ruleId, new Date().toISOString());
  res.status(204).end();
});

app.post("/purchases", async (req, res) => {
  res.json(await purchase(req.body ?? {}));
});

app.get("/receipts", (req, res) => {
  const account = typeof req.query.account === "string" ? req.query.account : undefined;
  res.json(store.list(account) satisfies Receipt[]);
});

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
  res.json({ ok: true, indexing: Boolean(env.VERIFIED_SELLER_POLICY_ID), chain: Boolean(chain) });
});

app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
  const status = error instanceof HttpError ? error.status : 500;
  if (status === 500) console.error("[api]", error);
  res.status(status).json({ error: error instanceof Error ? error.message : "Something went wrong" });
});

await adoptExistingMandates();
app.listen(port, () => {
  console.log(`dashboard API listening on http://localhost:${port}`);
});
