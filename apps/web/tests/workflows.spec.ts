import { expect, test, type Page } from "@playwright/test";
import type { AccountAgent, AccountMandate, PaymentDecline, PaymentEntry, PaymentNetwork, PaymentWorkspace, SpendingAccount, Vendor } from "@mandate/shared";

const account: SpendingAccount = { id: "main", ownerId: "owner", name: "Main account", rail: "blockchain", type: "stellar", currency: "USD", balance: "4784", address: "C_LARKFIELD", verified: true, createdAt: "2026-11-18T12:00:00Z" };
const network: PaymentNetwork = { id: "stellar:testnet", name: "Stellar testnet", currency: "XLM", rpcUrl: "https://rpc.example", horizonUrl: "https://horizon.example", explorerUrl: "https://explorer.example", tokenContract: "C_TEST_TOKEN", smartAccounts: true, verifiedSmartAccounts: true, mandates: true, agentVerification: true, faucet: true };
const vendors: Vendor[] = [
  { sellerId: 7, name: "Cloudhaven", category: "Cloud and APIs", address: "C_CLOUDHAVEN" },
  { sellerId: 5, name: "Paperline Supply", category: "Office supplies", address: "C_PAPERLINE" },
  { sellerId: 4, name: "Seatwise", category: "Software", address: "C_SEATWISE" },
];
const agent: AccountAgent = { id: "agt_software", accountId: "main", name: "Software renewals agent", verified: true, status: "connected", createdAt: "2026-11-18T12:00:00Z", publicKey: "GCF6WOEY735RPTS6EESGXC4KDLK2SHPGBULTSVLXRUY6HPWYRZ6LNFJW" };
const mandate: AccountMandate = { reference: "software", accountId: "main", name: "Software renewals", recipientType: "agent", recipient: agent.id, agentId: agent.id, limit: "300", spent: "67", period: "month", expiresAt: "2099-03-31T23:59:59Z", status: "active", createdAt: "2026-11-18T12:00:00Z", currency: "USD", enforcement: "on-chain", ruleId: 3, verifiedRecipientsOnly: true, sellerIds: [4], category: "Software" };
const payment: PaymentEntry = { id: "tx-seat", accountId: "main", source: "C_LARKFIELD", destination: "C_SEATWISE", kind: "payment", amount: "40", currency: "USD", mandateReference: "software", agentId: agent.id, reference: "Password manager renewal · x402 seatwise.example", createdAt: new Date().toISOString(), settlement: "stellar-testnet", txHash: "tx-seat", explorerUrl: "https://explorer.example/tx/tx-seat" };
const decline: PaymentDecline = { id: "dec_1", accountId: "main", agentId: agent.id, mandateReference: "software", destination: "C_SEATWISE", amount: "2400", currency: "USD", reason: "Payment exceeds the mandate's spending limit", reference: "Annual plan to save on seats · x402 seatwise.example", createdAt: new Date().toISOString() };
const workspace: PaymentWorkspace = { mode: "stellar-testnet", network, customer: { id: "owner", name: "Dana Okafor", email: "dana@example.com", company: "Larkfield Logistics", team: "Operations" }, accounts: [account], agents: [], mandates: [], shared: [], activity: [], declines: [], vendors };

async function mock(page: Page, current: () => PaymentWorkspace) {
  await page.route("**/api/**", async route => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/network") await route.fulfill({ json: { mode: "stellar-testnet", network } });
    else if (path === "/api/workspace") await route.fulfill({ json: current() });
    else await route.fulfill({ status: 404, json: { error: "Unexpected test request" } });
  });
}

test("a team sets up a purchasing workflow from a template and gets a code and instructions for its agent", async ({ page }) => {
  let state = workspace;
  const waiting: AccountAgent = { id: "agt_supplies", accountId: "main", name: "Office supplies agent", verified: false, status: "waiting", createdAt: "2026-11-18T12:00:00Z", pairing: { code: "K7Q4-92XD", expiresAt: new Date(Date.now() + 30 * 60_000).toISOString() }, pending: [{ name: "Office supplies", limit: "250", period: "week", expiresAt: "2099-03-31T23:59:59Z", sellerIds: [5], category: "Office supplies" }] };
  await mock(page, () => state);
  const requests: Record<string, unknown>[] = [];
  await page.route("**/api/workflows", async route => {
    requests.push(route.request().postDataJSON());
    state = { ...workspace, agents: [waiting] };
    await route.fulfill({ status: 201, json: waiting });
  });
  await page.goto("/");
  await expect(page.getByRole("region", { name: "Main account", exact: true })).toContainText("Larkfield Logistics · Operations");
  await expect(page.getByRole("heading", { name: "Set up your first purchasing workflow" })).toBeVisible();
  await page.getByRole("button", { name: "New purchasing workflow", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "New purchasing workflow", exact: true });
  await dialog.getByRole("button", { name: /Office supplies/ }).click();
  await expect(dialog.getByLabel("Workflow name", { exact: true })).toHaveValue("Office supplies");
  // The vendors that sell this kind of thing start selected, by name. No seller IDs to type.
  await expect(dialog.getByRole("checkbox", { name: /Paperline Supply/ })).toBeChecked();
  await expect(dialog.getByRole("checkbox", { name: /Seatwise/ })).not.toBeChecked();
  await expect(dialog.getByLabel(/Seller IDs/)).toHaveCount(0);
  await dialog.getByLabel("Budget (USD)", { exact: true }).fill("250");
  await dialog.getByRole("button", { name: "Set up workflow", exact: true }).click();
  expect(requests).toHaveLength(1);
  expect(requests[0]).toMatchObject({ name: "Office supplies", category: "Office supplies", limit: "250", period: "week", sellerIds: [5] });

  const connect = page.getByRole("dialog", { name: "Connect the Office supplies agent", exact: true });
  await expect(connect.getByRole("button", { name: "Connection code K7Q4-92XD, copy", exact: true })).toBeVisible();
  await expect(connect.locator(".brief pre")).toContainText("You are the Office supplies agent for the Operations team at Larkfield Logistics.");
  await expect(connect.locator(".brief pre")).toContainText("connect to Mandate with code K7Q4-92XD");
  await expect(connect.locator(".brief pre")).toContainText("You cannot raise your own budget. Only Dana Okafor can");
  await connect.getByRole("button", { name: "Done", exact: true }).click();
  const card = page.locator(".workflow-card");
  await expect(card.getByRole("heading", { name: "Office supplies", exact: true })).toBeVisible();
  await expect(card).toContainText("Waiting for its agent to connect");
  await expect(card).toContainText("Budget ready: 250 USD every 7 days. Vendors: Paperline Supply.");
  await expect(page.getByRole("navigation", { name: "Workspace" }).getByRole("link")).toHaveText(["Workflows 1", "Agents 1", "Mandates 0", "Spending"]);
});

