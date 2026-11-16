import type { AccountOpening, FundingMethod, MandateCreation, CreateAccountMandateInput, Customer, MandatePaymentInput, MandatePaymentPreview, MandatePaymentResult, OpenAccountInput, PaymentEntry, PaymentNetwork, PaymentWorkspace, SpendingAccount } from "@mandate/shared";

export class ApiError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
async function request<T>(path: string, method = "GET", body?: unknown): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`/api${path}`, { method, credentials: path === "/pay" || path === "/pay/preview" ? "omit" : "same-origin", headers: { ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
  } catch { throw new Error("Can't reach the Mandate service. Start pnpm dev:receipts and try again."); }
  if (!response.ok) {
    const result = await response.json().catch(() => null) as { error?: string } | null;
    throw new ApiError(response.status, result?.error ?? `Request failed (${response.status})`);
  }
  return (response.status === 204 ? undefined : await response.json()) as T;
}
export const api = {
  workspace: () => request<PaymentWorkspace>("/workspace"),
  network: () => request<{ mode: PaymentWorkspace["mode"]; network?: PaymentNetwork }>("/network"),
  register: (input: { name: string; email: string; password: string }) => request<Customer>("/auth/register", "POST", input),
  login: (input: { email: string; password: string }) => request<Customer>("/auth/login", "POST", input),
  logout: () => request<void>("/auth/logout", "POST"),
  openAccount: (input: OpenAccountInput) => request<AccountOpening>("/accounts/open", "POST", input),
  fund: (id: string, amount: string, requestId: string, method: FundingMethod) => request<PaymentEntry>(`/accounts/${id}/funding`, "POST", { amount, requestId, method }),
  createMandate: (input: CreateAccountMandateInput) => request<MandateCreation>("/mandates", "POST", input),
  revealMandate: (reference: string) => request<{ mandateId: string }>(`/mandates/${encodeURIComponent(reference)}/reveal`, "POST"),
  revoke: (id: string) => request<void>(`/mandates/${id}`, "DELETE"),
  pay: (input: { accountId: string; mandateReference?: string; amount: string; destination: string; reference: string; requestId: string }) => request<PaymentEntry>("/payments", "POST", input),
  previewMandatePayment: (input: MandatePaymentInput) => request<MandatePaymentPreview>("/pay/preview", "POST", input),
  payWithMandate: (input: MandatePaymentInput) => request<MandatePaymentResult>("/pay", "POST", input),
};
