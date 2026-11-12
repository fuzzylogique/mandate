// Buyer agent: requests a paid URL and pays for it over x402.
//
//   PAYER_MODE=classic        pay from an ordinary G-address key (baseline,
//                             known to work; no mandate is enforced)
//   PAYER_MODE=smart-account  pay from the mandate smart account, signed by
//                             the agent's key under its context rule
//
// Usage: pnpm agent -- http://localhost:4021/weather
import { Keypair } from "@stellar/stellar-sdk";
import { decodePaymentResponseHeader, wrapFetchWithPaymentFromConfig } from "@x402/fetch";
import { createEd25519Signer } from "@x402/stellar";
import { ExactStellarScheme } from "@x402/stellar/exact/client";
import { NETWORK, type ReceiptAnnotation } from "@mandate/shared";
import { requireEnv } from "@mandate/shared/env";
import { SmartAccountExactStellarScheme } from "./smart-account-scheme.ts";

const url = process.argv.slice(2).find((arg) => arg.startsWith("http"));
if (!url) {
  console.error("Usage: pnpm agent -- <url>");
  process.exit(1);
}

const mode = process.env.PAYER_MODE ?? "classic";
const agentSecret = requireEnv("AGENT_SECRET");

const scheme =
  mode === "smart-account"
    ? new SmartAccountExactStellarScheme({
        smartAccount: requireEnv("SMART_ACCOUNT_ID"),
        contextRuleId: Number(requireEnv("AGENT_CONTEXT_RULE_ID")),
        verifier: requireEnv("ED25519_VERIFIER_ID"),
        agentKeypair: Keypair.fromSecret(agentSecret),
      })
    : new ExactStellarScheme(createEd25519Signer(agentSecret, NETWORK));

// The x402 client only pays in USDC unless told otherwise. AGENT_EXTRA_ASSET
// allows one more token (C-address), e.g. testnet XLM for testing.
const extraAsset = process.env.AGENT_EXTRA_ASSET;
const payingFetch = wrapFetchWithPaymentFromConfig(fetch, {
  schemes: [{ network: "stellar:*", client: scheme }],
  ...(extraAsset ? { spendControls: { allowedAssets: [{ network: NETWORK, asset: extraAsset }] } } : {}),
});

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

// The seller echoes settlement details (tx hash, payer) in a response header.
const settlementHeader =
  response.headers.get("PAYMENT-RESPONSE") ?? response.headers.get("X-PAYMENT-RESPONSE");
if (settlementHeader) {
  const settlement = decodePaymentResponseHeader(settlementHeader);
  console.log("[agent] settlement", settlement);

  // Tell the receipt service what this payment was for. The chain only knows
  // who paid whom and how much.
  const receiptsUrl = process.env.RECEIPTS_URL;
  if (receiptsUrl && settlement.transaction) {
    const annotation: ReceiptAnnotation = {
      txHash: settlement.transaction,
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
