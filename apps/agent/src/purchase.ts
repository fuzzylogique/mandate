// Builds a `fetch` that pays x402 sellers on the agent's behalf.
import { Keypair } from "@stellar/stellar-sdk";
import { decodePaymentResponseHeader, wrapFetchWithPaymentFromConfig } from "@x402/fetch";
import { createEd25519Signer } from "@x402/stellar";
import { ExactStellarScheme } from "@x402/stellar/exact/client";
import { NETWORK } from "@mandate/shared";
import { SmartAccountExactStellarScheme } from "./smart-account-scheme.ts";

export type Payer =
  /** Pay from the agent's own classic account. No mandate is involved. */
  | { mode: "classic"; agentSecret: string }
  /** Pay from the owner's smart account, under the agent's mandate, signed as the agent. */
  | {
      mode: "smart-account";
      agentSecret: string;
      agentId: string;
      smartAccount: string;
      contextRuleId: number;
      verifier: string;
    };

export interface PayingFetchOptions {
  payer: Payer;
  /**
   * The x402 client only pays in USDC unless told otherwise. This allows one
   * more token (C-address), e.g. testnet XLM for testing.
   */
  extraAsset?: string;
}

export function createPayingFetch({ payer, extraAsset }: PayingFetchOptions): typeof fetch {
  const scheme =
    payer.mode === "smart-account"
      ? new SmartAccountExactStellarScheme({
          smartAccount: payer.smartAccount,
          contextRuleId: payer.contextRuleId,
          verifier: payer.verifier,
          agentId: payer.agentId,
          agentKeypair: Keypair.fromSecret(payer.agentSecret),
        })
      : new ExactStellarScheme(createEd25519Signer(payer.agentSecret, NETWORK));

  return wrapFetchWithPaymentFromConfig(fetch, {
    schemes: [{ network: "stellar:*", client: scheme }],
    ...(extraAsset
      ? { spendControls: { allowedAssets: [{ network: NETWORK, asset: extraAsset }] } }
      : {}),
  });
}

/** Transaction hash of the settled payment, if the seller reported one. */
export function settlementTxHash(response: Response): string | undefined {
  const header =
    response.headers.get("PAYMENT-RESPONSE") ?? response.headers.get("X-PAYMENT-RESPONSE");
  return header ? decodePaymentResponseHeader(header).transaction : undefined;
}
