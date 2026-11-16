import { expect, test, type Page } from "@playwright/test";
import type { AccountMandate, PaymentNetwork, PaymentWorkspace, SpendingAccount } from "@mandate/shared";

const mandateId = "mnd_browser_test_secret_0123456789abcdefghijklmnop";
const mandate: AccountMandate = { reference: "owner-record-reference", accountId: "bank", name: "Purchasing", recipientType: "agent", recipient: "Purchaser", limit: "10", spent: "0", period: "day", expiresAt: "2099-12-31T23:59:59Z", status: "active", createdAt: "2026-11-14T12:00:00Z", currency: "USD", enforcement: "on-chain", ruleId: 2, verifiedRecipientsOnly: true };
const account: SpendingAccount = { id: "bank", ownerId: "owner", name: "Operations", rail: "traditional", type: "traditional", currency: "USD", balance: "100", address: "C_DEMO_SOURCE", verified: true, createdAt: "2026-11-14T12:00:00Z" };
const network: PaymentNetwork = { id: "stellar:testnet", name: "Stellar testnet", currency: "XLM", rpcUrl: "https://rpc.example", horizonUrl: "https://horizon.example", explorerUrl: "https://explorer.example", tokenContract: "C_TEST_TOKEN", smartAccounts: true, verifiedSmartAccounts: true, mandates: true, faucet: true };
const workspace: PaymentWorkspace = { mode: "stellar-testnet", network, customer: { id: "owner", name: "Owner", email: "owner@example.com" }, accounts: [account], mandates: [mandate], shared: [], activity: [] };

async function mockClipboard(page: Page, fail = false) {
  await page.addInitScript(({ fail }) => {
    const writes: string[] = [];
    Object.defineProperty(window, "clipboardWrites", { value: writes });
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: {
      writeText: async (value: string) => {
        if (fail) throw new Error("Clipboard permission denied");
        writes.push(value);
      },
    } });
  }, { fail });
}

async function copiedValues(page: Page) {
  return page.evaluate(() => Reflect.get(window, "clipboardWrites") as string[]);
}

async function mockWorkspace(page: Page) {
  await page.route("**/api/**", async route => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/network") await route.fulfill({ json: { mode: "stellar-testnet", network } });
    else if (path === "/api/workspace") await route.fulfill({ json: workspace });
    else await route.fulfill({ status: 404, json: { error: "Unexpected test request" } });
  });
}

for (const type of ["traditional", "stellar"] as const) {
  for (const method of ["fiat", "testnet"] as const) {
    test(`${type} account supports ${method} funding and retries with the same request ID`, async ({ page }) => {
      await mockWorkspace(page);
      let funded = false;
      const requests: { amount: string; requestId: string; method: string }[] = [];
      await page.route("**/api/workspace", route => route.fulfill({ json: { ...workspace, accounts: [{ ...account, type, rail: type === "traditional" ? "traditional" : "blockchain", balance: funded ? "112.34" : "100" }] } }));
      await page.route("**/api/accounts/bank/funding", async route => {
        requests.push(route.request().postDataJSON());
        if (requests.length === 1) return route.fulfill({ status: 503, json: { error: "Awaiting testnet confirmation. Retry with the same request ID." } });
        funded = true;
        await route.fulfill({ status: 201, json: { id: "confirmed-tx", kind: "funding", amount: "12.34", currency: "USD", txHash: "confirmed-tx" } });
      });
      await page.goto("/");
      await page.getByRole("button", { name: "Add funds", exact: true }).click();
      const dialog = page.getByRole("dialog", { name: "Add funds" });
      await expect(dialog.getByRole("radio", { name: /FIAT/ })).toBeChecked();
      if (method === "testnet") await dialog.getByRole("radio", { name: /Testnet/ }).check();
      await dialog.getByLabel("Amount (USD)", { exact: true }).fill("12.34");
      await dialog.getByRole("button", { name: "Add funds", exact: true }).click();
      await expect(dialog.getByRole("alert")).toContainText("Awaiting testnet confirmation");
      await expect(page.locator(".balance")).toHaveText("100 USD");
      await dialog.getByRole("button", { name: "Add funds", exact: true }).click();
      await expect(dialog).toHaveCount(0);
      await expect(page.locator(".balance")).toHaveText("112.34 USD");
      expect(requests).toHaveLength(2);
      expect(requests[1]).toEqual(requests[0]);
      expect(requests[0]!.amount).toBe("12.34");
      expect(requests[0]!.method).toBe(method);
    });
  }
}

