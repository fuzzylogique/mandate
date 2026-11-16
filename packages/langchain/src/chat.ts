import { randomUUID } from "node:crypto";
import { HumanMessage, type BaseMessage } from "@langchain/core/messages";
import type { PaymentChatState } from "@mandate/shared";
import { createPaymentAgent, type PaymentAgentOptions } from "./agent.ts";

export class ChatError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

/** Ephemeral chats retain tool history and a single payment request ID on the server. */
export function createPaymentChats(options: PaymentAgentOptions = {}) {
  const sessions = new Map<string, {
    agent: ReturnType<typeof createPaymentAgent>;
    messages: BaseMessage[];
    state: PaymentChatState;
    updated: number;
  }>();
  const prune = () => {
    for (const [id, session] of sessions) {
      if (!session.state.busy && Date.now() - session.updated > 60 * 60_000) sessions.delete(id);
    }
  };
  const get = (id: string) => {
    prune();
    const session = sessions.get(id);
    if (!session) throw new ChatError(404, "This chat has expired or the API restarted. Start a new chat. Keep the original request ID if a payment was attempted.");
    return session;
  };
  return {
    open(identity: Pick<PaymentAgentOptions, "agentId" | "mandateId"> & { mandate?: PaymentChatState["mandate"] } = {}): PaymentChatState {
      prune();
      if (sessions.size >= 100) throw new ChatError(429, "Too many active chats. Try again later.");
      let agent: ReturnType<typeof createPaymentAgent>;
      const { mandate, ...binding } = identity;
      try { agent = createPaymentAgent({ ...options, ...binding }); }
      catch { throw new ChatError(503, "The payment agent is unavailable. Set GEMINI_API_KEY in .env and restart the API."); }
      const sessionId = randomUUID();
      const state: PaymentChatState = {
        sessionId, requestId: agent.requestId, agentId: identity.agentId ?? options.agentId, mandate, reply: "", turns: 0, busy: false, complete: false, paymentAttempted: false,
      };
      sessions.set(sessionId, { agent, messages: [], state, updated: Date.now() });
      return { ...state };
    },
    read(id: string): PaymentChatState { return { ...get(id).state }; },
    async send(id: string, message: unknown): Promise<PaymentChatState> {
      const session = get(id);
      if (typeof message !== "string" || !message.trim() || message.length > 4000) throw new ChatError(400, "Enter a message of 1 to 4,000 characters.");
      if (session.state.busy) throw new ChatError(409, "The agent is still replying. Check the response before sending another message.");
      if (session.state.complete) throw new ChatError(409, "This chat has finished. Start a new chat for another payment.");
      if (session.state.turns >= 40) throw new ChatError(400, "This chat has reached its message limit. Start a new chat.");
      session.state.busy = true;
      session.state.reply = "";
      session.updated = Date.now();
      session.state.turns++;
      session.messages.push(new HumanMessage(message.trim()));
      try {
        const result = await session.agent.agent.invoke({ messages: session.messages }, { recursionLimit: 12 });
        session.messages = [...result.messages];
        session.state.reply = result.messages.at(-1)?.text || "No payment was submitted. Please provide your payment details.";
      } catch {
        // Never return provider errors: they can include prompts and mandate secrets.
        if (!session.agent.paymentResult) {
          session.state.error = session.agent.paymentAttempted
            ? "The payment outcome is unconfirmed. Keep the request ID and the same payment details for any retry."
            : "The agent could not reply. No payment was submitted. Start a new chat to try again.";
          session.state.complete = true;
        }
      } finally {
        session.state.busy = false;
        session.state.paymentAttempted = session.agent.paymentAttempted;
        session.state.paymentResult = session.agent.paymentResult;
        session.state.complete ||= session.agent.paymentAttempted;
        session.state.complete ||= session.state.turns >= 40;
        if (session.agent.paymentResult) {
          const result = session.agent.paymentResult;
          // The payment API, rather than the model's wording, determines the displayed outcome.
          session.state.reply = result.status === "paid" ? "Payment succeeded." : result.status === "pending" ? "Payment is awaiting confirmation." : "Payment was declined.";
        } else if (session.agent.paymentAttempted && !session.state.error) {
          session.state.reply = "";
          session.state.error = "The payment outcome is unconfirmed. Keep the request ID and the same payment details for any retry.";
        }
        session.state.reply = session.state.reply.replace(/mnd_[\w-]+/g, "[mandate hidden]");
        session.updated = Date.now();
      }
      return { ...session.state };
    },
  };
}
