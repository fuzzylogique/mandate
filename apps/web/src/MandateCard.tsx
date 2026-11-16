import type { CSSProperties, ReactNode } from "react";
import { toBaseUnits, formatAmount, type AccountMandate } from "@mandate/shared";
import { money } from "./format.ts";

export function MandateCard({ mandate, tone, children }: { mandate: AccountMandate; tone: number; children: ReactNode }) {
  const limit = BigInt(toBaseUnits(mandate.limit));
  const spent = BigInt(toBaseUnits(mandate.spent));
  const remaining = limit > spent ? limit - spent : 0n;
  const share = limit > 0n ? Number(remaining * 100n / limit) : 0;
  const active = mandate.status === "active";
  const style = { "--tone": `var(--tone-${tone % 3 + 1})`, "--share": `${active ? share : 0}%` } as CSSProperties;
  return <li className="glass mandate mandate-card" style={style}>
    <div className="mandate-gauge"><span className="ring" role="img" aria-label={`${share}% of the mandate limit remaining`} /><span className={`status ${active ? "is-on" : ""}`}>{mandate.chainRevocationPending ? "Revocation pending" : mandate.status}</span></div>
    <h3>{mandate.name}</h3>
    <p className="mandate-left">{money(formatAmount(remaining.toString()), mandate.currency ?? "USD")} <span className="mandate-left-word">left</span></p>
    <p className="quiet">of {money(mandate.limit, mandate.currency ?? "USD")} every {mandate.period === "month" ? "30 days" : mandate.period === "week" ? "7 days" : "24 hours"}</p>
    <div className="mandate-details">{children}</div>
  </li>;
}
