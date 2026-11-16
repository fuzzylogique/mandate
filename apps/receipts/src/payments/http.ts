import express, { type NextFunction, type Request, type Response } from "express";
import { ServiceError } from "./store.ts";
import type { StellarPaymentService } from "./stellar-service.ts";
import { ChatError, createPaymentChats } from "@mandate/langchain/chat";

function sessionToken(req: Request): string {
  const value = req.headers.cookie?.split(";").map(c => c.trim()).find(c => c.startsWith("mandate_session="));
  return value?.slice("mandate_session=".length) ?? "";
}

export function createPaymentApp(service: StellarPaymentService) {
  const app = express();
  app.disable("x-powered-by");
  // Stripe signs the original bytes. Register this before JSON parsing and browser origin checks.
  app.post("/api/stripe/webhook", express.raw({ type: "application/json", limit: "256kb" }), async (req, res) => {
    if (!Buffer.isBuffer(req.body)) throw new ServiceError(400, "A raw JSON webhook payload is required");
    await service.stripeWebhook(req.body, req.get("stripe-signature") ?? "");
    res.json({ received: true });
  });
  app.use(express.json({ limit: "16kb" }));
  app.use((req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    const origin = req.get("origin");
    if (req.method !== "GET" && origin && origin !== (process.env.WEB_ORIGIN ?? "http://localhost:4020")) {
      res.status(403).json({ error: "Request origin is not allowed" });
      return;
    }
    next();
  });
  const rateLimit = (limit: number, windowMs: number, message: string) => {
    const attempts = new Map<string, { count: number; reset: number }>();
    return (req: Request, _res: Response, next: NextFunction) => {
      const currentTime = Date.now();
      for (const [key, entry] of attempts) if (entry.reset <= currentTime) attempts.delete(key);
      const key = req.ip ?? "local";
      const record = attempts.get(key) ?? { count: 0, reset: currentTime + windowMs };
      record.count++;
      attempts.set(key, record);
      if (record.count > limit) { next(new ServiceError(429, message)); return; }
      next();
    };
  };
  const throttle = rateLimit(30, 15 * 60_000, "Too many sign-in attempts. Try again in 15 minutes.");
  const paymentThrottle = rateLimit(60, 60_000, "Too many payment requests. Try again in a minute.");
  const chatThrottle = rateLimit(20, 60_000, "Too many chat requests. Try again in a minute.");
  const chats = createPaymentChats();
  const actor = (req: Request) => service.authenticate(sessionToken(req));
  const body = (req: Request): Record<string, unknown> => {
    if (!req.is("application/json") || !req.body || Array.isArray(req.body) || typeof req.body !== "object") throw new ServiceError(400, "A JSON object is required");
    return req.body as Record<string, unknown>;
  };
  const cookieOptions = { httpOnly: true, sameSite: "strict" as const, secure: process.env.NODE_ENV === "production", path: "/api", maxAge: 7 * 86400_000 };
  app.post("/api/auth/register", throttle, async (req, res) => {
    const result = await service.register(body(req));
    res.cookie("mandate_session", result.token, cookieOptions).status(201).json(result.customer);
  });
  app.post("/api/auth/login", throttle, async (req, res) => {
    const result = await service.login(body(req));
    res.cookie("mandate_session", result.token, cookieOptions).json(result.customer);
  });
  app.post("/api/auth/logout", (req, res) => {
    service.logout(sessionToken(req));
    res.clearCookie("mandate_session", { ...cookieOptions, maxAge: undefined }).status(204).end();
  });
  app.get("/api/workspace", async (req, res) => res.json(await service.workspace(actor(req))));
  app.post("/api/agents", async (req, res) => res.status(201).json(await service.createAgent(actor(req), body(req))));
  app.post("/api/accounts/open", async (req, res) => {
    res.status(201).json(await service.openAccount(actor(req), body(req)));
  });
  app.post("/api/accounts/:id/funding", async (req, res) => {
    const input = body(req);
    const owner = actor(req);
    const method = input.method ?? "fiat";
    if (method !== "fiat" && method !== "testnet") throw new ServiceError(400, "Choose FIAT or Testnet funding");
    res.status(201).json(method === "fiat" ? await service.createFiatCheckout(owner, req.params.id as string, input) : await service.fund(owner, req.params.id as string, input));
  });
  app.get("/api/funding/stripe/:sessionId", async (req, res) => res.json(await service.fiatFundingStatus(actor(req), req.params.sessionId as string)));
  app.post("/api/mandates", async (req, res) => res.status(201).json(await service.createMandate(actor(req), body(req))));
  app.post("/api/mandates/:id/reveal", (req, res) => res.json(service.revealMandate(actor(req), req.params.id as string)));
  app.delete("/api/mandates/:id", async (req, res) => { await service.revoke(actor(req), req.params.id as string); res.status(204).end(); });
  app.post("/api/payments", async (req, res) => res.status(201).json(await service.pay(actor(req), body(req))));
  app.post("/api/pay/preview", paymentThrottle, async (req, res) => {
    res.json(await service.previewMandatePayment(body(req)));
  });
  app.post("/api/pay", paymentThrottle, async (req, res) => {
    try {
      const payment = await service.payWithMandate(body(req));
      res.json({ status: "paid", payment });
    } catch (error) {
      if (error instanceof ServiceError && error.txHash && error.status === 503) {
        res.status(202).json({ status: "pending", reason: error.message, txHash: error.txHash });
      } else if (error instanceof ServiceError && [400, 401, 403, 404, 409].includes(error.status)) {
        res.json({ status: "declined", reason: error.message });
      } else throw error;
    }
  });
  app.post("/api/chat/sessions", chatThrottle, async (req, res) => {
    const setup = sessionToken(req) ? await service.defaultChatSetup(actor(req)) : undefined;
    const mandate = setup?.mandate;
    res.status(201).json(chats.open(setup && mandate ? {
      agentId: setup.agent.id, mandateId: setup.mandateId,
      mandate: { reference: mandate.reference, name: mandate.name, limit: mandate.limit, period: mandate.period, expiresAt: mandate.expiresAt, status: mandate.status },
    } : {}));
  });
  app.get("/api/chat/sessions/:id", (req, res) => res.json(chats.read(req.params.id as string)));
  app.post("/api/chat/sessions/:id/messages", chatThrottle, async (req, res) => {
    res.json(await chats.send(req.params.id as string, body(req).message));
  });
  app.get("/api/network", (_req, res) => res.json({ mode: "stellar-testnet", network: service.network }));
  app.get("/api/health", (_req, res) => res.json({ ok: true, mode: "stellar-testnet" }));
  app.use((_req, res) => res.status(404).json({ error: "Route not found" }));
  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const status = error instanceof ServiceError || error instanceof ChatError ? error.status : error instanceof SyntaxError ? 400 : 500;
    if (status === 500) console.error("[payments]", error);
    res.status(status).json({ error: status === 500 ? "The service could not complete this request" : error instanceof Error ? error.message : "Invalid request" });
  });
  return app;
}
