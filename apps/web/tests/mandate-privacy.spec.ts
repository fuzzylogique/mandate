import { expect, test, type Page } from "@playwright/test";
import type { AccountMandate, PaymentNetwork, PaymentWorkspace, SpendingAccount } from "@mandate/shared";

const mandateId = "mnd_browser_test_secret_0123456789abcdefghijklmnop";
const mandate: AccountMandate = { reference: "owner-record-reference", accountId: "bank", name: "Purchasing", recipientType: "agent", recipient: "Purchaser", limit: "10", spent: "0", period: "day", expiresAt: "2099-12-31T23:59:59Z", status: "active", createdAt: "2026-11-14T12:00:00Z", rail: "traditional", enforcement: "service", verifiedRecipientsOnly: true };
const account: SpendingAccount = { id: "bank", ownerId: "owner", name: "Operations", rail: "traditional", type: "traditional", currency: "USD", balance: "100", address: "BANK_DEMO_SOURCE", verified: true, createdAt: "2026-11-14T12:00:00Z" };
const network: PaymentNetwork = { id: "stellar:testnet", name: "Stellar testnet", currency: "XLM", rpcUrl: "https://rpc.example", horizonUrl: "https://horizon.example", explorerUrl: "https://explorer.example", tokenContract: "C_TEST_TOKEN", smartAccounts: true, verifiedSmartAccounts: true, mandates: true, faucet: true };
const workspace: PaymentWorkspace = { mode: "stellar-testnet", network, customer: { id: "owner", name: "Owner", email: "owner@example.com" }, accounts: [account], mandates: [mandate], shared: [], activity: [] };

async function mockWorkspace(page: Page) {
  await page.route("**/api/**", async route => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/network") await route.fulfill({ json: { mode: "stellar-testnet", network } });
    else if (path === "/api/workspace") await route.fulfill({ json: workspace });
    else await route.fulfill({ status: 404, json: { error: "Unexpected test request" } });
  });
}

test("dashboard refreshes both XLM balances when returning after a payment", async ({ page }) => {
  await mockWorkspace(page);
  let paid = false;
  await page.route("**/api/workspace", async route => {
    await route.fulfill({ json: { ...workspace, accounts: [
      { ...account, id: "source", type: "stellar", rail: "blockchain", name: "Sender", currency: "XLM", balance: paid ? "9.5" : "10" },
      { ...account, id: "seller", type: "stellar", rail: "blockchain", name: "Seller", currency: "XLM", balance: paid ? "0.5" : "0" },
    ] } });
  });
  await page.goto("/");
  await expect(page.locator(".balance")).toHaveText("10.000 XLM");
  paid = true;
  // The browser focuses the dashboard again when returning from the Pay tab.
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(page.locator(".balance")).toHaveText("9.500 XLM");
  await expect(page.getByRole("button", { name: /Seller/ })).toContainText("0.500 XLM");
  await page.getByRole("button", { name: /Seller/ }).click();
  await expect(page.locator(".balance")).toHaveText("0.500 XLM");
});

test("dashboard masks the mandate until Show mandate, then clears it on Hide", async ({ page }) => {
  await mockWorkspace(page);
  let revealRequests = 0;
  await page.route("**/api/mandates/owner-record-reference/reveal", async route => {
    expect(route.request().method()).toBe("POST");
    revealRequests++;
    await route.fulfill({ json: { mandateId } });
  });
  await page.goto("/mandates");
  const idField = page.getByLabel("Mandate ID", { exact: true });
  await expect(idField).toHaveAttribute("type", "password");
  await expect(idField).not.toHaveValue(mandateId);
  await expect(page.getByRole("button", { name: "Copy mandate ID" })).toHaveCount(0);
  expect(revealRequests).toBe(0);
  const payLink = page.getByRole("link", { name: "Open Pay page" });
  await expect(payLink).toHaveAttribute("href", "/pay?rail=traditional");
  await page.getByRole("button", { name: "Show mandate", exact: true }).click();
  await expect(idField).toHaveAttribute("type", "text");
  await expect(idField).toHaveValue(mandateId);
  expect(revealRequests).toBe(1);
  await page.getByRole("button", { name: "Hide mandate", exact: true }).click();
  await expect(idField).toHaveAttribute("type", "password");
  await expect(idField).not.toHaveValue(mandateId);
  await expect(page.getByRole("button", { name: "Copy mandate ID" })).toHaveCount(0);
  expect(page.url()).not.toContain(mandateId);
});

