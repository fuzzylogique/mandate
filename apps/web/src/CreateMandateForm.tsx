import { useState, type FormEvent } from "react";
import type { AccountMandate, PaymentWorkspace, SpendingAccount, SpendingPeriod } from "@mandate/shared";
import { money } from "./format.ts";
import { api } from "./api.ts";
import { MandateDetails } from "./MandateDetails.tsx";

export function CreateMandateForm({ workspace, onDone }: { workspace: PaymentWorkspace; onDone: () => Promise<void> }) {
  const [accountId, setAccountId] = useState(() => workspace.accounts.find(a => a.verified)?.id ?? "");
  const [name, setName] = useState("");
  const [holder, setHolder] = useState("");
  const [limit, setLimit] = useState("");
  const [sellerIds, setSellerIds] = useState("");
  const [period, setPeriod] = useState<SpendingPeriod>("day");
  const [expiry, setExpiry] = useState(() => new Date(Date.now() + 30 * 86400_000).toISOString().slice(0, 10));
  const [requestId, setRequestId] = useState(() => crypto.randomUUID());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [created, setCreated] = useState<{ mandate: AccountMandate; mandateId: string; account: SpendingAccount } | null>(null);
  const eligible = workspace.accounts.filter(a => a.verified);
  const account = eligible.find(a => a.id === accountId) ?? eligible[0];
  const change = (update: () => void) => { update(); setRequestId(crypto.randomUUID()); };
  const submit = async (event: FormEvent) => {
    event.preventDefault(); if (!account) return;
    setBusy(true); setError("");
    try {
      const result = await api.createMandate({ accountId: account.id, name, recipientType: "agent", recipient: holder, limit, sellerIds: sellerIds.trim() ? sellerIds.trim().split(/[\s,]+/).map(Number) : [], period, expiresAt: new Date(`${expiry}T23:59:59`).toISOString(), requestId });
      setCreated({ mandate: result.mandate, mandateId: result.mandateId, account });
      await onDone();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not create the mandate"); }
    finally { setBusy(false); }
  };
  if (created) return <section className="card mandate-form-card"><h2 className="form-card-title">Mandate created</h2><MandateDetails {...created} onClose={() => { setCreated(null); setName(""); setHolder(""); setLimit(""); setSellerIds(""); setRequestId(crypto.randomUUID()); }} /></section>;
  return <section className="card mandate-form-card"><h2 className="form-card-title">Create a mandate</h2><form className="form" onSubmit={event => void submit(event)}>
    <label className="field">Source account<select required value={account?.id ?? ""} disabled={busy || eligible.length === 0} onChange={event => change(() => { setAccountId(event.target.value); })}>{eligible.length === 0 && <option value="">No verified accounts yet</option>}{eligible.map(source => <option key={source.id} value={source.id}>{source.name} · {money(source.balance, source.currency)}</option>)}</select></label>
    {eligible.length === 0 && <p className="form-note">Open a verified account first. <a href="/accounts/new">Open an account ↗</a></p>}
    <label className="field">Mandate name<input required maxLength={120} value={name} disabled={busy} onChange={event => change(() => setName(event.target.value))} placeholder="Team purchasing allowance" /></label>
    <label className="field">Mandate holder<input required maxLength={120} value={holder} disabled={busy} onChange={event => change(() => setHolder(event.target.value))} placeholder="A person, team, or agent" /></label>
    <label className="field">Seller IDs (optional)<input type="text" maxLength={2000} pattern={"\\s*[0-9]+(?:(?:\\s*,\\s*|\\s+)[0-9]+)*\\s*"} title="Enter seller IDs as positive whole numbers, separated by commas or spaces" value={sellerIds} disabled={busy} onChange={event => change(() => setSellerIds(event.target.value))} placeholder="101, 202, 303" aria-describedby="seller-ids-help" /></label>
    <p className="form-note" id="seller-ids-help">Enter up to 100 seller IDs, separated by commas or spaces. Payments will only go to these sellers. Leave blank to allow any verified seller. Sellers are verified when a payment is checked or made.</p>
    <label className="field">Spending limit (USD)<input required inputMode="decimal" pattern="[0-9]+(\.[0-9]{1,7})?" value={limit} disabled={busy} onChange={event => change(() => setLimit(event.target.value))} placeholder="10.00" /></label>
    <div className="field-row"><label className="field">Rolling window<select value={period} disabled={busy} onChange={event => change(() => setPeriod(event.target.value as SpendingPeriod))}><option value="day">24 hours</option><option value="week">7 days</option><option value="month">30 days</option></select></label><label className="field">Expires on<input required type="date" min={new Date().toISOString().slice(0, 10)} value={expiry} disabled={busy} onChange={event => change(() => setExpiry(event.target.value))} /></label></div>
    <p className="form-note">The mandate spends from the selected account. Its limit, expiry, and verified recipients are enforced on Stellar testnet.</p>
    <p className="muted">A mandate grants access to this account's existing balance. Creating it does not open another account.</p>
    {error && <p className="form-error" role="alert">{error}</p>}
    <div className="form-actions"><button className="button is-primary" disabled={busy || !account}>{busy ? "Creating mandate…" : "Create mandate"}</button></div>
  </form></section>;
}
