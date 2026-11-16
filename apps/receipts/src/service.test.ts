// The service's own rules, with the chain faked: pairing an assistant, signed
// agent requests, shared spending, and what a stopped shopper may spend.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { Keypair } from "@stellar/stellar-sdk";
import { agentSigningPayload } from "@mandate/shared/api";
import type { ChainGateway, ChainWallet } from "./payments/stellar.ts";
import { MandateService } from "./service.ts";
import { ReceiptStore } from "./store.ts";

const TRUSTED = Keypair.random().publicKey();
const LOOKALIKE = Keypair.random().publicKey();

/** A chain that records calls and always succeeds. */
function fakeChain() {
  const secrets = new Map<string, string>();
  const keys = new Map<string, Keypair>();
  const calls: string[] = [];
  let nextRule = 1;
  const wallet = (id: string): ChainWallet => ({ id, address: `C${id}`, rail: "blockchain" });
  const chain: ChainGateway = {
    network: { id: "stellar:testnet", name: "Stellar testnet", rpcUrl: "", horizonUrl: "", currency: "USD", tokenContract: "CTOKEN", explorerUrl: "https://example.test", smartAccounts: true, mandates: true, faucet: true },
    treasury: (id) => ({ id, address: `G${id}`, rail: "classic" }),
    wallet,
    secret: (id, value) => secrets.get(id) ?? (secrets.set(id, value()), secrets.get(id)!),
    command: (_id, _input, work) => work(),
    balance: async () => 1n,
    faucet: async () => ({ txHash: "f".repeat(64), amount: "10000" }),
    deposit: async () => ({ txHash: "d".repeat(64) }),
    createAccount: async (id) => ({ ...wallet(id), txHash: "c".repeat(64) }),
    transfer: async () => ({ txHash: "t".repeat(64) }),
    addMandate: async (_id, _treasury, _account, input) => { calls.push(`add:${input.signer}`); return { ruleId: nextRule++, txHash: "a".repeat(64) }; },
    revokeMandate: async (_id, _treasury, _account, ruleId) => { calls.push(`revoke:${ruleId}`); return { txHash: "r".repeat(64) }; },
    spent: async () => 0n,
    isTrusted: async (address) => address === TRUSTED,
    registerStore: async () => ({ txHash: "s".repeat(64) }),
    setLimit: async () => ({ txHash: "l".repeat(64) }),
    keypairFor: (id) => keys.get(id) ?? (keys.set(id, Keypair.random()), keys.get(id)!),
    ensureUsd: async () => ({ tokenContract: "CTOKEN", issuer: "GISSUER" }),
    hasTransaction: () => false,
    close: () => undefined,
  };
  return { chain, calls };
}

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

/** Headers an assistant sends, signed with its own key. */
function signed(key: Keypair, method: string, path: string, body: string, time = String(Date.now())) {
  const signature = key.sign(Buffer.from(agentSigningPayload(method, path, time, sha256(body)))).toString("base64");
  return { key: key.publicKey(), time, signature };
}

let directory: string;
let catalog: Server;
let service: MandateService;
let receipts: ReceiptStore;

before(async () => {
  directory = mkdtempSync(join(tmpdir(), "mandate-service-"));
  catalog = createServer((_req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({
      stores: [
        { slug: "greenleaf", name: "GreenLeaf", domain: "greenleaf.example", payTo: TRUSTED, items: [{ id: "herbs", title: "Herbs", price: "2.10", url: "/greenleaf/herbs" }] },
        { slug: "freshmarrt", name: "FreshMarrt", domain: "freshmarrt.example", payTo: LOOKALIKE, looksLike: "FreshMart", items: [{ id: "herbs", title: "Herbs", price: "1.20", url: "/freshmarrt/herbs" }] },
      ],
    }));
  });
  await new Promise<void>((resolve) => catalog.listen(0, "127.0.0.1", resolve));
  const { port } = catalog.address() as AddressInfo;
  receipts = new ReceiptStore(join(directory, "receipts.sqlite"));
  service = new MandateService(join(directory, "workspace.sqlite"), fakeChain().chain, {
    merchantUrl: `http://127.0.0.1:${port}`, verifier: "CVERIFIER", rpcUrl: "", explorerUrl: "https://example.test", receipts,
  });
});

