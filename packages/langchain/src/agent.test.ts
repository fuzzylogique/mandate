import assert from "node:assert/strict";
import { test } from "node:test";
import { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { AIMessage, HumanMessage, type BaseMessage } from "@langchain/core/messages";
import { createPaymentAgent, DEFAULT_AGENT_MODEL } from "./agent.ts";

const details = { agentId: "agt_test_buyer", mandateId: "mnd_test_secret", sellerId: `C${"A".repeat(55)}`, amount: "0.2", reference: "LangChain payment" };
const prompt = `Pay ${details.amount} USD to seller ${details.sellerId} using mandate ${details.mandateId} and agent identification ${details.agentId}`;
const pending = { status: "pending", reason: "Awaiting confirmation", txHash: "test-tx" };

class ScriptedModel extends BaseChatModel {
  responses: AIMessage[];
  seen: BaseMessage[][] = [];
  constructor(responses: AIMessage[]) { super({}); this.responses = responses; }
  _llmType() { return "scripted"; }
  bindTools() { return this; }
  async _generate(messages: BaseMessage[]) {
    this.seen.push(messages);
    const message = this.responses.shift();
    if (!message) throw new Error("Unexpected model call");
    return { generations: [{ message, text: message.text }] };
  }
}

function callPayment(id = "call-001", input = details) {
  return new AIMessage({ content: "", tool_calls: [{ id, name: "pay_with_mandate", args: input, type: "tool_call" }] });
}

test("agent executes a model tool call against /api/pay and preserves the API result", async t => {
  const model = new ScriptedModel([callPayment(), new AIMessage("Payment is pending.")]);
  const bodies: unknown[] = [];
  t.mock.method(globalThis, "fetch", async (url: URL, options: RequestInit) => {
    assert.equal(url.href, "https://payments.example/api/pay");
    bodies.push(JSON.parse(options.body as string));
    return Response.json(pending, { status: 202 });
  });
  const session = createPaymentAgent({ model, requestId: "agent-001", apiUrl: "https://payments.example" });
  const state = await session.agent.invoke({ messages: [new HumanMessage(prompt)] });
  assert.equal(state.messages.at(-1)?.text, "Payment is pending.");
  assert.ok(model.seen[0]!.some(message => message.text === prompt));
  assert.deepEqual(bodies, [{
    mandateId: details.mandateId, agentId: details.agentId, sellerAddress: details.sellerId, sellerName: "Seller",
    amount: details.amount, reference: details.reference, requestId: "agent-001",
  }]);
  assert.deepEqual(session.paymentResult, pending);
});

test("clarification turns retain conversation and do not submit until the model calls the tool", async t => {
  const model = new ScriptedModel([new AIMessage("What seller should I pay?"), callPayment(), new AIMessage("Pending.")]);
  const fetch = t.mock.method(globalThis, "fetch", async () => Response.json(pending));
  const session = createPaymentAgent({ model, requestId: "agent-clarification" });
  const first = await session.agent.invoke({ messages: [new HumanMessage("Pay 0.2 USD")] });
  assert.equal(fetch.mock.callCount(), 0);
  assert.equal(session.paymentAttempted, false);
  assert.equal(session.paymentResult, undefined);
  await session.agent.invoke({ messages: [...first.messages, new HumanMessage(prompt)] });
  assert.equal(fetch.mock.callCount(), 1);
  assert.equal(model.seen[1]!.filter(message => message.type === "human").length, 2);
});

test("repeated and parallel model tool calls submit only one payment", async t => {
  const calls = [callPayment("call-001").tool_calls![0]!, callPayment("call-002").tool_calls![0]!];
  const model = new ScriptedModel([new AIMessage({ content: "", tool_calls: calls }), callPayment("call-003"), new AIMessage("Pending.")]);
  const fetch = t.mock.method(globalThis, "fetch", async () => Response.json(pending));
  const session = createPaymentAgent({ model });
  await session.agent.invoke({ messages: [new HumanMessage(prompt)] });
  assert.equal(fetch.mock.callCount(), 1);
  assert.deepEqual(session.paymentResult, pending);
});

test("a model cannot change payment details after the first attempt", async t => {
  const model = new ScriptedModel([
    callPayment(), callPayment("changed", { ...details, amount: "10" }), new AIMessage("Pending."),
  ]);
  const fetch = t.mock.method(globalThis, "fetch", async () => Response.json(pending));
  const session = createPaymentAgent({ model });
  const state = await session.agent.invoke({ messages: [new HumanMessage(prompt)] });
  assert.equal(fetch.mock.callCount(), 1);
  assert.ok(state.messages.some(message => message.type === "tool" && message.text.includes("already attempted")));
});

test("network failures are not automatically resubmitted even if the model retries", async t => {
  const model = new ScriptedModel([callPayment(), callPayment("retry"), new AIMessage("Outcome unknown.")]);
  const fetch = t.mock.method(globalThis, "fetch", async () => { throw new TypeError("fetch failed"); });
  const session = createPaymentAgent({ model });
  await session.agent.invoke({ messages: [new HumanMessage(prompt)] });
  assert.equal(fetch.mock.callCount(), 1);
  assert.equal(session.paymentAttempted, true);
  assert.equal(session.paymentResult, undefined);
});

test("invalid model payment arguments never reach the payment API", async t => {
  const model = new ScriptedModel([callPayment("bad-amount", { ...details, amount: "0" }), new AIMessage("Please give a positive amount.")]);
  const fetch = t.mock.method(globalThis, "fetch", async () => { throw new Error("Unexpected request"); });
  const session = createPaymentAgent({ model });
  await session.agent.invoke({ messages: [new HumanMessage(prompt)] });
  assert.equal(fetch.mock.callCount(), 0);
});

test("Gemini model configuration is sent to the provider and a missing API key fails clearly", async t => {
  const previousKey = process.env.GEMINI_API_KEY;
  const previousModel = process.env.GEMINI_MODEL;
  t.after(() => {
    if (previousKey === undefined) delete process.env.GEMINI_API_KEY; else process.env.GEMINI_API_KEY = previousKey;
    if (previousModel === undefined) delete process.env.GEMINI_MODEL; else process.env.GEMINI_MODEL = previousModel;
  });
  delete process.env.GEMINI_API_KEY;
  assert.throws(() => createPaymentAgent(), /Set GEMINI_API_KEY/);
  process.env.GEMINI_API_KEY = "test-key";
  delete process.env.GEMINI_MODEL;
  const models: unknown[] = [];
  t.mock.method(globalThis, "fetch", async (request: Request) => {
    const url = new URL(request.url);
    assert.equal(url.hostname, "generativelanguage.googleapis.com");
    assert.equal(request.headers.get("x-goog-api-key"), "test-key");
    models.push(url.pathname.match(/\/models\/([^:]+):/)?.[1]);
    return Response.json({
      candidates: [{ index: 0, content: { role: "model", parts: [{ text: "What amount should I pay?" }] }, finishReason: "STOP" }],
      usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 },
    });
  });
  await createPaymentAgent().agent.invoke({ messages: [new HumanMessage("Hello")] });
  process.env.GEMINI_MODEL = "gemini-environment-model";
  await createPaymentAgent().agent.invoke({ messages: [new HumanMessage("Hello")] });
  await createPaymentAgent({ modelName: "gemini-configured-model" }).agent.invoke({ messages: [new HumanMessage("Hello")] });
  assert.deepEqual(models, [DEFAULT_AGENT_MODEL, "gemini-environment-model", "gemini-configured-model"]);
});
