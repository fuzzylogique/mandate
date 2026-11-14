import { existsSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { parseEnv } from "node:util";

const envPath = new URL("../.env", import.meta.url);
const templatePath = new URL("../.env.example", import.meta.url);

export function readConfiguration(): Record<string, string> {
  const defaults = parseEnv(readFileSync(templatePath, "utf8"));
  const merged = { ...defaults, ...(existsSync(envPath) ? parseEnv(readFileSync(envPath, "utf8")) : {}) };
  return Object.fromEntries(Object.entries(merged).filter((entry): entry is [string, string] => entry[1] !== undefined));
}

/** Persist only supported settings and never print secret values. */
export function writeConfiguration(values: Record<string, string>): void {
  const template = readFileSync(templatePath, "utf8");
  const output = template.replace(/^([A-Z_0-9]+)=(.*)$/gm, (_line, name: string, fallback: string) => {
    const value = values[name] ?? fallback;
    if (/[\r\n]/.test(value)) throw new Error(`Invalid multiline setting: ${name}`);
    return `${name}=${value}`;
  });
  writeFileSync(envPath, output, { mode: 0o600 });
  chmodSync(envPath, 0o600);
}
