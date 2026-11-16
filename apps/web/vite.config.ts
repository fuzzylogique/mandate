import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// /api goes to the Mandate service, so the browser sees one origin and the
// session cookie works without CORS.
const api = process.env.MANDATE_API_URL || "http://127.0.0.1:4022";

export default defineConfig({
  plugins: [react()],
  server: { port: Number(process.env.WEB_PORT ?? 4020), strictPort: true, proxy: { "/api": api } },
});