after(() => {
  catalog.close();
  rmSync(directory, { recursive: true, force: true });
});

async function owner(email: string) {
  const { token } = await service.register({ name: "Maple Bistro", email, password: "correct horse battery" });
  const actor = service.authenticate(token);
  await service.openAccount(actor);
  return actor;
}

test("an assistant connects once with its code, then signs every request with its own key", async () => {
  const actor = await owner("owner1@example.test");
  const shopper = await service.createShopper(actor, { name: "Claude", kind: "assistant", limit: "10", period: "week", requestId: "r1" });
  assert.equal(shopper.status, "waiting");
  assert.match(shopper.pairing!.code, /^[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}$/);

  const key = Keypair.random();
  const body = JSON.stringify({ code: shopper.pairing!.code.toLowerCase() });
  const verified = service.verifyKey(signed(key, "POST", "/api/agent/connect", body), "POST", "/api/agent/connect", body);
  const connection = await service.connect({ code: shopper.pairing!.code.toLowerCase() }, verified);
  assert.equal(connection.ruleId, 1);
  assert.equal(connection.name, "Claude");

  // The code works once.
  await assert.rejects(service.connect({ code: shopper.pairing!.code }, { key: Keypair.random().publicKey() }), { status: 401 });

  // Requests are checked against the key, the path and the time.
  const me = service.agent(signed(key, "GET", "/api/agent/me", ""), "GET", "/api/agent/me", "");
  assert.equal(me.id, shopper.id);
  assert.throws(() => service.agent(signed(key, "GET", "/api/agent/me", ""), "GET", "/api/agent/budget", ""), { status: 401 });
  assert.throws(() => service.agent(signed(key, "GET", "/api/agent/me", "", String(Date.now() - 10 * 60_000)), "GET", "/api/agent/me", ""), { status: 401 });
  assert.throws(() => service.agent(signed(Keypair.random(), "GET", "/api/agent/me", ""), "GET", "/api/agent/me", ""), { status: 401 });
});

test("a stopped shopper has nothing left to spend", async () => {
  const actor = await owner("owner2@example.test");
  const shopper = await service.createShopper(actor, { name: "Pantry", kind: "hosted", limit: "10", period: "week", job: { item: "herbs", startNow: false }, requestId: "r2" });
  const record = () => service.agent(signed(service["chain"].keypairFor(`shopper:${shopper.id}`), "GET", "/x", ""), "GET", "/x", "");
  assert.equal((await service.budget(record())).remaining, "10");
  await service.stopShopper(actor, shopper.id);
  const budget = await service.budget(record());
  assert.equal(budget.status, "stopped");
  assert.equal(budget.remaining, "0");
});

test("offers come cheapest first and say which stores are trusted", async () => {
  const offers = await service.offers("herbs");
  assert.deepEqual(offers.map((offer) => [offer.store.name, offer.store.trusted]), [["FreshMarrt", false], ["GreenLeaf", true]]);
  assert.equal(offers[0]!.store.looksLike, "FreshMart");
});

test("shared spending is visible only to the person it was shared with", async () => {
  const actor = await owner("owner4@example.test");
  const shared = await service.createShopper(actor, { name: "Sam's budget", kind: "person", holder: "sam@example.test", limit: "5", period: "week", requestId: "r4" });
  const sam = service.authenticate((await service.register({ name: "Sam", email: "sam@example.test", password: "correct horse battery" })).token);
  const eve = service.authenticate((await service.register({ name: "Eve", email: "eve@example.test", password: "correct horse battery" })).token);
  assert.equal((await service.sharedOffers(sam, shared.id, "herbs")).length, 2);
  await assert.rejects(service.sharedOffers(eve, shared.id), { status: 404 });
  await assert.rejects(service.createShopper(actor, { name: "Me", kind: "person", holder: "owner4@example.test", limit: "5", period: "week", requestId: "r5" }), { status: 400 });
});
