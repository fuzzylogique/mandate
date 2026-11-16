import { amount, requireThat } from "./store.ts";

/** Validate the USD amount passed directly to the funding provider. */
export function fundingAmount(value: unknown): bigint {
  const units = amount(value);
  requireThat(typeof value === "string" && /^\d{1,12}(\.\d{1,2})?$/.test(value), 400, "Demo USD deposits accept up to two decimal places");
  requireThat(units <= 1_000_000n * 10_000_000n, 400, "Maximum demo deposit is 1,000,000 USD");
  return units;
}
