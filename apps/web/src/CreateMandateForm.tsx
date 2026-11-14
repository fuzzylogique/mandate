import { useState, type FormEvent } from "react";
import type { AccountMandate, PaymentWorkspace, SpendingAccount, SpendingPeriod } from "@mandate/shared";
import { api } from "./api.ts";
import { MandateCredentials } from "./MandateCredentials.tsx";

export function CreateMandateForm({ workspace, onDone }: { workspace: PaymentWorkspace; onDone: () => Promise<void> }) {
  const [rail, setRail] = useState<"traditional" | "blockchain">("traditional");
  const [accountId, setAccountId] = useState(() => workspace.accounts.find(a => a.rail === "traditional" && a.verified)?.id ?? "");
  const [name, setName] = useState("");
  const [holder, setHolder] = useState("");
  const [limit, setLimit] = useState("");
  const [period, setPeriod] = useState<SpendingPeriod>("day");
  const [expiry, setExpiry] = useState(() => new Date(Date.now() + 30 * 86400_000).toISOString().slice(0, 10));
  const [requestId, setRequestId] = useState(() => crypto.randomUUID());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [created, setCreated] = useState<{ mandate: AccountMandate; token: string; account: SpendingAccount } | null>(null);
  const traditional = rail === "traditional";
  const eligible = workspace.accounts.filter(a => a.rail === rail && a.verified);
  const account = eligible.find(a => a.id === accountId) ?? eligible[0];
  const change = (update: () => void) => { update(); setRequestId(crypto.randomUUID()); };
  const submit = async (event: FormEvent) => {
    event.preventDefault(); if (!account) return;
    setBusy(true); setError("");
    try {
      const result = await api.createMandate({ accountId: account.id, rail, name, recipientType: "agent", recipient: holder, limit, period, expiresAt: new Date(`${expiry}T23:59:59`).toISOString(), requestId });
      if (!result.token) throw new Error("No payment credential was returned");
      setCreated({ mandate: result.mandate, token: result.token, account });
      await onDone();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not create the mandate"); }
    finally { setBusy(false); }
  };
  if (created) return <section className="card mandate-form-card"><h2 className="form-card-title">Mandate created</h2><MandateCredentials {...created} onClose={() => { setCreated(null); setName(""); setHolder(""); setLimit(""); setRequestId(crypto.randomUUID()); }} /></section>;
  return <section className="card mandate-form-card"><h2 className="form-card-title">Create a mandate</h2><form className="form" onSubmit={event => void submit(event)}>
    <label className="field">Payment method<select value={rail} disabled={busy} onChange={event => change(() => { const next = event.target.value as typeof rail; setRail(next); setAccountId(workspace.accounts.find(a => a.rail === next && a.verified)?.id ?? ""); })}><option value="traditional">Traditional payment · demo banking</option><option value="blockchain" disabled={!workspace.network?.mandates}>Stellar account payment · blockchain</option></select></label>
    <label className="field">Source account<select required value={account?.id ?? ""} disabled={busy || eligible.length === 0} onChange={event => change(() => setAccountId(event.target.value))}>{eligible.length === 0 && <option value="">No verified {traditional ? "traditional" : "Stellar"} accounts yet</option>}{eligible.map(source => <option key={source.id} value={source.id}>{source.name} · {source.balance} {source.currency}</option>)}</select></label>
    {eligible.length === 0 && <p className="form-note">Open a verified {traditional ? "traditional" : "Stellar"} account first. <a href="/accounts/new">Open an account ↗</a></p>}
    <label className="field">Mandate name<input required maxLength={120} value={name} disabled={busy} onChange={event => change(() => setName(event.target.value))} placeholder="Team purchasing allowance" /></label>
    <label className="field">Mandate holder<input required maxLength={120} value={holder} disabled={busy} onChange={event => change(() => setHolder(event.target.value))} placeholder="A person, team, or agent" /></label>
    <label className="field">Spending limit ({account?.currency ?? (traditional ? "USD" : workspace.network?.currency)})<input required inputMode="decimal" pattern={traditional ? "[0-9]+(\\.[0-9]{1,2})?" : "[0-9]+(\\.[0-9]{1,7})?"} value={limit} disabled={busy} onChange={event => change(() => setLimit(event.target.value))} placeholder="10.00" /></label>
    <div className="field-row"><label className="field">{traditional ? "Resets every" : "Rolling window"}<select value={period} disabled={busy} onChange={event => change(() => setPeriod(event.target.value as SpendingPeriod))}><option value="day">24 hours</option><option value="week">7 days</option><option value="month">30 days</option></select></label><label className="field">Expires on<input required type="date" min={new Date().toISOString().slice(0, 10)} value={expiry} disabled={busy} onChange={event => change(() => setExpiry(event.target.value))} /></label></div>
    <p className="form-note">{traditional ? "This mandate makes simulated payments to verified traditional accounts. The service checks its limit, expiry, and balance. No bank transfer is submitted." : "This mandate uses the selected Stellar account. The contract checks its limit, expiry, and verified Stellar account recipients."}</p>
    <p className="muted">A mandate grants access to this account's existing balance. Creating it does not open another account.</p>
    {error && <p className="form-error" role="alert">{error}</p>}
    <div className="form-actions"><button className="button is-primary" disabled={busy || !account}>{busy ? traditional ? "Creating demo mandate…" : "Creating on Stellar…" : "Create mandate"}</button></div>
  </form></section>;
}
