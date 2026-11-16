// Command-line shopper, for trying the agent API without an assistant.
//
//   pnpm agent connect K7Q4-92XD     connect with the code from Mandate
//   pnpm agent budget                limit, spent, trusted stores
//   pnpm agent find herbs            offers, cheapest first
//   pnpm agent buy greenleaf/herbs   pay, signed with this shopper's key
//
// The key lives in ~/.mandate/agent.json, or MANDATE_AGENT_FILE.
import { MandateAgent } from "./client.ts";

const [command, ...args] = process.argv.slice(2).filter((arg) => arg !== "--");
const agent = new MandateAgent();
const money = (value: string) => `$${Number(value).toFixed(2)}`;

try {
  switch (command) {
    case "connect": {
      const connection = await agent.connect(args[0] ?? "");
      console.log(`Connected as "${connection.name}" for ${connection.ownerName} (rule ${connection.ruleId}, key ${agent.publicKey})`);
      break;
    }
    case "budget": {
      const b = await agent.budget();
      console.log(`${b.name}: ${money(b.remaining)} of ${money(b.limit)} left this ${b.period}. Trusted: ${b.trustedStores.map((s) => s.name).join(", ")}`);
      break;
    }
    case "find": {
      for (const o of await agent.offers(args.join(" "))) {
        console.log(`${o.id.padEnd(22)} ${money(o.price).padStart(8)}  ${o.title} at ${o.store.name}${o.store.trusted ? "" : " (not trusted)"}`);
      }
      break;
    }
    case "buy": {
      const result = await agent.buy(args[0] ?? "", args.slice(1).join(" ") || undefined);
      console.log(result.status === "paid" ? `Paid: ${result.explorerUrl}` : `Blocked: ${result.reason}${result.requestId ? ` (asked the owner, request ${result.requestId})` : ""}`);
      if (result.status === "blocked") process.exitCode = 2;
      break;
    }
    default:
      console.log("Usage: pnpm agent connect <code> | budget | find <words> | buy <offer id> [reason]");
      process.exitCode = 1;
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
