// Our own x402 facilitator: verifies an agent's signed payment and submits it
// to Stellar, paying the network fee.
//
// Hosted facilitators reject payments from a mandate smart account for two
// reasons, both found by testing against testnet:
//  1. Fee ceiling. They sponsor at most 50,000 stroops (0.005 XLM). A mandate
//     payment runs the signature verifier and both policies on-chain and costs
//     about 0.05 XLM.
//  2. Event check. They require the payment to emit exactly one contract
//     event, the token transfer. Our policies also emit events (the spending
//     limit update, and PaymentAuthorized, which receipts are built from).
// This facilitator keeps the stock verification and changes only those two
// things: a higher ceiling, and events from the two known policy contracts are
// ignored. The single-transfer check still applies to everything else.
import express from "express";
import { Address, xdr } from "@stellar/stellar-sdk";
import { x402Facilitator } from "@x402/core/facilitator";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import { createEd25519Signer } from "@x402/stellar";
import { ExactStellarScheme } from "@x402/stellar/exact/facilitator";
import { NETWORK } from "@mandate/shared";
import { requireEnv } from "@mandate/shared/env";

const port = Number(process.env.FACILITATOR_PORT ?? 4023);
// Classic account that submits settlements and pays their fees.
const signer = createEd25519Signer(requireEnv("FACILITATOR_SECRET"), NETWORK);
// 0.3 XLM. Observed smart-account payments cost roughly 0.05 XLM.
const maxTransactionFeeStroops = Number(process.env.FACILITATOR_MAX_FEE_STROOPS ?? 3_000_000);

const policyContracts = new Set([
  requireEnv("SPENDING_LIMIT_POLICY_ID"),
  requireEnv("VERIFIED_SELLER_POLICY_ID"),
]);

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

const app = express();
app.use(express.json({ limit: "1mb" }));

app.get("/supported", (_req, res) => {
  res.json(facilitator.getSupported());
});

app.post("/verify", async (req, res) => {
  const { paymentPayload, paymentRequirements } = req.body as PaymentRequest;
  const result = await facilitator.verify(paymentPayload, paymentRequirements);
  if (!result.isValid) console.log("[facilitator] verify rejected:", result);
  res.json(result);
});

app.post("/settle", async (req, res) => {
  const { paymentPayload, paymentRequirements } = req.body as PaymentRequest;
  const result = await facilitator.settle(paymentPayload, paymentRequirements);
  console.log("[facilitator] settle:", result);
  res.json(result);
});

app.listen(port, () => {
  console.log(`facilitator listening on http://localhost:${port} (fee payer ${signer.address})`);
});
