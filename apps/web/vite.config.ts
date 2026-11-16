import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const proxy = { "/api": "http://127.0.0.1:4022" };
// Lets judges open the dashboard through a Cloudflare quick tunnel to vite preview.
const allowedHosts = [".trycloudflare.com"];

export default defineConfig({
  plugins: [react()],
  server: { port: 4020, strictPort: true, proxy, allowedHosts },
  preview: { port: 4030, strictPort: true, proxy, allowedHosts },
});
