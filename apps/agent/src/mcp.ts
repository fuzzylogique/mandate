// Mandate as an MCP server, so an assistant like Claude can shop for someone
// within the rules they set. Runs locally over stdio and keeps the shopper's
// key in ~/.mandate/agent.json (or MANDATE_AGENT_FILE).
//
//   claude mcp add mandate -- node --experimental-strip-types <repo>/apps/agent/src/mcp.ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { MandateAgent } from "./client.ts";

const agent = new MandateAgent();
const server = new McpServer({ name: "mandate", version: "1.0.0" });

const text = (value: string) => ({ content: [{ type: "text" as const, text: value }] });
const money = (value: string) => `$${Number(value).toFixed(2)}`;
const guard = async (work: () => Promise<string>) => {
  try { return text(await work()); } catch (error) { return { ...text(error instanceof Error ? error.message : String(error)), isError: true }; }
};

server.registerTool("connect_to_mandate", {
  title: "Connect to Mandate",
  description: "Connect this assistant to the user's Mandate account with the one-time code they got when they added you as a shopper. Only needed once.",
  inputSchema: { code: z.string().describe("The code shown in Mandate, like K7Q4-92XD") },
}, ({ code }) => guard(async () => {
  const connection = await agent.connect(code);
  return `Connected as "${connection.name}", shopping for ${connection.ownerName}. Check the budget before buying.`;
}));

server.registerTool("check_budget", {
  title: "Check budget",
  description: "How much this shopper may still spend, until when, and which stores the owner's account trusts. Call before choosing what to buy.",
  inputSchema: {},
  annotations: { readOnlyHint: true },
}, () => guard(async () => {
  const b = await agent.budget();
  const stores = b.trustedStores.map((s) => `${s.name} (${s.domain})`).join(", ") || "none";
  return [
    `Shopper "${b.name}" for ${b.ownerName}: ${b.status}.`,
    `Limit ${money(b.limit)} a ${b.period}; spent ${money(b.spent)}; ${money(b.remaining)} left.`,
    `Valid until ${new Date(b.expiresAt).toDateString()}.`,
    `Trusted stores: ${stores}. Payments to any other store are refused by the account.`,
  ].join("\n");
}));

server.registerTool("find_products", {
  title: "Find products",
  description: "Search every store Mandate knows for something to buy. Returns offers cheapest first, each with its store and whether the owner's account trusts that store. Compare offers before buying; untrusted stores will be refused even if cheaper.",
  inputSchema: { query: z.string().describe("What to look for, e.g. 'herbs' or 'olive oil'") },
  annotations: { readOnlyHint: true },
}, ({ query }) => guard(async () => {
  const offers = await agent.offers(query);
  if (!offers.length) return `Nothing matches "${query}".`;
  return offers.map((o) => `- ${o.id}: ${o.title}, ${money(o.price)} at ${o.store.name} (${o.store.domain}) ${o.store.trusted ? "TRUSTED" : `NOT TRUSTED${o.store.looksLike ? `, looks like ${o.store.looksLike}` : ""}`}`).join("\n");
}));

server.registerTool("buy", {
  title: "Buy",
  description: "Buy one offer by its id from find_products, paying from the owner's account. The account checks this shopper's limit and trusted stores on Stellar and refuses anything outside them; if refused, the owner is asked to decide. Say in `reason` why you chose this offer.",
  inputSchema: {
    offer_id: z.string().describe("Offer id from find_products, like greenleaf/herbs"),
    reason: z.string().max(200).describe("One sentence on why this offer, e.g. 'Cheapest of 2 trusted stores'"),
  },
}, ({ offer_id, reason }) => guard(async () => {
  const result = await agent.buy(offer_id, reason);
  if (result.status === "paid") {
    return `Paid ${money(result.offer.price)} to ${result.offer.store.name} for ${result.offer.title}. Receipt: ${result.explorerUrl}`;
  }
  return `Blocked by the account: ${result.reason}. Nothing was paid.${result.requestId ? ` The owner has been asked to decide (request ${result.requestId}); use check_request to see their answer.` : ""}`;
}));

server.registerTool("check_request", {
  title: "Check a request",
  description: "See whether the owner answered a blocked purchase: allowed it once, raised the limit (buy again), or said no.",
  inputSchema: { request_id: z.string() },
  annotations: { readOnlyHint: true },
}, ({ request_id }) => guard(async () => {
  const r = await agent.request(request_id);
  const answer = {
    pending: "The owner hasn't answered yet.",
    allowed: "The owner paid for it themselves. Nothing more to do.",
    raised: r.txHash ? "The owner raised the limit and it was bought." : "The owner raised the limit. Buy it again now.",
    declined: "The owner said no. Don't buy it.",
    failed: `The owner's decision could not be carried out: ${r.error ?? "unknown error"}.`,
  }[r.status];
  return `${r.offer.title} at ${r.offer.store.name} (${money(r.offer.price)}): ${answer}`;
}));

await server.connect(new StdioServerTransport());
