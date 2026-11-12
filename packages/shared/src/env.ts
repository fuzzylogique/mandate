// Node-only helpers. Kept out of index.ts so the dashboard can import the shared types.

/** Read a required environment variable or fail with a clear message. */
export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing ${name}. Copy .env.example to .env and fill it in.`);
  }
  return value;
}
