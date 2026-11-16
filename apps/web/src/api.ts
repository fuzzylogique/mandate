// Calls to the Mandate API. Same origin: Vite proxies /api to the service, so
// the session cookie travels with every request.
import type {
  Account,
  Activity,
  ApprovalDecision,
  ApprovalRequest,
  Customer,
  NewShopperInput,
  Offer,
  Overview,
  PurchaseOutcome,
  Shopper,
} from "@mandate/shared/api";

export class SignedOut extends Error {}

async function request<T>(path: string, init?: { method?: string; body?: unknown }): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`/api${path}`, {
      method: init?.method ?? (init?.body === undefined ? "GET" : "POST"),
      credentials: "same-origin",
      headers: init?.body === undefined ? undefined : { "content-type": "application/json" },
      body: init?.body === undefined ? undefined : JSON.stringify(init.body),
    });
  } catch {
    throw new Error("Can't reach Mandate. Is the service running?");
  }
  if (response.status === 401) {
    const body = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new SignedOut(body?.error ?? "Please sign in");
  }
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `Something went wrong (${response.status})`);
  }
  return (response.status === 204 ? undefined : await response.json()) as T;
}

export const api = {
  me: () => request<Customer>("/me"),
  register: (body: { name: string; email: string; password: string }) => request<Customer>("/auth/register", { body }),
  login: (body: { email: string; password: string }) => request<Customer>("/auth/login", { body }),
  logout: () => request<void>("/auth/logout", { method: "POST", body: {} }),

  overview: () => request<Overview>("/overview"),
  activity: () => request<Activity[]>("/activity"),
  openAccount: () => request<Account>("/account", { method: "POST", body: {} }),
  addMoney: (amount: string, requestId: string) => request<Account>("/account/money", { body: { amount, requestId } }),

  createShopper: (input: NewShopperInput) => request<Shopper>("/shoppers", { body: input }),
  stopShopper: (id: string) => request<void>(`/shoppers/${id}`, { method: "DELETE" }),
  run: (id: string, test?: "lookalike" | "over-limit") => request<PurchaseOutcome>(`/shoppers/${id}/run`, { body: test ? { test } : {} }),
  newCode: (id: string) => request<Shopper>(`/shoppers/${id}/pairing`, { body: {} }),
  decide: (id: string, decision: ApprovalDecision) => request<ApprovalRequest>(`/requests/${id}`, { body: { decision } }),

  sharedOffers: (id: string, query?: string) => request<Offer[]>(`/shared/${id}/offers${query ? `?q=${encodeURIComponent(query)}` : ""}`),
  sharedPay: (id: string, offerId: string, requestId: string) => request<PurchaseOutcome>(`/shared/${id}/pay`, { body: { offerId, requestId } }),
};
