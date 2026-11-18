// An x402 facilitator for Stellar that settles payments made from smart
// accounts with policies. It verifies an agent's signed payment, submits it to
// Stellar and pays the network fee. Anyone can run it, and Mandate's instance
// is open on testnet (see README.md in this folder).
//
// Stock x402 facilitators reject a payment from a smart account that runs
// policies, for two reasons found by testing on testnet:
//  1. Fee ceiling. `@x402/stellar` sponsors at most 50,000 stroops (0.005 XLM)
//     by default. A mandate payment runs a signature verifier and two policies
//     on chain and costs about 0.05 XLM.
//  2. Event check. They require the payment to emit exactly one contract
//     event, the token transfer. Policies emit events of their own: here the
//     spending limit update, PaymentAuthorized from the verified-seller policy
//     and AgentAuthorized from the agent verifier.
// This facilitator keeps the stock verification and changes only those two
// things: a higher ceiling, and events from an allow-list of policy contracts
// are ignored. The single-transfer check still applies to everything else.
// docs/upstream has the same change as a patch for `@x402/stellar` itself.
import express, { type NextFunction, type Request, type Response } from "express";
import { Address, StrKey, xdr } from "@stellar/stellar-sdk";
import { x402Facilitator } from "@x402/core/facilitator";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import { createEd25519Signer } from "@x402/stellar";
import { ExactStellarScheme } from "@x402/stellar/exact/facilitator";
import { NETWORK } from "@mandate/shared";

const requireEnv = (name: string) => {
  const value = process.env[name];
  if (!value) throw new Error(`Set ${name} in .env. Run pnpm setup:stores.`);
  return value;
};
const port = Number(process.env.FACILITATOR_PORT ?? 4023);
// FACILITATOR_HOST=0.0.0.0 opens it to other machines; the default keeps it on this one.
const host = process.env.FACILITATOR_HOST || "127.0.0.1";
// Classic account that submits settlements and pays their fees.
const signer = createEd25519Signer(requireEnv("FACILITATOR_SECRET"), NETWORK);
// 0.3 XLM. Observed smart-account payments cost roughly 0.05 XLM.
const maxTransactionFeeStroops = Number(process.env.FACILITATOR_MAX_FEE_STROOPS ?? 3_000_000);

// Contracts whose events are ignored by the single-transfer check. By default
// Mandate's three: set FACILITATOR_ALLOWED_EVENT_CONTRACTS (comma-separated
// C-addresses) to run this for another smart account's policies.
const policyContracts = new Set(
  process.env.FACILITATOR_ALLOWED_EVENT_CONTRACTS
    ? process.env.FACILITATOR_ALLOWED_EVENT_CONTRACTS.split(",").map((id) => id.trim()).filter(Boolean)
    : [requireEnv("SPENDING_LIMIT_POLICY_ID"), requireEnv("PAYMENTS_VERIFIED_SMART_POLICY_ID"), requireEnv("AGENT_VERIFIER_ID")],
);
for (const id of policyContracts) {
  if (!StrKey.isValidContract(id)) throw new Error(`${id} is not a contract address (C…)`);
}

function isPolicyEvent(diagnosticEvent: xdr.DiagnosticEvent): boolean {
  const contractId = diagnosticEvent.event().contractId();
  if (!contractId) return false;
  const emitter = Address.fromScAddress(xdr.ScAddress.scAddressTypeContract(contractId)).toString();
  return policyContracts.has(emitter);
}

type ValidateEvents = (events: xdr.DiagnosticEvent[], ...rest: unknown[]) => unknown;

/**
 * Stock scheme, except events emitted by the mandate policies are dropped
 * before the "exactly one transfer event" check.
 *
 * `validateSimulationEvents` is private in @x402/stellar, so this reaches past
 * the type system. The package is pinned to an exact version for that reason;
 * re-check this override when upgrading it.
 */
class MandateStellarScheme extends ExactStellarScheme {
  constructor(...args: ConstructorParameters<typeof ExactStellarScheme>) {
    super(...args);
    const self = this as unknown as { validateSimulationEvents: ValidateEvents };
    const stock = self.validateSimulationEvents.bind(this);
    self.validateSimulationEvents = (events, ...rest) =>
      stock(events.filter((event) => !isPolicyEvent(event)), ...rest);
  }
}

const facilitator = new x402Facilitator().register(
  NETWORK,
  new MandateStellarScheme([signer], { maxTransactionFeeStroops }),
);

interface PaymentRequest {
  paymentPayload: PaymentPayload;
  paymentRequirements: PaymentRequirements;
}

// This instance pays the fee for every payment it settles, so an open one is
// limited: per caller, and in total per hour.
const perMinute = Number(process.env.FACILITATOR_REQUESTS_PER_MINUTE ?? 30);
const settlesPerHour = Number(process.env.FACILITATOR_SETTLES_PER_HOUR ?? 300);
const callers = new Map<string, { count: number; reset: number }>();
let settles = { count: 0, reset: Date.now() + 3_600_000 };
function limit(req: Request, res: Response, next: NextFunction) {
  const now = Date.now();
  for (const [key, entry] of callers) if (entry.reset <= now) callers.delete(key);
  // Behind Fly's proxy the caller's address is in Fly-Client-IP.
  const caller = req.get("fly-client-ip") ?? req.ip ?? "local";
  const entry = callers.get(caller) ?? { count: 0, reset: now + 60_000 };
  entry.count++;
  callers.set(caller, entry);
  if (entry.count > perMinute) {
    res.status(429).json({ error: "Too many requests. Try again in a minute." });
    return;
  }
  if (req.path === "/settle") {
    if (settles.reset <= now) settles = { count: 0, reset: now + 3_600_000 };
    if (++settles.count > settlesPerHour) {
      res.status(429).json({ error: "This facilitator has sponsored its hourly limit of payments. Try again later." });
      return;
    }
  }
  next();
}

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "1mb" }));

app.get("/", (_req, res) => {
  res.json({
    name: "Mandate x402 facilitator",
    about: "x402 on Stellar testnet for smart accounts with policies. Stock verification, a higher fee ceiling, and events from the listed policy contracts ignored.",
    network: NETWORK,
    maxTransactionFeeStroops,
    allowedEventContracts: [...policyContracts],
    limits: { requestsPerMinute: perMinute, settlesPerHour },
    source: "https://github.com/fuzzylogique/mandate/tree/main/apps/facilitator",
  });
});

app.get("/supported", (_req, res) => {
  res.json(facilitator.getSupported());
});

app.post("/verify", limit, async (req, res) => {
  const { paymentPayload, paymentRequirements } = req.body as PaymentRequest;
  const result = await facilitator.verify(paymentPayload, paymentRequirements);
  if (!result.isValid) console.log("[facilitator] verify rejected:", result);
  res.json(result);
});

app.post("/settle", limit, async (req, res) => {
  const { paymentPayload, paymentRequirements } = req.body as PaymentRequest;
  const result = await facilitator.settle(paymentPayload, paymentRequirements);
  console.log("[facilitator] settle:", result);
  res.json(result);
});

app.listen(port, host, () => {
  console.log(`facilitator listening on http://localhost:${port}${host === "127.0.0.1" ? "" : ` (open on ${host})`} (fee payer ${signer.address})`);
});