test("dashboard refreshes both USD balances when returning after a payment", async ({ page }) => {
  await mockWorkspace(page);
  let paid = false;
  await page.route("**/api/workspace", async route => {
    await route.fulfill({ json: { ...workspace, accounts: [
      { ...account, id: "source", type: "stellar", rail: "blockchain", name: "Sender", currency: "USD", balance: paid ? "9.5" : "10" },
      { ...account, id: "seller", type: "stellar", rail: "blockchain", name: "Seller", currency: "USD", balance: paid ? "0.5" : "0" },
    ] } });
  });
  await page.goto("/");
  await expect(page.locator(".balance")).toHaveText("10 USD");
  paid = true;
  // The browser focuses the dashboard again when returning from the Pay tab.
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(page.locator(".balance")).toHaveText("9.5 USD");
  await expect(page.getByRole("button", { name: /Seller/ })).toContainText("0.5 USD");
  await page.getByRole("button", { name: /Seller/ }).click();
  await expect(page.locator(".balance")).toHaveText("0.5 USD");
});

test("dashboard copies a mandate while masked and clears its field on Hide", async ({ page }) => {
  await mockWorkspace(page);
  await mockClipboard(page);
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
  await expect(page.getByRole("button", { name: "Copy mandate ID" })).toBeVisible();
  expect(revealRequests).toBe(0);
  await page.getByRole("button", { name: "Copy mandate ID" }).click();
  await expect(page.getByRole("status")).toHaveText("Copied to clipboard.");
  expect(await copiedValues(page)).toEqual([mandateId]);
  expect(revealRequests).toBe(1);
  await expect(idField).toHaveAttribute("type", "password");
  await expect(idField).not.toHaveValue(mandateId);
  const payLink = page.getByRole("link", { name: "Open Pay page" });
  await expect(payLink).toHaveAttribute("href", "/pay");
  await page.getByRole("button", { name: "Show mandate", exact: true }).click();
  await expect(idField).toHaveAttribute("type", "text");
  await expect(idField).toHaveValue(mandateId);
  expect(revealRequests).toBe(2);
  await page.getByRole("button", { name: "Hide mandate", exact: true }).click();
  await expect(idField).toHaveAttribute("type", "password");
  await expect(idField).not.toHaveValue(mandateId);
  await expect(page.getByRole("button", { name: "Copy mandate ID" })).toBeVisible();
  expect(page.url()).not.toContain(mandateId);
});

