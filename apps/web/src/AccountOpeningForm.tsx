import { useState, type FormEvent } from "react";
import type { PaymentWorkspace, SpendingAccount } from "@mandate/shared";
import { SmartAccountAddress } from "./SmartAccountAddress.tsx";
import { api } from "./api.ts";

export function AccountOpeningForm({ workspace, onDone, onClose }: {
  workspace: PaymentWorkspace; onDone: () => Promise<void>; onClose?: () => void;
}) {
  const [name, setName] = useState("");
  const [requestId, setRequestId] = useState(() => crypto.randomUUID());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [opened, setOpened] = useState<SpendingAccount | null>(null);
  const change = (update: () => void) => { update(); setRequestId(crypto.randomUUID()); };
  const submit = async (event: FormEvent) => {
    event.preventDefault(); setBusy(true); setError("");
    try {
      const result = await api.openAccount({ name, requestId });
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
    <label className="field">Account name<input required maxLength={120} disabled={busy} value={name} onChange={event => change(() => setName(event.target.value))} placeholder="Operations" /></label>
    <div className="account-opening-summary"><div><span className="muted">Currency</span><strong>USD · demo funds</strong></div><div><span className="muted">Recipient status after opening</span><strong className="verified">Verified</strong></div></div>
    <p className="form-note">Your account starts at zero. Choose FIAT or Testnet when you add funds, then pay any verified Smart Account.</p>
    <p className="muted">Your login holds no funds. Create spending permissions separately in the Mandates tab.</p>
    {error && <p className="form-error" role="alert">{error}</p>}
    <div className="form-actions">{onClose && <button type="button" className="button" disabled={busy} onClick={onClose}>Cancel</button>}<button className="button is-primary" disabled={busy || !workspace.network?.verifiedSmartAccounts}>{busy ? "Opening account…" : "Open account"}</button></div>
  </form>;
}
