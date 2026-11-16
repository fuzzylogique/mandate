import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

const sellerId = `C${"A".repeat(55)}`;
const details = { agentId: "agt_test_buyer", mandateId: "mnd_cli_test", sellerId, amount: "0.2", reference: "LangChain payment" };
const prompt = `Pay 0.2 USD to seller ${sellerId} using mandate mnd_cli_test and agent identification agt_test_buyer`;
const toolCall = {
  role: "model", parts: [{ functionCall: { name: "pay_with_mandate", args: details } }],
};
const cliUrl = new URL("./agent-cli.ts", import.meta.url).href;

function runCli(args: string[], input: string, responses: unknown[], expectedPayments = 1) {
  const script = `
    import assert from 'node:assert/strict';
    process.argv = ['node', 'agent-cli.ts', ...${JSON.stringify(args)}];
    const responses = ${JSON.stringify(responses)};
    let payments = 0;
    globalThis.fetch = async (url, options) => {
      const request = url instanceof Request ? url : new Request(url, options);
      if (new URL(request.url).hostname === 'payments.example') {
        payments++;
        const body = JSON.parse(options.body);
        assert.deepEqual(body, {
          mandateId: 'mnd_cli_test', agentId: 'agt_test_buyer', sellerAddress: ${JSON.stringify(sellerId)}, sellerName: 'Seller',
          amount: '0.2', reference: 'LangChain payment', requestId: 'cli-agent-001'
        });
        return Response.json({status: 'pending', reason: 'Awaiting confirmation', txHash: 'test-tx'}, {status: 202});
      }
      assert.equal(new URL(request.url).hostname, 'generativelanguage.googleapis.com');
      assert.equal(request.headers.get('x-goog-api-key'), 'test-key');
      const message = responses.shift();
      if (!message) throw new Error('Model unavailable');
      if (message.error) return Response.json({error: message.error}, {status: 503});
      return Response.json({
        candidates: [{index: 0, content: message, finishReason: 'STOP'}],
        usageMetadata: {promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2}
      });
    };
    await import(${JSON.stringify(cliUrl)});
    assert.equal(payments, ${expectedPayments});
  `;
  return spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    encoding: "utf8", input, timeout: 15_000,
    env: {
      ...process.env, GEMINI_API_KEY: "test-key", GEMINI_MODEL: "gemini-test",
      PAYMENTS_API_URL: "https://payments.example", LANGSMITH_TRACING: "false",
    },
  });
}

test("terminal input and clarification replies reach the agent and produce an API result", () => {
  const child = runCli(["--request-id", "cli-agent-001"], `Pay 0.2 USD\n${prompt}\n`, [
    { role: "model", parts: [{ text: "What seller and mandate should I use?" }] },
    toolCall, { role: "model", parts: [{ text: "Pending." }] },
  ]);
  assert.equal(child.status, 0, child.stderr + child.stdout);
  assert.match(child.stdout, /What seller and mandate/);
  assert.match(child.stdout, /"status": "pending"/);
  assert.match(child.stderr, /Payment request ID: cli-agent-001/);
});

test("--prompt works without stdin and preserves the API result if the final model reply fails", () => {
  const child = runCli(["--prompt", prompt, "--request-id", "cli-agent-001"], "", [toolCall]);
  assert.equal(child.status, 0, child.stderr + child.stdout);
  assert.match(child.stdout, /"status": "pending"/);
  assert.match(child.stdout, /test-tx/);
  assert.equal(child.stdout.includes(details.mandateId), false);
});

test("persistent model overload reports no submission and a retry command with the original request ID", () => {
  const unavailable = { error: { code: 503, status: "UNAVAILABLE", message: "This model is currently experiencing high demand." } };
  const child = runCli(["--prompt", prompt, "--request-id", "cli-agent-001"], "", [unavailable, unavailable, unavailable], 0);
  assert.equal(child.status, 1);
  assert.match(child.stderr, /high demand/);
  assert.match(child.stderr, /No payment was submitted/);
  assert.match(child.stderr, /Retry: pnpm agent:langchain --request-id "cli-agent-001"/);
  assert.match(child.stderr, /--model "gemini-3.5-flash-lite"/);
  assert.equal(child.stderr.includes(details.mandateId), false);
});

test("a temporary model overload recovers and submits the payment only once", () => {
  const child = runCli(["--prompt", prompt, "--request-id", "cli-agent-001"], "", [
    { error: { code: 503, status: "UNAVAILABLE", message: "High demand" } },
    toolCall, { role: "model", parts: [{ text: "Pending." }] },
  ]);
  assert.equal(child.status, 0, child.stderr + child.stdout);
  assert.match(child.stdout, /"status": "pending"/);
});
