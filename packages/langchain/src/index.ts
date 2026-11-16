import { tool } from "@langchain/core/tools";
import type { MandatePaymentInput, MandatePaymentResult } from "@mandate/shared";
import { z } from "zod";

const paymentSchema = z.object({
  amount: z.string().regex(/^\d{1,12}(\.\d{1,7})?$/).refine(value => /[1-9]/.test(value), "Amount must be positive")
    .describe("USD amount as a decimal string, for example 0.10"),
  reference: z.string().trim().min(1).max(200).describe("What the payment is for"),
  requestId: z.string().trim().min(1).max(128)
    .describe("Stable idempotency key. Reuse it for retries of this exact payment, including pending results"),
});

export interface PayToolOptions {
  /** Secret mandate ID, bound outside the tool input so it is not sent to a model. */
  mandateId: string;
  /** Seller's verified Smart Account C address. */
  sellerId: string;
  /** Payments service origin, without /api/pay. */
  apiUrl?: string;
}

export function createPayTool({ mandateId, sellerId, apiUrl = "http://localhost:4022" }: PayToolOptions) {
  const secret = z.string().trim().min(1).max(128).parse(mandateId);
  const sellerAddress = z.string().trim().regex(/^C[A-Z2-7]{55}$/, "Seller ID must be a Smart Account C address").parse(sellerId);
  const endpoint = new URL("/api/pay", apiUrl);

  return tool(async ({ amount, reference, requestId }): Promise<MandatePaymentResult> => {
    const body: MandatePaymentInput = {
      mandateId: secret, sellerAddress, sellerName: "Seller", amount, reference, requestId,
    };
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      credentials: "omit",
      redirect: "error",
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      throw new Error(`Pay endpoint returned HTTP ${response.status}. Retry with the same requestId.`);
    }
    return await response.json() as MandatePaymentResult;
  }, {
    name: "pay_with_mandate",
    description: "Pay the configured verified seller in USD using the configured mandate. Returns paid, declined, or pending. Retry pending or uncertain requests with the same requestId and payment details.",
    schema: paymentSchema,
  });
}
