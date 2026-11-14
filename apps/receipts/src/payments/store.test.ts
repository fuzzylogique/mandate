import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { WorkspaceStore } from "./store.ts";

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
