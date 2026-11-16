import { expect, test } from "@playwright/test";
import type { PaymentChatState } from "@mandate/shared";

const initial: PaymentChatState = {
  sessionId: "chat-browser-session", requestId: "chat-payment-request", agentId: "agt_default_chat",
  mandate: { reference: "chat-mandate-reference", name: "Chat mandate", limit: "1", period: "day", expiresAt: "2099-12-31T23:59:59Z", status: "active" },
  turns: 0, reply: "", busy: false, complete: false, paymentAttempted: false,
};

test("chat uses the signed-in defaults, supports clarification and finishes one payment", async ({ page, context }) => {
  await context.addCookies([{ name: "mandate_session", value: "owner-session", domain: "127.0.0.1", path: "/api" }]);
  let sent = 0;
  await page.route("**/api/chat/sessions", async route => {
    expect(route.request().headers().cookie).toContain("mandate_session=owner-session");
    await route.fulfill({ status: 201, json: initial });
  });
  await page.route("**/api/chat/sessions/*/messages", async route => {
    sent++;
    expect(route.request().headers()).not.toHaveProperty("cookie");
    expect(route.request().postDataJSON()).not.toHaveProperty("agentId");
    if (sent === 1) {
      expect(route.request().postDataJSON().message).toBe("Pay with mnd_browser_secret");
      return route.fulfill({ json: { ...initial, turns: 1, reply: "What seller should I pay?" } });
    }
    await route.fulfill({ json: {
      ...initial, turns: 2, reply: "Payment succeeded.", complete: true, paymentAttempted: true,
      paymentResult: { status: "paid", payment: { id: "payment-001", amount: "0.20", currency: "USD", explorerUrl: "https://explorer.example/tx/payment-001" } },
    } });
  });
  await page.goto("/chat");
  await expect(page.getByRole("heading", { name: "Chat to pay." })).toBeVisible();
  const input = page.getByRole("textbox", { name: "Message", exact: true });
  await input.fill("Pay with mnd_browser_secret");
  await input.press("Enter");
  await expect(page.getByText("What seller should I pay?", { exact: true })).toBeVisible();
  await expect(page.getByRole("log")).toContainText("Pay with [mandate hidden]");
  await expect(page.getByRole("log")).not.toContainText("mnd_browser_secret");
  await expect(page.getByText("Your chat agent:")).toContainText(initial.agentId!);
  await expect(page.getByText(/Chat mandate · 1 USD per 24 hours/)).toBeVisible();
  await expect(input).toBeFocused();
  await input.fill("Pay 0.20 USD to seller C…");
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Payment succeeded", exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "View transaction on Stellar" })).toHaveAttribute("href", "https://explorer.example/tx/payment-001");
  await expect(input).toBeDisabled();
  expect(sent).toBe(2);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: test.info().outputPath("chat-desktop.png"), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "Switch to light mode" }).click();
  await page.evaluate(() => window.scrollTo(0, 0));
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: test.info().outputPath("chat-mobile-light.png"), fullPage: true });
  await page.getByRole("button", { name: "New chat", exact: true }).click();
  await expect(input).toBeEnabled();
  await expect(page.getByRole("log")).not.toContainText("What seller should I pay?");
});

test("a dropped response is retrieved without resending the payment message", async ({ page }) => {
  let submissions = 0;
  await page.route("**/api/chat/sessions", route => route.fulfill({ status: 201, json: initial }));
  await page.route("**/api/chat/sessions/*/messages", async route => { submissions++; await route.abort("failed"); });
  await page.route("**/api/chat/sessions/chat-browser-session", route => route.fulfill({ json: {
    ...initial, turns: 1, complete: true, paymentAttempted: true, reply: "Payment is awaiting confirmation.",
    paymentResult: { status: "pending", reason: "Awaiting network confirmation", txHash: "pending-tx" },
  } }));
  await page.goto("/chat");
  await page.getByRole("textbox", { name: "Message", exact: true }).fill("Pay 0.20 USD to seller C…");
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await expect(page.getByRole("button", { name: "Check response", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Send message", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "Check response", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Awaiting confirmation", exact: true })).toBeVisible();
  await expect(page.getByText(/Payment request ID:/)).toContainText(initial.requestId);
  expect(submissions).toBe(1);
});

test("missing model configuration preserves the unsent prompt", async ({ page }) => {
  await page.route("**/api/chat/sessions", route => route.fulfill({ status: 503, json: { error: "Set GEMINI_API_KEY in .env and restart the API." } }));
  await page.goto("/chat");
  const input = page.getByRole("textbox", { name: "Message", exact: true });
  await input.fill("Pay 0.20 USD");
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Set GEMINI_API_KEY");
  await expect(input).toHaveValue("Pay 0.20 USD");
  await expect(page.getByRole("button", { name: "Send message", exact: true })).toBeEnabled();
});

test("expired response recovery allows a new chat and keeps the old request ID visible", async ({ page }) => {
  await page.route("**/api/chat/sessions", route => route.fulfill({ status: 201, json: initial }));
  await page.route("**/api/chat/sessions/*/messages", route => route.abort("failed"));
  await page.route("**/api/chat/sessions/chat-browser-session", route => route.fulfill({ status: 404, json: { error: "This chat has expired. Keep the original request ID." } }));
  await page.goto("/chat");
  await page.getByRole("textbox", { name: "Message", exact: true }).fill("Pay 0.20 USD");
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await page.getByRole("button", { name: "Check response", exact: true }).click();
  await expect(page.getByRole("button", { name: "New chat", exact: true })).toBeEnabled();
  await expect(page.getByText(/Payment request ID:/)).toContainText(initial.requestId);
});
