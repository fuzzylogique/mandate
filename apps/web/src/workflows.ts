// What a purchasing workflow is made of: a starting template, the words for
// its budget, and the brief its agent is given.
import type { AccountMandate, PendingMandate, SpendingPeriod, Vendor } from "@mandate/shared";

export interface Template {
  id: string;
  name: string;
  category: string;
  blurb: string;
  limit: string;
  period: SpendingPeriod;
  /** What the agent is asked to do, in one sentence. */
  job: string;
}

export const templates: Template[] = [
  { id: "software", name: "Software renewals", category: "Software", blurb: "Renew seats and licences before they lapse, and add seats for new hires.", limit: "300", period: "month", job: "renew software seats and licences before they lapse, and add seats when someone joins" },
  { id: "supplies", name: "Office supplies", category: "Office supplies", blurb: "Restock paper, labels and toner when they run low.", limit: "200", period: "week", job: "restock office supplies like paper, labels and toner when they run low" },
  { id: "cloud", name: "Cloud and API usage", category: "Cloud and APIs", blurb: "Top up API credits, storage and messaging before they run out.", limit: "150", period: "week", job: "top up API credits, storage and messaging before they run out" },
  { id: "custom", name: "", category: "Other", blurb: "Start from a blank workflow and describe the job yourself.", limit: "", period: "week", job: "buy what the team asks for" },
];

export const periodWords: Record<SpendingPeriod, string> = { day: "24 hours", week: "7 days", month: "30 days" };

/** "Seatwise, Paperline Supply", or the raw IDs when a seller is not in the directory. */
export function vendorNames(sellerIds: number[] | undefined, vendors: Vendor[]): string | undefined {
  if (!sellerIds?.length) return undefined;
  const names = sellerIds.map(id => vendors.find(vendor => vendor.sellerId === id)?.name);
  return names.every(Boolean) ? names.join(", ") : undefined;
}

/** One line for a mandate's sellers, by name when every one is a listed vendor. */
export function sellerLine(mandate: Pick<AccountMandate | PendingMandate, "sellerIds">, vendors: Vendor[]): string {
  if (!mandate.sellerIds?.length) return "Any verified seller";
  return vendorNames(mandate.sellerIds, vendors) ?? `Seller IDs ${mandate.sellerIds.join(", ")}`;
}

/** The instructions the team pastes into its agent, so it starts with the workflow's rules. */
export function agentBrief(input: { workflow: string; job: string; company?: string; team?: string; owner: string; code: string }): string {
  const who = input.team && input.company ? `the ${input.team} team at ${input.company}` : input.company ?? input.owner;
  return [
    `You are the ${input.workflow} agent for ${who}. Your job: ${input.job}.`,
    `First, connect to Mandate with code ${input.code}.`,
    "Every time you buy:",
    "1. Call check_mandates to see your remaining budget and approved vendors.",
    "2. Call find_products and pick the cheapest offer from an approved, verified vendor.",
    "3. Call buy with one sentence on why you chose it.",
    `If a purchase is declined, stop and report it. Do not retry or look for another way to pay. You cannot raise your own budget. Only ${input.owner} can, in Mandate.`,
  ].join("\n");
}

/** The command that adds Mandate to Claude Code, pointed at this deployment. */
export function mcpCommand(origin = window.location.origin): string {
  const local = /^https?:\/\/(localhost|127\.0\.0\.1)(:|$)/.test(origin);
  return `claude mcp add mandate ${local ? "" : `-e MANDATE_API_URL=${origin} `}-- node apps/agent/src/mcp.ts`;
}
