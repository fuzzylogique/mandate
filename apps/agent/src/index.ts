// Command-line agent, for trying Mandate without an assistant.
//
//   pnpm agent connect K7Q4-92XD                      connect with the code from Mandate
//   pnpm agent mandates                               what it may spend
//   pnpm agent seller C…                              is this a verified seller?
//   pnpm agent pay C… 2.50 "Invoice 1042"             pay a seller directly
//   pnpm agent find gpu                               x402 products, cheapest first
//   pnpm agent buy http://localhost:4021/…            buy one over x402
//
// The key lives in ~/.mandate/agent.json, or MANDATE_AGENT_FILE.
import { randomUUID } from "node:crypto";
import { MandateAgent } from "./client.ts";
import { describeMandates, describePayment, describeProducts } from "./describe.ts";

const [command, ...args] = process.argv.slice(2).filter((arg) => arg !== "--");
const agent = new MandateAgent();

try {
  switch (command) {
    case "connect": {
      const connection = await agent.connect(args[0] ?? "");
      console.log(`Connected as "${connection.name}" for ${connection.ownerName} (agent ${connection.agentId}, key ${agent.publicKey})`);
      break;
    }
    case "mandates": console.log(describeMandates(await agent.mandates())); break;
    case "seller": console.log(JSON.stringify(await agent.checkSeller(args[0] ?? ""), null, 2)); break;
    case "pay": {
      const result = await agent.pay({ seller: args[0] ?? "", amount: args[1] ?? "", reference: args[2] ?? "Payment", requestId: args[3] ?? randomUUID(), ...(process.env.MANDATE ? { mandate: process.env.MANDATE } : {}) });
      console.log(describePayment(result));
      if (result.status === "declined") process.exitCode = 2;
      break;
    }
    case "find": console.log(describeProducts(await agent.products(args.join(" ")), args.join(" "))); break;
    case "buy": {
      const result = await agent.buy(args[0] ?? "", { reference: args.slice(1).join(" ") || undefined, ...(process.env.MANDATE ? { mandate: process.env.MANDATE } : {}) });
      console.log(describePayment(result));
      if (result.status === "declined") process.exitCode = 2;
      break;
    }
    default:
      console.log("Usage: pnpm agent connect <code> | mandates | seller <address> | pay <seller> <amount> [reference] | find <words> | buy <url> [reason]");
      process.exitCode = 1;
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