test("a running workflow shows its budget and vendors by name, and only the owner's dashboard changes the budget", async ({ page }) => {
  let state: PaymentWorkspace = { ...workspace, agents: [agent], mandates: [mandate], activity: [payment], declines: [decline] };
  await mock(page, () => state);
  const requests: Record<string, unknown>[] = [];
  await page.route("**/api/mandates/software", async route => {
    expect(route.request().method()).toBe("PATCH");
    requests.push(route.request().postDataJSON());
    state = { ...state, mandates: [{ ...mandate, limit: "500" }] };
    await route.fulfill({ json: state.mandates[0] });
  });
  await page.goto("/");
  const card = page.locator(".workflow-card");
  await expect(card).toContainText("Software renewals agent · own key, verified on chain");
  await expect(card).toContainText("Approved vendors: Seatwise");
  await expect(card).toContainText("233 USD left");
  await expect(card).toContainText("1 purchase, last: Password manager renewal (40 USD) · 1 refused");
  await card.getByRole("button", { name: "Change budget", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Change budget for Software renewals", exact: true });
  await expect(dialog.getByRole("button", { name: "Change budget", exact: true })).toBeDisabled();
  await dialog.getByLabel("New budget (USD)", { exact: true }).fill("500");
  await dialog.getByRole("button", { name: "Change budget", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect(requests).toHaveLength(1);
  expect(requests[0]).toMatchObject({ limit: "500" });
  await expect(card).toContainText("433 USD left");
  // The mandate behind it names its vendors too.
  await page.goto("/mandates");
  await expect(page.getByText("Approved vendors: Seatwise", { exact: true })).toBeVisible();
  await expect(page.getByText("Category: Software", { exact: true })).toBeVisible();
});

test("Spending totals purchases by workflow and vendor, lists what was refused and exports a CSV", async ({ page }) => {
  await mock(page, () => ({ ...workspace, agents: [agent], mandates: [mandate], activity: [payment], declines: [decline] }));
  await page.goto("/spending");
  await expect(page.getByRole("heading", { name: "Spending", exact: true })).toBeVisible();
  const stats = page.locator(".stat-row");
  await expect(stats).toContainText("40 USD");
  await expect(stats).toContainText("2400 USD was not paid");
  await expect(page.locator(".breakdown").filter({ hasText: "By workflow" })).toContainText("Software renewals");
  await expect(page.locator(".breakdown").filter({ hasText: "By vendor" })).toContainText("Seatwise");
  const refused = page.locator(".card").filter({ has: page.getByRole("heading", { name: "Refused", exact: true }) });
  await expect(refused).toContainText("Annual plan to save on seats");
  await expect(refused).toContainText("Payment exceeds the mandate's spending limit. Nothing was paid.");
  await expect(page.getByRole("link", { name: "View transaction ↗" })).toHaveAttribute("href", "https://explorer.example/tx/tx-seat");
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export CSV", exact: true }).click();
  const file = await (await download).createReadStream();
  let text = "";
  for await (const chunk of file) text += chunk;
  const lines = text.split("\n");
  expect(lines[0]).toBe("Date,Status,Workflow,Category,Agent,Vendor,Vendor address,Amount,Currency,Reference,Reason refused,Stellar transaction");
  expect(lines).toHaveLength(3);
  expect(text).toContain("Paid,Software renewals,Software,Software renewals agent,Seatwise,C_SEATWISE,40,USD,Password manager renewal · x402 seatwise.example,,tx-seat");
  expect(text).toContain("Refused,Software renewals,Software,Software renewals agent,Seatwise,C_SEATWISE,2400,USD,Annual plan to save on seats · x402 seatwise.example,Payment exceeds the mandate's spending limit,");
  // Nothing sideways on a phone.
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});
