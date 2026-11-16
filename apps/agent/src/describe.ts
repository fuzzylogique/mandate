// Plain-language answers shared by the MCP server, LangChain tools and CLI.
import type { AgentMandate } from "@mandate/shared";
import type { PayResult, StoreItem } from "./client.ts";

export const money = (value: string) => `$${Number(value).toFixed(2)}`;
const per = { day: "24 hours", week: "7 days", month: "30 days" } as const;

export function describeMandates(mandates: AgentMandate[]): string {
  if (!mandates.length) return "The owner has not given this agent a mandate yet. Nothing can be paid.";
  return mandates.map((m) => [
    `- ${m.name} (${m.reference}): ${m.status}.`,
    `  ${money(m.remaining)} left of ${money(m.limit)} per ${per[m.period]}; spent ${money(m.spent)}. Expires ${new Date(m.expiresAt).toDateString()}.`,
    `  Sellers: ${m.sellerIds?.length ? `only seller IDs ${m.sellerIds.join(", ")}` : "any verified seller"}.`,
  ].join("\n")).join("\n");
}

export function describeProducts(items: StoreItem[], query: string): string {
  if (!items.length) return `Nothing matches "${query}".`;
  return items.map((item) => `- ${item.url}: ${item.title}, ${money(item.price)} at ${item.store.name} (${item.store.domain}), ${item.store.verified ? `verified seller${item.store.sellerId ? ` #${item.store.sellerId}` : ""}` : "NOT a verified seller: the account will refuse it"}`).join("\n");
}

export function describePayment(result: PayResult): string {
  if (result.status === "declined") return `Declined: ${result.reason}. Nothing was paid.`;
  const { payment } = result;
  return `Paid ${money(payment.amount)} to ${payment.destination} (${payment.reference}). Receipt: ${payment.explorerUrl ?? payment.txHash}`;
}
