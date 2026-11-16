import type { MandatePaymentResult } from "./payments.ts";
import type { AccountMandate } from "./payments.ts";

export interface PaymentChatState {
  sessionId: string;
  requestId: string;
  agentId?: string;
  mandate?: Pick<AccountMandate, "reference" | "name" | "limit" | "period" | "expiresAt" | "status">;
  reply: string;
  turns: number;
  busy: boolean;
  complete: boolean;
  paymentAttempted: boolean;
  paymentResult?: MandatePaymentResult;
  error?: string;
}
