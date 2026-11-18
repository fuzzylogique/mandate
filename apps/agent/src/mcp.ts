// Mandate as an MCP server, so an assistant like Claude can buy for a team
// within the budget and vendors its owner set. Runs locally over stdio and keeps the agent's key
// in ~/.mandate/agent.json (or MANDATE_AGENT_FILE). The key never leaves it.
//
//   claude mcp add mandate -- node <repo>/apps/agent/src/mcp.ts
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { MandateAgent } from "./client.ts";
import { describeMandates, describePayment, describeProducts } from "./describe.ts";

const agent = new MandateAgent();
const server = new McpServer({ name: "mandate", version: "1.0.0" });

const text = (value: string) => ({ content: [{ type: "text" as const, text: value }] });
const guard = async (work: () => Promise<string>) => {
  try { return text(await work()); } catch (error) { return { ...text(error instanceof Error ? error.message : String(error)), isError: true }; }
};
const mandate = z.string().optional().describe("Mandate name or reference, if the owner gave you more than one");

server.registerTool("connect_to_mandate", {
  title: "Connect to Mandate",
  description: "Connect this assistant to the user's Mandate account with the one-time code they got when they added you as an agent. Only needed once. Your key stays on this computer.",
  inputSchema: { code: z.string().describe("The code shown in Mandate, like K7Q4-92XD") },
}, ({ code }) => guard(async () => {
  const connection = await agent.connect(code);
  return `Connected as "${connection.name}" for ${connection.ownerName}${connection.company ? ` at ${connection.company}` : ""}. Check your mandates before buying.`;
}));

server.registerTool("check_mandates", {
  title: "Check mandates",
  description: "What the owner lets you spend: each mandate's remaining limit, period, expiry and which sellers it can pay. Call before choosing what to buy.",
  inputSchema: {},
  annotations: { readOnlyHint: true },
}, () => guard(async () => describeMandates(await agent.mandates())));

server.registerTool("check_seller", {
  title: "Check a seller",
  description: "Whether a Stellar address is a verified seller. Mandates only pay verified sellers; the owner's account refuses anyone else on chain.",
  inputSchema: { address: z.string().describe("The seller's Stellar address (C…)") },
  annotations: { readOnlyHint: true },
}, ({ address }) => guard(async () => {
  const seller = await agent.checkSeller(address);
  return seller.verified ? `Verified seller${seller.name ? ` (${seller.name}` : ""}${seller.sellerId ? `, seller ID ${seller.sellerId})` : seller.name ? ")" : ""}.` : "Not a verified seller. A mandate cannot pay this address.";
}));

server.registerTool("pay_seller", {
  title: "Pay a seller",
  description: "Pay a verified seller from the owner's account under a mandate, signed with your own key. The account checks your limit and the seller on Stellar and refuses anything outside them; nobody can raise the limit for you. To retry after an error, reuse the same request_id so it is not paid twice.",
  inputSchema: {
    seller: z.string().describe("The seller's Stellar address (C…)"),
    amount: z.string().regex(/^\d+(\.\d{1,7})?$/).describe("USD amount, like 2.50"),
    reference: z.string().max(200).describe("What this pays for, like 'Invoice 1042'"),
    mandate,
    request_id: z.string().max(100).optional().describe("Reuse to retry the same payment"),
  },
}, ({ seller, amount, reference, mandate, request_id }) => guard(async () =>
  describePayment(await agent.pay({ seller, amount, reference, ...(mandate ? { mandate } : {}), requestId: request_id ?? randomUUID() }))));

server.registerTool("find_products", {
  title: "Find products",
  description: "Search the vendors that sell over x402 for something to buy. Returns offers cheapest first, each with its vendor and whether it is a verified seller. Unverified vendors are refused by the owner's account even if cheaper.",
  inputSchema: { query: z.string().describe("What to look for, like 'copy paper' or 'project tracker seat'") },
  annotations: { readOnlyHint: true },
}, ({ query }) => guard(async () => describeProducts(await agent.products(query), query)));

server.registerTool("buy", {
  title: "Buy over x402",
  description: "Buy one product by its URL from find_products, paying the vendor over x402 from the owner's account, signed with your own key. The account checks your limit and the vendor on Stellar. If it is declined, the owner sees the attempt; do not retry another way. Say in `reason` why you chose it.",
  inputSchema: {
    url: z.string().url().describe("Product URL from find_products"),
    reason: z.string().max(200).describe("One sentence on what this is for, like 'Weekly paper restock, cheapest verified vendor'"),
    mandate,
  },
}, ({ url, reason, mandate }) => guard(async () => describePayment(await agent.buy(url, { reference: reason, ...(mandate ? { mandate } : {}) }))));

await server.connect(new StdioServerTransport());
