import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const proxy = { "/api": "http://127.0.0.1:4022" };
// The public hosts vite preview answers: a Cloudflare quick tunnel, or the Fly.io deployment.
const allowedHosts = [".trycloudflare.com", ".fly.dev"];

export default defineConfig({
  plugins: [react()],
  server: { port: 4020, strictPort: true, proxy, allowedHosts },
  preview: { port: 4030, strictPort: true, proxy, allowedHosts },
});
