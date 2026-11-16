import { stdin, stdout } from "node:process";
import { createInterface } from "node:readline";
import { parseArgs } from "node:util";
import { HumanMessage, type BaseMessage } from "@langchain/core/messages";
import { createPaymentAgent, DEFAULT_AGENT_MODEL } from "./agent.ts";

async function main() {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      prompt: { type: "string" },
      model: { type: "string" },
      "request-id": { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help) {
    console.log('Usage: pnpm agent:langchain [--prompt "Pay ..."] [--model <name>] [--request-id <id>]');
    console.log(`Set GEMINI_API_KEY in .env. GEMINI_MODEL defaults to ${DEFAULT_AGENT_MODEL}.`);
    console.log("Without --prompt, type your payment request at the prompt. Type exit to quit.");
    console.log("Reuse the printed request ID and the same payment details to retry a pending or uncertain payment.");
    return;
  }

  const session = createPaymentAgent({ modelName: values.model, requestId: values["request-id"] });
  console.log(`Model: ${values.model?.trim() || process.env.GEMINI_MODEL?.trim() || DEFAULT_AGENT_MODEL}`);
  console.error(`Payment request ID: ${session.requestId}. Reuse with --request-id "${session.requestId}" for retries.`);
  const terminal = createInterface({ input: stdin, output: stdout });
  const lines = terminal[Symbol.asyncIterator]();
  let messages: BaseMessage[] = [];
  let prompt = values.prompt?.trim();
  try {
    while (true) {
      if (!prompt) {
        if (stdin.isTTY) stdout.write("You: ");
        const line = await lines.next();
        if (line.done) break;
        prompt = line.value.trim();
      }
      if (/^(exit|quit)$/i.test(prompt)) break;
      if (!prompt) continue;
      messages = [...messages, new HumanMessage(prompt)];
      try {
        const response = await session.agent.invoke({ messages }, { recursionLimit: 12 });
        messages = [...response.messages];
        if (!session.paymentResult && !session.paymentAttempted) {
          console.log(`Agent: ${response.messages.at(-1)?.text ?? "No payment was submitted."}`);
        }
      } catch (error) {
        // A payment may have completed even if the model's final reply failed.
        if (!session.paymentResult) {
          const reason = error instanceof Error ? error.message : "Payment agent failed";
          const outcome = session.paymentAttempted
            ? "Payment outcome is unconfirmed. Keep the same payment details when retrying."
            : "No payment was submitted. Enter the same payment prompt when retrying.";
          throw new Error(`${reason}\n${outcome}\nRetry: pnpm agent:langchain --request-id "${session.requestId}"\nIf Gemini remains busy, add --model "gemini-3.5-flash-lite" or set GEMINI_MODEL in .env.`);
        }
      }
      if (session.paymentResult) {
        console.log(JSON.stringify(session.paymentResult, null, 2));
        if (session.paymentResult.status === "declined") process.exitCode = 1;
        return;
      }
      if (session.paymentAttempted) {
        throw new Error(`Payment outcome is unconfirmed. Retry with --request-id "${session.requestId}" and the same payment details.`);
      }
      prompt = undefined;
    }
    console.log("No payment was submitted.");
  } finally {
    terminal.close();
  }
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : "Payment agent failed");
  process.exitCode = 1;
}
