// The same abilities as the MCP server, as LangChain tools. The agent's key
// stays in its key file; models only ever see sellers, amounts and results.
import { randomUUID } from "node:crypto";
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { MandateAgent } from "./client.ts";
import { describeMandates, describePayment, describeProducts } from "./describe.ts";

export function createMandateTools(agent = new MandateAgent()) {
  const mandate = z.string().optional().describe("Mandate name or reference, if there is more than one");
  return [
    tool(async () => describeMandates(await agent.mandates()), {
      name: "check_mandates",
      description: "What the owner lets this agent spend: remaining limit, period, expiry and allowed sellers for each mandate.",
      schema: z.object({}),
    }),
    tool(async ({ address }) => {
      const seller = await agent.checkSeller(address);
      return seller.verified ? `Verified seller${seller.sellerId ? ` #${seller.sellerId}` : ""}.` : "Not a verified seller. A mandate cannot pay it.";
    }, {
      name: "check_seller",
      description: "Whether a Stellar address is a verified seller.",
      schema: z.object({ address: z.string() }),
    }),
    tool(async ({ seller, amount, reference, mandate, requestId }) => describePayment(await agent.pay({ seller, amount, reference, ...(mandate ? { mandate } : {}), requestId: requestId ?? randomUUID() })), {
      name: "pay_seller",
      description: "Pay a verified seller in USD under a mandate, signed with this agent's own key. Refused on chain if over the limit or the seller is not allowed. Reuse requestId to retry.",
      schema: z.object({ seller: z.string(), amount: z.string().regex(/^\d+(\.\d{1,7})?$/), reference: z.string().max(200), mandate, requestId: z.string().max(100).optional() }),
    }),
    tool(async ({ query }) => describeProducts(await agent.products(query), query), {
      name: "find_products",
      description: "Search the x402 stores; cheapest first, with whether each store is a verified seller.",
      schema: z.object({ query: z.string() }),
    }),
    tool(async ({ url, reason, mandate }) => describePayment(await agent.buy(url, { reference: reason, ...(mandate ? { mandate } : {}) })), {
      name: "buy",
      description: "Buy a product by its URL from find_products, paying over x402 with this agent's own key.",
      schema: z.object({ url: z.string().url(), reason: z.string().max(200), mandate }),
    }),
  ];
}