test("newly created mandate is masked and has no separate payment credential", async ({ page }) => {
  await mockWorkspace(page);
  await page.route("**/api/mandates", async route => {
    expect(route.request().method()).toBe("POST");
    await route.fulfill({ status: 201, json: { mandate: { ...mandate, reference: "created-record" }, mandateId } });
  });
  await page.goto("/mandates");
  await page.getByLabel("Mandate name", { exact: true }).fill("Purchasing");
  await page.getByLabel("Mandate holder", { exact: true }).fill("Purchaser");
  await page.getByLabel("Spending limit (USD)", { exact: true }).fill("10");
  await page.getByRole("button", { name: "Create mandate", exact: true }).click();
  const created = page.locator(".mandate-form-card");
  await expect(created.getByRole("heading", { name: "Mandate created" })).toBeVisible();
  const idField = created.getByLabel("Mandate ID", { exact: true });
  await expect(idField).toHaveAttribute("type", "password");
  await expect(idField).not.toHaveValue(mandateId);
  await expect(page.getByLabel("Payment credential", { exact: true })).toHaveCount(0);
  await expect(created.getByLabel("Payment page link")).toHaveValue("http://127.0.0.1:4030/pay?rail=traditional");
  await created.getByRole("button", { name: "Show mandate", exact: true }).click();
  await expect(idField).toHaveValue(mandateId);
  await expect(idField).toHaveAttribute("type", "text");
});

test("Pay page keeps the ID password-masked through preview, payment and another payment", async ({ page, context }) => {
  await mockWorkspace(page);
  await context.addCookies([{ name: "mandate_session", value: "owner-session", domain: "127.0.0.1", path: "/api" }]);
  const submitted: string[] = [];
  await page.route("**/api/pay**", async route => {
    const request = route.request();
    const body = request.postDataJSON() as Record<string, unknown>;
    expect(body.mandateId).toBe(mandateId);
    expect(body).not.toHaveProperty("token");
    expect(request.headers()).not.toHaveProperty("authorization");
    expect(request.headers()).not.toHaveProperty("cookie");
    submitted.push(new URL(request.url()).pathname);
    if (request.url().endsWith("/preview")) {
      await route.fulfill({ json: { rail: "traditional", mandate: { name: "Purchasing", address: account.address, limit: "10", spent: "0", expiresAt: mandate.expiresAt }, seller: { address: "BANK_DEMO_SELLER", name: "Seller", verified: true }, currency: "USD", balance: "100", checks: [{ label: "Payment is allowed", passed: true }] } });
    } else {
      await route.fulfill({ json: { status: "paid", payment: { id: "receipt", accountId: account.id, source: account.address, destination: "BANK_DEMO_SELLER", amount: "1", currency: "USD", kind: "payment", mandateReference: mandate.reference, reference: "Invoice", createdAt: "2026-11-14T12:00:00Z", settlement: "traditional-demo" } } });
    }
  });
  await page.goto("/pay?rail=traditional");
  const idField = page.getByLabel("Mandate ID", { exact: true });
  await expect(idField).toHaveAttribute("type", "password");
  await idField.fill(mandateId);
  await page.getByLabel("Seller name", { exact: true }).fill("Seller");
  await page.getByLabel("Verified traditional recipient reference", { exact: true }).fill("BANK_DEMO_SELLER");
  await page.getByLabel("Amount (USD · demo)", { exact: true }).fill("1");
  await page.getByLabel("Payment reference", { exact: true }).fill("Invoice");
  await expect(page.getByRole("button", { name: /Show mandate|Hide mandate/ })).toHaveCount(0);
  await expect(page.getByLabel("Payment credential", { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Check mandate & seller" }).click();
  await expect(page.getByText("Payment is allowed")).toBeVisible();
  await expect(idField).toHaveAttribute("type", "password");
  await page.getByRole("button", { name: "Make payment", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Payment succeeded" })).toBeVisible();
  await expect(idField).toHaveAttribute("type", "password");
  await page.getByRole("button", { name: "Start another payment" }).click();
  await expect(idField).toHaveAttribute("type", "password");
  expect(submitted).toEqual(["/api/pay/preview", "/api/pay"]);
  expect(page.url()).not.toContain(mandateId);
});
