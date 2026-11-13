// Buyer agent: requests a paid URL and pays for it over x402.
//
//   PAYER_MODE=classic        pay from an ordinary G-address key (baseline,
//                             known to work; no mandate is enforced)
//   PAYER_MODE=smart-account  pay from the mandate smart account, signed by
//                             the agent's key under its context rule
//
// Usage: pnpm agent -- http://localhost:4021/weather
import type { ReceiptAnnotation } from "@mandate/shared";
import { requireEnv } from "@mandate/shared/env";
import { createPayingFetch, settlementTxHash, type Payer } from "./purchase.ts";

const url = process.argv.slice(2).find((arg) => arg.startsWith("http"));
if (!url) {
  console.error("Usage: pnpm agent -- <url>");
  process.exit(1);
}

const mode = process.env.PAYER_MODE ?? "classic";
const agentSecret = requireEnv("AGENT_SECRET");
const payer: Payer =
  mode === "smart-account"
    ? {
        mode: "smart-account",
        agentSecret,
        smartAccount: requireEnv("SMART_ACCOUNT_ID"),
        contextRuleId: Number(requireEnv("AGENT_CONTEXT_RULE_ID")),
        verifier: requireEnv("ED25519_VERIFIER_ID"),
      }
    : { mode: "classic", agentSecret };
const payingFetch = createPayingFetch({ payer, extraAsset: process.env.AGENT_EXTRA_ASSET || undefined });

console.log(`[agent] ${mode} payer requesting ${url}`);
let response: Response;
try {
  response = await payingFetch(url);
} catch (error) {
  // In smart-account mode, a payment that breaks the mandate fails here: the
  // account refuses to authorize it, so no payment is ever sent.
  const message = error instanceof Error ? error.message : String(error);
  console.log(`[agent] could not pay: ${message.split("\n")[0]}`);
  process.exit(2);
}
console.log(`[agent] status ${response.status}`);
console.log(await response.text());

// The seller echoes the settled transaction in a response header.
const txHash = settlementTxHash(response);
if (txHash) {
  console.log(`[agent] paid, transaction ${txHash}`);

  // Tell the receipt service what this payment was for. The chain only knows
  // who paid whom and how much.
  const receiptsUrl = process.env.RECEIPTS_URL;
  if (receiptsUrl) {
    const annotation: ReceiptAnnotation = {
      txHash,
      resource: url,
      agentName: process.env.AGENT_NAME ?? "demo-agent",
      sellerDomain: new URL(url).host,
    };
    await fetch(`${receiptsUrl}/annotations`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(annotation),
    }).catch((error) => console.warn("[agent] could not reach receipt service:", error));
  }
}
