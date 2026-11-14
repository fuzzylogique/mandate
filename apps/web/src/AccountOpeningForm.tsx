import { useState, type FormEvent } from "react";
import type { PaymentWorkspace, SpendingAccount } from "@mandate/shared";
import { SmartAccountAddress } from "./SmartAccountAddress.tsx";
import { api } from "./api.ts";

export function AccountOpeningForm({ workspace, onDone, onClose }: {
  workspace: PaymentWorkspace; onDone: () => Promise<void>; onClose?: () => void;
}) {
  const [type, setType] = useState<"traditional" | "stellar">("traditional");
  const [name, setName] = useState("");
  const [requestId, setRequestId] = useState(() => crypto.randomUUID());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [opened, setOpened] = useState<SpendingAccount | null>(null);
  const traditional = type === "traditional";
  const stellar = type === "stellar";
  const change = (update: () => void) => { update(); setRequestId(crypto.randomUUID()); };
  const submit = async (event: FormEvent) => {
    event.preventDefault(); setBusy(true); setError("");
    try {
      const result = await api.openAccount({ name, type, requestId });
      setOpened(result.account); await onDone();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not open the account"); }
    finally { setBusy(false); }
  };
  if (opened) return <div className="form opening-success">
    <span className="account-letter">✓</span><h2>{opened.name} is ready.</h2>
    <p className="verified">Verified recipient · Stellar testnet</p>
    <p className="muted">Add funds to start making payments.</p>
    <SmartAccountAddress address={opened.address ?? opened.id} />
    <div className="form-actions"><button className="button" onClick={() => { setOpened(null); setName(""); setRequestId(crypto.randomUUID()); }}>Open another account</button>{onClose ? <button className="button is-primary" onClick={onClose}>Done</button> : <a className="button is-primary" href={`/?account=${encodeURIComponent(opened.id)}`}>View account</a>}</div>
  </div>;
  return <form className="form account-opening-form" onSubmit={event => void submit(event)}>
    <fieldset className="field"><legend>Account type</legend><div className="opening-choices two-choices">
      <label className={`opening-choice ${traditional ? "is-selected" : ""}`}><input type="radio" name="account-type" checked={traditional} disabled={busy || !workspace.network?.verifiedSmartAccounts} onChange={() => change(() => setType("traditional"))} /><span><strong>Traditional account</strong><span>Add demo USD and send dollar payments.</span><small>Demo USD · Stellar testnet</small></span></label>
      <label className={`opening-choice ${stellar ? "is-selected" : ""}`}><input type="radio" name="account-type" checked={stellar} disabled={busy || !workspace.network?.verifiedSmartAccounts} onChange={() => change(() => setType("stellar"))} /><span><strong>Stellar account</strong><span>Send and receive payments with one Stellar account ID.</span><small>Stellar testnet · verified recipient</small></span></label>
    </div></fieldset>
    <label className="field">Account name<input required maxLength={120} disabled={busy} value={name} onChange={event => change(() => setName(event.target.value))} placeholder={traditional ? "Operations bank account" : "Stellar payments"} /></label>
    <div className="account-opening-summary"><div><span className="muted">Currency</span><strong>USD · demo funds</strong></div><div><span className="muted">Recipient status after opening</span><strong className="verified">Verified</strong></div></div>
    <p className="form-note">{traditional ? "Your account starts at zero. Add demo USD, then pay any verified Smart Account." : "Your Stellar account starts with a zero payment balance. Use Add funds to top it up, then pay any verified Smart Account."}</p>
    <p className="muted">Your login holds no funds. Create spending permissions separately in the Mandates tab.</p>
    {error && <p className="form-error" role="alert">{error}</p>}
    <div className="form-actions">{onClose && <button type="button" className="button" disabled={busy} onClick={onClose}>Cancel</button>}<button className="button is-primary" disabled={busy || !workspace.network?.verifiedSmartAccounts}>{busy ? "Opening account…" : "Open account"}</button></div>
  </form>;
}
