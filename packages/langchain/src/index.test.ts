import assert from "node:assert/strict";
import { test } from "node:test";
import type { MandatePaymentResult } from "@mandate/shared";
import { createPayTool } from "./index.ts";

const mandateId = "mnd_test_secret";
const sellerId = `C${"A".repeat(55)}`;
const input = { amount: "0.10", reference: "Example purchase", requestId: "purchase-001" };
const paid: MandatePaymentResult = {
  status: "paid",
  payment: {
    id: "payment-001", accountId: "buyer", source: "source", destination: sellerId,
    kind: "payment", amount: "0.1000000", currency: "USD", mandateReference: "public-reference",
    reference: input.reference, createdAt: "2026-11-15T00:00:00.000Z",
    settlement: "stellar-testnet", txHash: "confirmed-tx",
  },
};

test("maps configured IDs to the public pay endpoint without exposing the mandate in the tool schema", async t => {
  const calls: unknown[] = [];
  t.mock.method(globalThis, "fetch", async (url: URL, options: RequestInit) => {
    calls.push({ url: url.href, options });
    return Response.json(paid);
  });
  const pay = createPayTool({ mandateId, sellerId, apiUrl: "https://payments.example" });
  assert.equal("mandateId" in pay.schema.shape, false);
  assert.equal(JSON.stringify(pay.schema).includes(mandateId), false);
  assert.deepEqual(await pay.invoke(input), paid);
  assert.deepEqual(calls, [{
    url: "https://payments.example/api/pay",
    options: {
      method: "POST", headers: { "content-type": "application/json" },
      credentials: "omit", redirect: "error",
      body: JSON.stringify({ mandateId, sellerAddress: sellerId, sellerName: "Seller", ...input }),
    },
  }]);
});

test("preserves pending and declined results and reuses the supplied request ID on retry", async t => {
  const pending = { status: "pending", reason: "Awaiting confirmation", txHash: "pending-tx" };
  const declined = { status: "declined", reason: "Mandate revoked" };
  const responses = [Response.json(pending, { status: 202 }), Response.json(paid), Response.json(declined)];
  const bodies: string[] = [];
  t.mock.method(globalThis, "fetch", async (_url: URL, options: RequestInit) => {
    bodies.push(options.body as string);
    return responses.shift()!;
  });
  const pay = createPayTool({ mandateId, sellerId });
  assert.deepEqual(await pay.invoke(input), pending);
  assert.deepEqual(await pay.invoke(input), paid);
  assert.deepEqual(bodies[0], bodies[1]);
  assert.deepEqual(await pay.invoke({ ...input, requestId: "purchase-002" }), declined);
});

test("reports HTTP failures without retrying or echoing the response body", async t => {
  const fetch = t.mock.method(globalThis, "fetch", async () => Response.json({ error: mandateId }, { status: 429 }));
  const pay = createPayTool({ mandateId, sellerId });
  await assert.rejects(pay.invoke(input), error => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /HTTP 429/);
    assert.equal(error.message.includes(mandateId), false);
    return true;
  });
  assert.equal(fetch.mock.callCount(), 1);
});

test("does not automatically resubmit after a network failure", async t => {
  const fetch = t.mock.method(globalThis, "fetch", async () => { throw new TypeError("fetch failed"); });
  await assert.rejects(createPayTool({ mandateId, sellerId }).invoke(input), /fetch failed/);
  assert.equal(fetch.mock.callCount(), 1);
});

test("rejects invalid amounts and missing payment details before sending a request", async t => {
  const fetch = t.mock.method(globalThis, "fetch", async () => { throw new Error("Unexpected request"); });
  const pay = createPayTool({ mandateId, sellerId });
  for (const amount of ["0", "0.0000000", "-1", "1.00000001", "1e2", "1000000000000"]) {
    await assert.rejects(pay.invoke({ ...input, amount }));
  }
  await assert.rejects(pay.invoke({ ...input, requestId: "" }));
  await assert.rejects(pay.invoke({ ...input, reference: " " }));
  assert.equal(fetch.mock.callCount(), 0);
});

test("requires a mandate ID and a Smart Account seller address", () => {
  assert.throws(() => createPayTool({ mandateId: "", sellerId }));
  assert.throws(() => createPayTool({ mandateId, sellerId: `G${"A".repeat(55)}` }));
});
