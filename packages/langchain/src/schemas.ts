import { z } from "zod";

export const paymentSchema = z.object({
  amount: z.string().regex(/^\d{1,12}(\.\d{1,7})?$/).refine(value => /[1-9]/.test(value), "Amount must be positive")
    .describe("USD amount as a decimal string, for example 0.10"),
  reference: z.string().trim().min(1).max(200).describe("What the payment is for"),
  requestId: z.string().trim().min(1).max(128)
    .describe("Stable idempotency key. Reuse it for retries of this exact payment, including pending results"),
});
