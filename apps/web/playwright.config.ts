import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  workers: 1,
  use: { baseURL: "http://127.0.0.1:4030", browserName: "chromium", trace: "retain-on-failure" },
  webServer: { command: "pnpm dev --host 127.0.0.1 --port 4030", url: "http://127.0.0.1:4030", reuseExistingServer: false },
});
