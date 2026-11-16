import Stripe from "stripe";
import { requireThat, ServiceError } from "./store.ts";

export type StripeSession = Pick<Stripe.Checkout.Session, "id" | "url" | "livemode" | "mode" | "status" | "payment_status" | "currency" | "amount_total" | "metadata" | "client_reference_id">;
export interface StripeCheckoutInput { id: string; accountId: string; ownerId: string; cents: number; email: string }
export interface FiatGateway {
  create(input: StripeCheckoutInput): Promise<StripeSession>;
  retrieve(id: string): Promise<StripeSession>;
  verifyEvent(payload: Buffer, signature: string): { type: string; livemode: boolean; sessionId?: string };
}

/** Hosted card collection with sandbox keys only. No card details reach this API. */
export class StripeSandbox implements FiatGateway {
  private env: NodeJS.ProcessEnv;
  constructor(env: NodeJS.ProcessEnv = process.env) { this.env = env; }
  private client() {
    requireThat(/^(sk|rk)_test_\S+$/.test(this.env.STRIPE_SECRET_KEY ?? ""), 503, "Configure STRIPE_SECRET_KEY with a Stripe sandbox/test key to use FIAT funding. Live payments are disabled.");
    requireThat(this.env.STRIPE_WEBHOOK_SECRET?.startsWith("whsec_"), 503, "Configure STRIPE_WEBHOOK_SECRET and forward Stripe webhooks to /api/stripe/webhook.");
    return new Stripe(this.env.STRIPE_SECRET_KEY!, { maxNetworkRetries: 2, timeout: 20_000 });
  }
  async create(input: StripeCheckoutInput): Promise<StripeSession> {
    const client = this.client();
    const origin = this.env.WEB_ORIGIN ?? "http://localhost:4020";
    let url: URL;
    try { url = new URL(origin); } catch { throw new ServiceError(503, "WEB_ORIGIN must be a valid HTTP(S) origin"); }
    requireThat(["http:", "https:"].includes(url.protocol) && url.origin === origin.replace(/\/$/, ""), 503, "WEB_ORIGIN must be an HTTP(S) origin without a path");
    try {
      return await client.checkout.sessions.create({
        mode: "payment", allowed_payment_method_types: ["card"], customer_email: input.email,
        adaptive_pricing: { enabled: false },
        client_reference_id: input.id,
        metadata: { fundingId: input.id, accountId: input.accountId, ownerId: input.ownerId },
        line_items: [{ quantity: 1, price_data: { currency: "usd", unit_amount: input.cents, product_data: { name: "Mandate sandbox USD funding" } } }],
        success_url: `${url.origin}/activity?funding=success&session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${url.origin}/activity?funding=cancelled`,
      }, { idempotencyKey: input.id });
    } catch { throw new ServiceError(503, "Stripe checkout could not be opened. Retry with the same request ID."); }
  }
  async retrieve(id: string): Promise<StripeSession> {
    const client = this.client();
    try { return await client.checkout.sessions.retrieve(id); }
    catch { throw new ServiceError(503, "Stripe payment confirmation is unavailable. Retry confirmation."); }
  }
  verifyEvent(payload: Buffer, signature: string) {
    const client = this.client();
    let event: Stripe.Event;
    try { event = client.webhooks.constructEvent(payload, signature, this.env.STRIPE_WEBHOOK_SECRET!); }
    catch { throw new ServiceError(400, "Invalid Stripe webhook signature or payload"); }
    return { type: event.type, livemode: event.livemode, sessionId: event.type.startsWith("checkout.session.") ? (event.data.object as Stripe.Checkout.Session).id : undefined };
  }
}
