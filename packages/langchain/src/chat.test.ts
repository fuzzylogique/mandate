import assert from "node:assert/strict";
import { test } from "node:test";
import { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { AIMessage, type BaseMessage } from "@langchain/core/messages";
import { createPaymentChats } from "./chat.ts";

class ScriptedModel extends BaseChatModel {
  responses: (AIMessage | Error)[];
  seen: BaseMessage[][] = [];
  constructor(responses: (AIMessage | Error)[]) { super({}); this.responses = responses; }
  _llmType() { return "scripted"; }
  bindTools() { return this; }
  async _generate(messages: BaseMessage[]) {
    this.seen.push(messages);
    const message = this.responses.shift();
    if (message instanceof Error) throw message;
    if (!message) throw new Error("Unexpected model call");
    return { generations: [{ message, text: message.text }] };
  }
}

const details = { mandateId: "mnd_test_secret", sellerId: `C${"A".repeat(55)}`, amount: "0.2", reference: "LangChain payment" };
const paymentCall = (agentId?: string) => new AIMessage({ content: "", tool_calls: [{ id: "pay-001", type: "tool_call", name: "pay_with_mandate", args: { ...details, ...(agentId ? { agentId } : {}) } }] });

test("chat retains clarification history and masks mandate IDs in replies", async () => {
  const model = new ScriptedModel([new AIMessage("Which seller for mnd_test_secret?"), new AIMessage("What amount?")]);
  const chats = createPaymentChats({ model });
  const opened = chats.open();
  assert.notEqual(opened.sessionId, opened.requestId);
  const first = await chats.send(opened.sessionId, "Use mnd_test_secret");
  assert.equal(first.reply, "Which seller for [mandate hidden]?");
  assert.equal(first.complete, false);
  await chats.send(opened.sessionId, "The seller is C…");
  assert.equal(model.seen[1]!.filter(message => message.type === "human").length, 2);
  assert.equal(chats.read(opened.sessionId).turns, 2);
});

test("signed-in chat binds its default identity and displays the actual payment outcome", async t => {
  const model = new ScriptedModel([paymentCall("agt_other"), new AIMessage("Paid!")]);
  const submitted: Record<string, unknown>[] = [];
  t.mock.method(globalThis, "fetch", async (_url: unknown, options: RequestInit) => {
    submitted.push(JSON.parse(options.body as string));
    return Response.json({ status: "pending", reason: "Awaiting confirmation", txHash: "test-tx" });
  });
  const chats = createPaymentChats({ model });
  const opened = chats.open({ agentId: "agt_default" });
  const result = await chats.send(opened.sessionId, "Pay 0.2 USD with mnd_test_secret");
  assert.equal(submitted[0]!.agentId, "agt_default");
  assert.equal(submitted[0]!.requestId, opened.requestId);
  assert.equal(result.reply, "Payment is awaiting confirmation.");
  assert.equal(result.paymentResult?.status, "pending");
  assert.equal(result.complete, true);
  assert.equal(chats.read(opened.sessionId).paymentResult?.status, "pending");
  await assert.rejects(chats.send(opened.sessionId, "Pay again"), { status: 409 });
  assert.equal(submitted.length, 1);
});

test("default identity need not be supplied by the user or model", async t => {
  const model = new ScriptedModel([paymentCall(), new AIMessage("Declined")]);
  let agentId: string | undefined;
  t.mock.method(globalThis, "fetch", async (_url: unknown, options: RequestInit) => {
    agentId = JSON.parse(options.body as string).agentId;
    return Response.json({ status: "declined", reason: "Insufficient funds" });
  });
  const chats = createPaymentChats({ model });
  const opened = chats.open({ agentId: "agt_default" });
  assert.equal((await chats.send(opened.sessionId, "Pay")).paymentResult?.status, "declined");
  assert.equal(agentId, "agt_default");
});

test("the default mandate is bound privately and cannot be overridden by model arguments", async t => {
  const model = new ScriptedModel([paymentCall("agt_other"), new AIMessage("Declined")]);
  let submitted: Record<string, unknown> | undefined;
  t.mock.method(globalThis, "fetch", async (_url: unknown, options: RequestInit) => {
    submitted = JSON.parse(options.body as string);
    return Response.json({ status: "declined", reason: "Insufficient funds" });
  });
  const chats = createPaymentChats({ model });
  const opened = chats.open({ agentId: "agt_default", mandateId: "mnd_private_default" });
  const result = await chats.send(opened.sessionId, "Pay 0.2 USD to seller");
  assert.equal(submitted!.mandateId, "mnd_private_default");
  assert.equal(submitted!.agentId, "agt_default");
  assert.ok(!JSON.stringify(result).includes("mnd_private_default"));
  assert.ok(!model.seen.flat().some(message => message.text.includes("mnd_private_default")));
});

test("payment survives a failed final model reply and uncertain outcomes never resubmit", async t => {
  const model = new ScriptedModel([paymentCall("agt_buyer"), new Error("Provider error mnd_test_secret")]);
  const fetch = t.mock.method(globalThis, "fetch", async () => Response.json({ status: "declined", reason: "Limit exceeded" }));
  const chats = createPaymentChats({ model });
  const opened = chats.open();
  const result = await chats.send(opened.sessionId, "Pay");
  assert.equal(result.reply, "Payment was declined.");
  assert.equal(result.error, undefined);
  assert.equal(fetch.mock.callCount(), 1);

  const uncertainModel = new ScriptedModel([paymentCall("agt_buyer"), new AIMessage("Unknown")]);
  fetch.mock.mockImplementation(async () => { throw new TypeError("Network failed"); });
  const uncertain = createPaymentChats({ model: uncertainModel });
  const next = uncertain.open();
  const outcome = await uncertain.send(next.sessionId, "Pay");
  assert.equal(outcome.complete, true);
  assert.match(outcome.error!, /unconfirmed/);
  assert.equal(outcome.reply, "");
  await assert.rejects(uncertain.send(next.sessionId, "retry"), { status: 409 });
  assert.equal(fetch.mock.callCount(), 2);
});

test("chat rejects concurrent messages, invalid input and expired sessions", async t => {
  const model = new ScriptedModel([new AIMessage("What amount?")]);
  const chats = createPaymentChats({ model });
  const opened = chats.open();
  await assert.rejects(chats.send(opened.sessionId, "  "), { status: 400 });
  await assert.rejects(chats.send(opened.sessionId, "x".repeat(4001)), { status: 400 });
  const response = chats.send(opened.sessionId, "Hello");
  assert.equal(chats.read(opened.sessionId).busy, true);
  await assert.rejects(chats.send(opened.sessionId, "Hello again"), { status: 409 });
  await response;
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  t.mock.timers.tick(60 * 60_000 + 1);
  assert.throws(() => chats.read(opened.sessionId), { status: 404 });
});

test("provider failures return no prompt secrets and missing credentials give setup guidance", async t => {
  const chats = createPaymentChats({ model: new ScriptedModel([new Error("Failure with mnd_test_secret")]) });
  const opened = chats.open();
  const result = await chats.send(opened.sessionId, "Hello");
  assert.equal(result.complete, true);
  assert.match(result.error!, /No payment was submitted/);
  assert.ok(!JSON.stringify(result).includes("mnd_test_secret"));
  const previous = process.env.GEMINI_API_KEY;
  t.after(() => { if (previous === undefined) delete process.env.GEMINI_API_KEY; else process.env.GEMINI_API_KEY = previous; });
  delete process.env.GEMINI_API_KEY;
  assert.throws(() => createPaymentChats().open(), { status: 503, message: /Set GEMINI_API_KEY/ });
});
