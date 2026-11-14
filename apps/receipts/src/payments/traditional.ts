import { formatAmount, toBaseUnits } from "@mandate/shared";
import { WorkspaceStore, amount, requireThat } from "./store.ts";

/** Demo fiat only. The gateway issues USD on testnet; no bank or real dollars are involved. */
export function bankingAmount(value: unknown): bigint {
  const units = amount(value);
  requireThat(typeof value === "string" && /^\d{1,12}(\.\d{1,2})?$/.test(value), 400, "Demo USD deposits accept up to two decimal places");
  requireThat(units <= 1_000_000n * 10_000_000n, 400, "Maximum demo credit is 1,000,000 USD");
  return units;
}

/** Persistent fiat-side journal for the demo anchor's 1 USD : 1 demo USD token issuance. */
export class DemoUsdAnchor {
  private core: WorkspaceStore;
  constructor(core: WorkspaceStore) { this.core = core; }

  credit(id: string, accountId: string, units: bigint) {
    const value = formatAmount(units.toString());
    this.core.update(state => {
      const deposits = state.anchorDeposits ??= [];
      const previous = deposits.find(deposit => deposit.id === id);
      requireThat(!previous || (previous.accountId === accountId && previous.amount === value), 409, "Anchor request was used with different details");
      if (previous) return;
      const accounts = state.fiatAccounts ??= [];
      let account = accounts.find(account => account.accountId === accountId);
      if (!account) { account = { accountId, balance: "0" }; accounts.push(account); }
      account.balance = formatAmount((BigInt(toBaseUnits(account.balance)) + units).toString());
      deposits.push({ id, accountId, amount: value, status: "credited" });
    });
  }

  anchored(id: string, txHash: string) {
    this.core.update(state => {
      const deposit = state.anchorDeposits?.find(deposit => deposit.id === id);
      requireThat(deposit, 409, "Demo fiat deposit is missing");
      if (deposit.status !== "credited") return;
      const account = state.fiatAccounts!.find(account => account.accountId === deposit.accountId)!;
      const remaining = BigInt(toBaseUnits(account.balance)) - BigInt(toBaseUnits(deposit.amount));
      requireThat(remaining >= 0n, 409, "Insufficient demo fiat balance for the anchor");
      account.balance = formatAmount(remaining.toString());
      deposit.depositTxHash = txHash;
      deposit.status = "anchored";
    });
  }

  completed(id: string, txHash: string) {
    this.core.update(state => {
      const deposit = state.anchorDeposits?.find(deposit => deposit.id === id);
      requireThat(deposit && deposit.status !== "credited", 409, "Anchor deposit has not confirmed");
      deposit.forwardingTxHash = txHash;
      deposit.status = "completed";
    });
  }
}
