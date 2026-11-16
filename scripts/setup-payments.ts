import { randomBytes } from "node:crypto";
import { readConfiguration, writeConfiguration } from "./config.ts";

const values = readConfiguration();
if (!values.PAYMENTS_ENCRYPTION_KEY) values.PAYMENTS_ENCRYPTION_KEY = randomBytes(32).toString("hex");
if (!/^[a-fA-F0-9]{64}$/.test(values.PAYMENTS_ENCRYPTION_KEY)) throw new Error("PAYMENTS_ENCRYPTION_KEY must be a 32-byte hex key");
writeConfiguration(values);
console.log("Configured .env. Existing contract settings and the encryption key are preserved; no secrets were printed.");
console.log("Run pnpm setup:contracts for a fresh deployment, then pnpm dev. Open an account in the dashboard and choose FIAT or Testnet when adding funds.");
