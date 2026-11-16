import { randomUUID } from "node:crypto";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { tool } from "@langchain/core/tools";
import { ChatGoogle } from "@langchain/google/node";
import type { MandatePaymentResult } from "@mandate/shared";
import { createAgent } from "langchain";
import { z } from "zod";
import { createPayTool } from "./index.ts";
import { paymentSchema } from "./schemas.ts";

export const DEFAULT_AGENT_MODEL = "gemini-3.8-flash";

export interface PaymentAgentOptions {
  modelName?: string;
  /** Optional model instance for embedding or testing without Gemini. */
  model?: BaseChatModel;
  apiUrl?: string;
  requestId?: string;
  /** A trusted account identity supplied by the host for signed-in chats. */
  agentId?: string;
  /** Optional default mandate bound by the host, kept outside model prompts. */
  mandateId?: string;
}

/** One payment session, including any clarification messages before submission. */
export function createPaymentAgent(options: PaymentAgentOptions = {}) {
  const requestId = z.string().trim().min(1).max(128).parse(options.requestId ?? randomUUID());
  let model = options.model;
  if (!model) {
    const apiKey = process.env.GEMINI_API_KEY?.trim();
    if (!apiKey) throw new Error("Set GEMINI_API_KEY in .env before running the payment agent.");
    model = new ChatGoogle({
      apiKey,
      model: options.modelName?.trim() || process.env.GEMINI_MODEL?.trim() || DEFAULT_AGENT_MODEL,
      // Retry only model requests. Payment submissions are cached separately below.
      maxRetries: 2,
    });
  }

  let attempt: { fingerprint: string; result: Promise<MandatePaymentResult> } | undefined;
  let paymentResult: MandatePaymentResult | undefined;
  const pay = tool(async ({ mandateId: suppliedMandateId, agentId: suppliedAgentId, sellerId, amount, reference }) => {
    const mandateId = options.mandateId ?? suppliedMandateId;
    if (!mandateId) throw new Error("Mandate ID is required.");
    const agentId = options.agentId ?? suppliedAgentId;
    if (!agentId) throw new Error("Agent identification is required.");
    const input = { amount, reference, requestId };
    const fingerprint = JSON.stringify({ mandateId, agentId, sellerId, ...input });
    if (attempt) {
      if (attempt.fingerprint !== fingerprint) {
        throw new Error("This session has already attempted a payment. Keep the same details for retries; start a new session for a different payment.");
      }
      return attempt.result;
    }
    const boundPay = createPayTool({ mandateId, agentId, sellerId, apiUrl: options.apiUrl ?? process.env.PAYMENTS_API_URL });
    attempt = { fingerprint, result: boundPay.invoke(input) };
    paymentResult = await attempt.result;
    return paymentResult;
  }, {
    name: "pay_with_mandate",
    description: "Submit one USD payment using the mandate ID, agent identification, seller Smart Account C address and amount supplied by the user. Returns the payment API's paid, declined or pending result.",
    schema: paymentSchema.omit({ requestId: true }).extend({
      mandateId: options.mandateId
        ? z.string().optional().describe("The application supplies the default mandate; this field can be omitted")
        : z.string().trim().min(1).max(128).describe("Exact secret mandate ID from the user's prompt"),
      agentId: options.agentId
        ? z.string().optional().describe("The application supplies the registered chat agent identity; this field can be omitted")
        : z.string().trim().min(1).max(128).describe("Exact on-chain registered agent identification from the user’s prompt"),
      sellerId: z.string().trim().regex(/^C[A-Z2-7]{55}$/).describe("Exact seller Smart Account C address from the user's prompt"),
    }),
  });

  const agent = createAgent({
    model,
    tools: [pay],
    systemPrompt: `You help the user make a single USD payment on Stellar testnet.
Extract the exact mandate ID, agent identification, seller Smart Account C address, and decimal USD amount from the conversation.
${options.agentId ? `The application has assigned your registered agent identification: ${options.agentId}. Use this identity for every payment. Do not ask the user for agent identification or use a different one.` : "Ask the user for their registered agent identification if missing."}
${options.mandateId ? "The application supplies a default mandate with a 1 USD rolling daily limit. Do not ask the user for a mandate ID. Omit this field from tool calls; the application supplies it privately." : "Ask the user for the secret mandate ID if missing."}
If a required detail is missing or ambiguous, ask for it before calling the payment tool. Never invent IDs or an amount.
The user's payment request authorizes calling the tool. Only call it when the user asks to make a payment.
Use the user's payment reference if supplied; otherwise use "LangChain payment".
The application supplies a fixed request ID. Make at most one payment and stop after the tool returns a result or an error.
Report only the tool's actual outcome. Pending is not paid. Do not retry automatically or change payment details after an attempt.
Never repeat the secret mandate ID in your replies.`,
  });

  return {
    agent,
    requestId,
    get paymentResult() { return paymentResult; },
    get paymentAttempted() { return attempt !== undefined; },
  };
}