test("newly created mandate is masked and has no separate payment credential", async ({ page }) => {
  await mockWorkspace(page);
  await mockClipboard(page);
  await page.route("**/api/mandates", async route => {
    expect(route.request().method()).toBe("POST");
    expect(route.request().postDataJSON()).not.toHaveProperty("currency");
    await route.fulfill({ status: 201, json: { mandate: { ...mandate, reference: "created-record" }, mandateId } });
  });
  await page.goto("/mandates");
  await expect(page.getByLabel("Payment method", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("combobox", { name: "Currency", exact: true })).toHaveCount(0);
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
  await expect(created.getByLabel("Payment page link")).toHaveValue("http://127.0.0.1:4030/pay");
  await created.getByRole("button", { name: "Copy mandate ID", exact: true }).click();
  await expect(created.getByRole("status")).toHaveText("Copied to clipboard.");
  expect(await copiedValues(page)).toEqual([mandateId]);
  await expect(idField).toHaveAttribute("type", "password");
  await expect(idField).not.toHaveValue(mandateId);
  const sourceField = created.getByLabel("Source Smart Account address", { exact: true });
  await expect(sourceField).toHaveAttribute("type", "password");
  await expect(sourceField).not.toHaveValue(account.address!);
  await created.getByRole("button", { name: "Copy Smart Account address", exact: true }).click();
  await expect(created.getByRole("status")).toHaveCount(2);
  expect(await copiedValues(page)).toEqual([mandateId, account.address]);
  await expect(sourceField).toHaveAttribute("type", "password");
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
    expect(body).not.toHaveProperty("rail");
    expect(body).not.toHaveProperty("accountId");
    expect(request.headers()).not.toHaveProperty("authorization");
    expect(request.headers()).not.toHaveProperty("cookie");
    submitted.push(new URL(request.url()).pathname);
    if (request.url().endsWith("/preview")) {
      await route.fulfill({ json: { mandate: { name: "Purchasing", address: account.address, limit: "10", spent: "0", expiresAt: mandate.expiresAt }, seller: { address: "C_DEMO_SELLER", name: "Seller", verified: true }, currency: "USD", balance: "100", checks: [{ label: "Payment is allowed", passed: true }] } });
    } else {
      await route.fulfill({ json: { status: "paid", payment: { id: "receipt", accountId: account.id, source: account.address, destination: "C_DEMO_SELLER", amount: "1", currency: "USD", kind: "payment", mandateReference: mandate.reference, reference: "Invoice", createdAt: "2026-11-14T12:00:00Z", settlement: "stellar-testnet", txHash: "test-tx", explorerUrl: "https://explorer.example/tx/test-tx" } } });
    }
  });
  await page.goto("/pay");
  const idField = page.getByLabel("Mandate ID", { exact: true });
  await expect(idField).toHaveAttribute("type", "password");
  await idField.fill(mandateId);
  await page.getByLabel("Seller name", { exact: true }).fill("Seller");
  await page.getByLabel("Seller Smart Account address", { exact: true }).fill("C_DEMO_SELLER");
  await page.getByLabel("Amount (USD)", { exact: true }).fill("1");
  await page.getByLabel("Payment reference", { exact: true }).fill("Invoice");
  await expect(page.getByRole("button", { name: /Show mandate|Hide mandate/ })).toHaveCount(0);
  await expect(page.getByLabel("Payment credential", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Make payment", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "Check mandate & seller" }).click();
  await expect(page.getByText("Payment is allowed")).toBeVisible();
  await expect(page.getByRole("button", { name: "Make payment", exact: true })).toBeEnabled();
  await expect(idField).toHaveAttribute("type", "password");
  await page.getByRole("button", { name: "Make payment", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Payment succeeded" })).toBeVisible();
  await expect(idField).toHaveAttribute("type", "password");
  await page.getByRole("button", { name: "Start another payment" }).click();
  await expect(idField).toHaveAttribute("type", "password");
  expect(submitted).toEqual(["/api/pay/preview", "/api/pay"]);
  expect(page.url()).not.toContain(mandateId);
});

test("dashboard exposes only USD and has no currency selector", async ({ page }) => {
  await mockWorkspace(page);
  await page.route("**/api/workspace", async route => {
    await route.fulfill({ json: { ...workspace, accounts: [{ ...account, balances: [{ currency: "USD", balance: "100" }, { currency: "XLM", balance: "2.5" }] }] } });
  });
  await page.goto("/");
  await expect(page.getByLabel("Smart Account address", { exact: true })).toHaveAttribute("type", "password");
  await expect(page.getByLabel("Smart Account address", { exact: true })).not.toHaveValue(account.address!);
  await expect(page.getByText(/XLM|Also available/)).toHaveCount(0);
  await expect(page.getByText("Demo account number", { exact: true })).toHaveCount(0);
  await expect(page.getByText(/Classic wallet|BANK_DEMO_/)).toHaveCount(0);
  await page.getByRole("button", { name: "Make payment", exact: true }).click();
  await expect(page.getByLabel("Recipient Smart Account address", { exact: true })).toBeVisible();
  await expect(page.getByRole("combobox", { name: "Currency", exact: true })).toHaveCount(0);
  await expect(page.getByLabel("Amount (USD)", { exact: true })).toBeVisible();
});

for (const type of ["traditional", "stellar"] as const) {
  test(`${type} Smart Account addresses copy while masked and reset after switching accounts`, async ({ page }) => {
    await mockWorkspace(page);
    await mockClipboard(page);
    const secondAddress = "C_SECOND_ACCOUNT";
    await page.route("**/api/workspace", async route => {
      await route.fulfill({ json: { ...workspace, accounts: [
        { ...account, type, rail: type === "traditional" ? "traditional" : "blockchain" },
        { ...account, id: "second", type, name: "Second", address: secondAddress },
      ] } });
    });
    await page.goto("/");
    const addressField = page.getByLabel("Smart Account address", { exact: true });
    await expect(addressField).toHaveAttribute("type", "password");
    await expect(addressField).not.toHaveValue(account.address!);
    await page.getByRole("button", { name: "Copy Smart Account address", exact: true }).click();
    await expect(page.getByRole("status")).toHaveText("Copied to clipboard.");
    expect(await copiedValues(page)).toEqual([account.address]);
    await expect(addressField).toHaveAttribute("type", "password");
    await expect(addressField).not.toHaveValue(account.address!);
    await page.getByRole("button", { name: "Show Smart Account address", exact: true }).click();
    await expect(addressField).toHaveAttribute("type", "text");
    await expect(addressField).toHaveValue(account.address!);
    await page.getByRole("button", { name: "Hide Smart Account address", exact: true }).click();
    await expect(addressField).toHaveAttribute("type", "password");
    await expect(addressField).not.toHaveValue(account.address!);
    await page.getByRole("button", { name: "Show Smart Account address", exact: true }).click();
    await page.getByRole("button", { name: /Second USD account/ }).click();
    await expect(addressField).toHaveAttribute("type", "password");
    await expect(addressField).not.toHaveValue(secondAddress);
    await page.getByRole("button", { name: "Copy Smart Account address", exact: true }).click();
    await expect(page.getByRole("status")).toHaveText("Copied to clipboard.");
    expect(await copiedValues(page)).toEqual([account.address, secondAddress]);
    await page.getByRole("button", { name: /Operations/ }).click();
    await expect(addressField).toHaveAttribute("type", "password");
  });
}

test("failed clipboard access never reveals a mandate ID", async ({ page }) => {
  await mockWorkspace(page);
  await mockClipboard(page, true);
  await page.route("**/api/mandates/owner-record-reference/reveal", async route => {
    await route.fulfill({ json: { mandateId } });
  });
  await page.goto("/mandates");
  await page.getByRole("button", { name: "Copy mandate ID", exact: true }).click();
  await expect(page.getByRole("alert")).toHaveText("Clipboard permission denied");
  const idField = page.getByLabel("Mandate ID", { exact: true });
  await expect(idField).toHaveAttribute("type", "password");
  await expect(idField).not.toHaveValue(mandateId);
  expect(await copiedValues(page)).toEqual([]);
});

test("new account confirmation masks and copies its Smart Account address", async ({ page }) => {
  await mockWorkspace(page);
  await mockClipboard(page);
  await page.route("**/api/accounts/open", async route => {
    expect(route.request().postDataJSON()).not.toHaveProperty("type");
    await route.fulfill({ status: 201, json: { account: { ...account, sellerId: 101 } } });
  });
  await page.goto("/accounts/new");
  await expect(page.getByRole("radio")).toHaveCount(0);
  await expect(page.getByText(/Traditional account|Stellar account/)).toHaveCount(0);
  await page.getByLabel("Account name", { exact: true }).fill("Operations");
  await page.getByRole("button", { name: "Open account", exact: true }).click();
  const addressField = page.getByLabel("Smart Account address", { exact: true });
  await expect(page.getByLabel("Seller ID", { exact: true })).toHaveCount(0);
  await expect(addressField).toHaveAttribute("type", "password");
  await expect(addressField).not.toHaveValue(account.address!);
  await page.getByRole("button", { name: "Copy Smart Account address", exact: true }).click();
  await expect(page.getByRole("status")).toHaveText("Copied to clipboard.");
  expect(await copiedValues(page)).toEqual([account.address]);
  await expect(addressField).toHaveAttribute("type", "password");
});

test("seller IDs are entered as numbers and saved with a mandate", async ({ page }) => {
  await mockWorkspace(page);
  let requests = 0;
  await page.route("**/api/mandates", async route => {
    requests++;
    const input = route.request().postDataJSON();
    expect(input.sellerIds).toEqual([101, 202, 303]);
    await route.fulfill({ status: 201, json: { mandate: { ...mandate, reference: "restricted", sellerIds: input.sellerIds }, mandateId } });
  });
  await page.goto("/mandates");
  const sellerIds = page.getByLabel("Seller IDs (optional)", { exact: true });
  await expect(sellerIds).toHaveAttribute("type", "text");
  await expect(page.getByRole("combobox", { name: /Seller/ })).toHaveCount(0);
  await page.getByLabel("Mandate name", { exact: true }).fill("Restricted purchasing");
  await page.getByLabel("Mandate holder", { exact: true }).fill("Buyer");
  await page.getByLabel("Spending limit (USD)", { exact: true }).fill("10");
  for (const invalid of ["seller", "1.5", "-1", "101,,202"]) {
    await sellerIds.fill(invalid);
    await page.getByRole("button", { name: "Create mandate", exact: true }).click();
    expect(await sellerIds.evaluate((input: HTMLInputElement) => input.validity.patternMismatch)).toBe(true);
    expect(requests).toBe(0);
  }
  await sellerIds.fill(" 101, 202 303 ");
  await page.getByRole("button", { name: "Create mandate", exact: true }).click();
  const created = page.locator(".mandate-form-card");
  await expect(created.getByText("Allowed seller IDs: 101, 202, 303", { exact: true })).toBeVisible();
  expect(requests).toBe(1);
  await created.getByRole("button", { name: "Done", exact: true }).click();
  await expect(page.getByLabel("Seller IDs (optional)", { exact: true })).toHaveValue("");
});

test("accounts hide internal seller IDs and saved mandate restrictions remain visible", async ({ page }) => {
  await mockWorkspace(page);
  await page.route("**/api/workspace", route => route.fulfill({ json: { ...workspace, accounts: [{ ...account, sellerId: 101 }], mandates: [{ ...mandate, sellerIds: [202, 303] }] } }));
  await page.goto("/");
  await expect(page.getByLabel("Seller ID", { exact: true })).toHaveCount(0);
  await expect(page.getByText(/seller ID/i)).toHaveCount(0);
  await page.goto("/mandates");
  await expect(page.getByText("Allowed seller IDs: 202, 303", { exact: true })).toBeVisible();
});
