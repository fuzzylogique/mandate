import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { validateMandateInput, WorkspaceStore } from "./store.ts";

test("mandate seller lists accept only positive safe integer IDs and normalize duplicates", () => {
  const input = { name: "Purchases", recipientType: "agent", recipient: "Buyer", limit: "10", period: "day", expiresAt: new Date(Date.now() + 86400_000).toISOString() };
  assert.deepEqual(validateMandateInput({ ...input, sellerIds: [202, 101, 202] }).sellerIds, [101, 202]);
  assert.equal(validateMandateInput(input).sellerIds, undefined);
  assert.equal(validateMandateInput({ ...input, sellerIds: [] }).sellerIds, undefined);
  assert.equal(validateMandateInput({ ...input, sellerIds: [Number.MAX_SAFE_INTEGER] }).sellerIds?.[0], Number.MAX_SAFE_INTEGER);
  for (const sellerIds of [null, "101, 202", {}, ["101"], [0], [-1], [1.5], [NaN], [Infinity], [Number.MAX_SAFE_INTEGER + 1], Array(101).fill(1)]) {
    assert.throws(() => validateMandateInput({ ...input, sellerIds }), { status: 400 });
  }
});

test("legacy accounts receive unique seller IDs that survive restart and account changes", () => {
  const directory = mkdtempSync(join(tmpdir(), "mandate-seller-ids-"));
  const path = join(directory, "workspace.sqlite");
  let store = new WorkspaceStore(path);
  try {
    store.update(state => {
      const account = { ownerId: "owner", name: "Seller", type: "stellar" as const, rail: "blockchain" as const, currency: "USD", balance: "0", createdAt: new Date().toISOString() };
      state.accounts.push({ ...account, id: "one" }, { ...account, id: "two", sellerId: 50 });
    });
    assert.equal(store.read().accounts[0]!.sellerId, 51);
    const legacy = store.read();
    delete legacy.accounts[0]!.sellerId;
    delete legacy.nextSellerId;
    store.close();
    const db = new DatabaseSync(path);
    db.prepare("UPDATE payment_workspace SET body=? WHERE id=1").run(JSON.stringify(legacy));
    db.close();
    store = new WorkspaceStore(path);
    const assigned = store.read().accounts[0]!.sellerId!;
    assert.equal(assigned, 51);
    store.close(); store = new WorkspaceStore(path);
    assert.equal(store.read().accounts[0]!.sellerId, assigned);
    assert.equal(store.read().accounts[1]!.sellerId, 50);
    store.update(state => {
      state.accounts[0]!.name = "Renamed seller";
      state.accounts.push({ ...state.accounts[0]!, id: "three", sellerId: undefined });
    });
    assert.equal(store.read().accounts[0]!.sellerId, assigned);
    assert.ok(store.read().accounts[2]!.sellerId! > assigned);
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("email/password authentication normalizes emails, protects credentials, and revokes sessions", async () => {
  const store = new WorkspaceStore(":memory:");
  try {
    const registered = await store.register({ name: "Owner", email: " OWNER@example.com ", password: "a long owner password" });
    const owner = store.authenticate(registered.token);
    assert.equal(registered.customer.email, "owner@example.com");
    assert.notEqual(store.read().customers[0]!.password, "a long owner password");
    assert.equal(JSON.stringify(store.workspace(owner)).includes("password"), false);
    assert.equal(JSON.stringify(store.read()).includes(registered.token), false);
    assert.deepEqual(store.workspace(owner).accounts, []);
    assert.equal("balances" in registered.customer, false);
    const login = await store.login({ email: "owner@example.com", password: "a long owner password" });
    assert.equal(store.authenticate(login.token).id, owner.id);
    await assert.rejects(store.login({ email: "owner@example.com", password: "wrong" }), { status: 401 });
    await assert.rejects(store.login({ email: "unknown@example.com", password: "wrong" }), { status: 401 });
    await assert.rejects(store.register({ name: "Duplicate", email: "OWNER@example.com", password: "another long password" }), { status: 409 });
    await assert.rejects(store.register({ name: "Short", email: "short@example.com", password: "short" }), { status: 400 });
    store.logout(registered.token);
    assert.throws(() => store.authenticate(registered.token), { status: 401 });
    assert.equal(store.authenticate(login.token).id, owner.id);
  } finally { store.close(); }
});

test("sessions expire and workspace data persists across restarts", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-11-14T12:00:00Z") });
  const directory = mkdtempSync(join(tmpdir(), "mandate-workspace-"));
  const path = join(directory, "workspace.sqlite");
  let store = new WorkspaceStore(path);
  try {
    const registered = await store.register({ name: "Owner", email: "owner@example.com", password: "a long owner password" });
    const before = store.workspace(store.authenticate(registered.token));
    store.close(); store = new WorkspaceStore(path);
    assert.deepEqual(store.workspace(store.authenticate(registered.token)), before);
    t.mock.timers.tick(7 * 86400_000);
    assert.throws(() => store.authenticate(registered.token), { status: 401 });
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});
