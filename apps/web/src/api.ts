// Calls to the dashboard API (apps/receipts).
import type { Activity, Mandate, MandatePeriod, Overview, PurchaseResult } from "@mandate/shared";

const API_URL = import.meta.env.VITE_RECEIPTS_URL ?? "http://localhost:4022";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${API_URL}${path}`, {
      ...init,
      headers: init?.body ? { "content-type": "application/json" } : undefined,
    });
  } catch {
    throw new Error("Can't reach the Mandate service. Is it running?");
  }
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `Request failed (${response.status})`);
  }
  return (response.status === 204 ? undefined : await response.json()) as T;
}

export const api = {
  overview: () => request<Overview>("/overview"),
  activity: () => request<Activity[]>("/activity"),
  createAgent: (input: { name: string; limit: string; period: MandatePeriod }) =>
    request<Mandate>("/mandates", { method: "POST", body: JSON.stringify(input) }),
  revokeAgent: (ruleId: number) => request<void>(`/mandates/${ruleId}`, { method: "DELETE" }),
  purchase: (ruleId: number, itemId: string) =>
    request<PurchaseResult>("/purchases", { method: "POST", body: JSON.stringify({ ruleId, itemId }) }),
};
