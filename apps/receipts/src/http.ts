// HTTP API. Three kinds of caller:
// - people, signed in with a session cookie (owners, and people spending shared money)
// - assistants, signing each request with their own key (AGENT_HEADERS)
// - anyone: health and network info
import express, { type NextFunction, type Request, type Response } from "express";
import { AGENT_HEADERS } from "@mandate/shared/api";
import { ServiceError } from "./payments/store.ts";
import type { MandateService } from "./service.ts";

const COOKIE = "mandate_session";

function sessionToken(req: Request): string {
  const value = req.headers.cookie?.split(";").map((c) => c.trim()).find((c) => c.startsWith(`${COOKIE}=`));
  return value?.slice(COOKIE.length + 1) ?? "";
}

export function createApp(service: MandateService) {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", "loopback");
  // Keep the raw body: assistants sign it.
  app.use(express.json({ limit: "16kb", verify: (req, _res, buf) => { (req as Request & { rawBody?: string }).rawBody = buf.toString("utf8"); } }));

  const allowedOrigins = new Set((process.env.WEB_ORIGIN ?? "http://localhost:4020,http://127.0.0.1:4020").split(",").map((o) => o.trim()));
  app.use((req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    const origin = req.get("origin");
    // Browsers send an Origin on cross-site writes; the web app is same-origin through its proxy.
    if (req.method !== "GET" && origin && !allowedOrigins.has(origin)) {
      res.status(403).json({ error: "Request origin is not allowed" });
      return;
    }
    next();
  });

  const rateLimit = (limit: number, windowMs: number, message: string) => {
    const attempts = new Map<string, { count: number; reset: number }>();
    return (req: Request, _res: Response, next: NextFunction) => {
      const time = Date.now();
      for (const [key, entry] of attempts) if (entry.reset <= time) attempts.delete(key);
      const key = req.ip ?? "local";
      const record = attempts.get(key) ?? { count: 0, reset: time + windowMs };
      record.count++;
      attempts.set(key, record);
      if (record.count > limit) { next(new ServiceError(429, message)); return; }
      next();
    };
  };
  const signInLimit = rateLimit(30, 15 * 60_000, "Too many sign-in attempts. Try again in 15 minutes.");
  const agentLimit = rateLimit(120, 60_000, "Too many requests. Try again in a minute.");

  const actor = (req: Request) => service.authenticate(sessionToken(req));
  const body = (req: Request): Record<string, unknown> => {
    if (req.method === "POST" && (!req.body || Array.isArray(req.body) || typeof req.body !== "object")) return {};
    return (req.body ?? {}) as Record<string, unknown>;
  };
  const query = (req: Request) => (typeof req.query.q === "string" ? req.query.q.slice(0, 80) : undefined);
  const cookieOptions = { httpOnly: true, sameSite: "lax" as const, secure: process.env.NODE_ENV === "production", path: "/api", maxAge: 30 * 86400_000 };

  // ---------- sign-in ----------
  app.post("/api/auth/register", signInLimit, async (req, res) => {
    const result = await service.register(body(req));
    res.cookie(COOKIE, result.token, cookieOptions).status(201).json(result.customer);
  });
  app.post("/api/auth/login", signInLimit, async (req, res) => {
    const result = await service.login(body(req));
    res.cookie(COOKIE, result.token, cookieOptions).json(result.customer);
  });
  app.post("/api/auth/logout", (req, res) => {
    service.logout(sessionToken(req));
    res.clearCookie(COOKIE, { ...cookieOptions, maxAge: undefined }).status(204).end();
  });
  app.get("/api/me", (req, res) => { res.json(service.me(actor(req))); });

  // ---------- the owner ----------
  app.post("/api/account", async (req, res) => { res.status(201).json(await service.openAccount(actor(req))); });
  app.post("/api/account/money", async (req, res) => { res.status(201).json(await service.addMoney(actor(req), body(req))); });
  app.get("/api/overview", async (req, res) => { res.json(await service.overview(actor(req))); });
  app.get("/api/activity", async (req, res) => { res.json(await service.activity(actor(req))); });
  app.get("/api/offers", async (req, res) => { actor(req); res.json(await service.offers(query(req))); });

  app.post("/api/shoppers", async (req, res) => { res.status(201).json(await service.createShopper(actor(req), body(req))); });
  app.delete("/api/shoppers/:id", async (req, res) => { await service.stopShopper(actor(req), req.params.id as string); res.status(204).end(); });
  app.post("/api/shoppers/:id/run", async (req, res) => { res.json(await service.runShopper(actor(req), req.params.id as string, body(req))); });
  app.post("/api/shoppers/:id/pairing", async (req, res) => { res.json(await service.newPairingCode(actor(req), req.params.id as string)); });
  app.post("/api/requests/:id", async (req, res) => { res.json(await service.decide(actor(req), req.params.id as string, body(req))); });

  // ---------- spending shared with you ----------
  app.get("/api/shared/:id/offers", async (req, res) => { res.json(await service.sharedOffers(actor(req), req.params.id as string, query(req))); });
  app.post("/api/shared/:id/pay", async (req, res) => { res.json(await service.sharedPay(actor(req), req.params.id as string, body(req))); });

  // ---------- assistants ----------
  const signed = (req: Request) => ({
    key: req.get(AGENT_HEADERS.key) ?? undefined,
    time: req.get(AGENT_HEADERS.time) ?? undefined,
    signature: req.get(AGENT_HEADERS.signature) ?? undefined,
  });
  const raw = (req: Request) => (req as Request & { rawBody?: string }).rawBody ?? "";
  const agent = (req: Request) => service.agent(signed(req), req.method, req.originalUrl, raw(req));
  app.post("/api/agent/connect", agentLimit, async (req, res) => {
    res.status(201).json(await service.connect(body(req), service.verifyKey(signed(req), req.method, req.originalUrl, raw(req))));
  });
  app.get("/api/agent/me", agentLimit, async (req, res) => { res.json(await service.agentConnection(agent(req))); });
  app.get("/api/agent/budget", agentLimit, async (req, res) => { res.json(await service.budget(agent(req))); });
  app.get("/api/agent/offers", agentLimit, async (req, res) => { agent(req); res.json(await service.offers(query(req))); });
  app.post("/api/agent/reports", agentLimit, async (req, res) => { res.json(await service.report(agent(req), body(req))); });
  app.get("/api/agent/requests/:id", agentLimit, async (req, res) => { res.json(await service.agentRequest(agent(req), req.params.id as string)); });

  app.get("/api/health", (_req, res) => { res.json({ ok: true }); });

  app.use((_req, res) => { res.status(404).json({ error: "Route not found" }); });
  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const status = error instanceof ServiceError ? error.status : error instanceof SyntaxError ? 400 : 500;
    if (status >= 500) console.error("[api]", error);
    res.status(status).json({ error: status === 500 ? "Something went wrong. Try again." : error instanceof Error ? error.message : "Invalid request" });
  });
  return app;
}
