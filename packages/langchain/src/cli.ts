import { randomUUID } from "node:crypto";
import { parseArgs } from "node:util";
import { createPayTool } from "./index.ts";

function required(name: string, flag?: string, argument?: string): string {
  const value = (argument ?? process.env[name])?.trim();
  if (!value) throw new Error(`${flag ? `Pass --${flag} or set` : "Set"} ${name} before running the payment example.`);
  return value;
}

try {
  const { values } = parseArgs({
    options: {
      "agent-id": { type: "string" },
      "mandate-id": { type: "string" },
      "seller-id": { type: "string" },
      amount: { type: "string" },
      reference: { type: "string" },
      "request-id": { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help) {
    console.log("Usage: pnpm pay:langchain --mandate-id <id> --agent-id <identification> --seller-id <C-address> --amount <USD>");
    console.log("Flags override MANDATE_ID, AGENT_ID, SELLER_ID and PAYMENT_AMOUNT in .env.");
    console.log('Optional: --reference <text> (default: "LangChain payment"), --request-id <id> (default: generated UUID).');
    console.log("These override PAYMENT_REFERENCE and PAYMENT_REQUEST_ID in .env.");
    console.log("The request ID is printed before submission. Reuse it with --request-id and the same payment details for retries.");
  } else {
    const pay = createPayTool({
      agentId: required("AGENT_ID", "agent-id", values["agent-id"]),
      mandateId: required("MANDATE_ID", "mandate-id", values["mandate-id"]),
      sellerId: required("SELLER_ID", "seller-id", values["seller-id"]),
      apiUrl: process.env.PAYMENTS_API_URL,
    });
    const requestId = values["request-id"]?.trim() || process.env.PAYMENT_REQUEST_ID?.trim() || randomUUID();
    const reference = values.reference?.trim() || process.env.PAYMENT_REFERENCE?.trim() || "LangChain payment";
    console.error(`Payment request ID: ${requestId}. For retries, pass --request-id "${requestId}" with the same payment details.`);
    const result = await pay.invoke({
      amount: required("PAYMENT_AMOUNT", "amount", values.amount),
      reference,
      requestId,
    });
    console.log(JSON.stringify(result, null, 2));
    if (result.status === "declined") process.exitCode = 1;
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : "Payment request failed");
  process.exitCode = 1;
}
