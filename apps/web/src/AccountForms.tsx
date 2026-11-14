import { useState, type FormEvent, type ReactNode } from "react";
import type { AccountMandate, SpendingAccount } from "@mandate/shared";
import { api } from "./api.ts";
import { Dialog } from "./Dialog.tsx";

export type AccountAction = { kind: "fund"; account: SpendingAccount } | { kind: "pay"; account: SpendingAccount; mandate?: AccountMandate };
interface Props { action: AccountAction; onDone: () => Promise<void>; onClose: () => void }
function Field({ label, children }: { label: string; children: ReactNode }) { return <label className="field">{label}{children}</label>; }

export function AccountForms({ action, onDone, onClose }: Props) {
  const [amount, setAmount] = useState("");
  const [recipient, setRecipient] = useState("");
  const [reference, setReference] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [requestId, setRequestId] = useState(() => crypto.randomUUID());
  const account = action.account;
  const traditional = account.rail === "traditional";
  const grant = action.kind === "pay" ? action.mandate : undefined;
  const title = action.kind === "fund" ? "Add funds" : traditional ? "Make a traditional demo payment" : "Make a Stellar payment";
  const change = (update: () => void) => { update(); setRequestId(crypto.randomUUID()); };
  const submit = async (event: FormEvent) => {
    event.preventDefault(); setBusy(true); setError("");
    try {
      if (action.kind === "fund") await api.fund(account.id, amount, requestId);
      else await api.pay({ accountId: account.id, mandateId: grant?.id, amount, destination: recipient, reference, requestId });
      await onDone(); onClose();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Request failed"); }
    finally { setBusy(false); }
  };
  return <Dialog title={title} onClose={() => { if (!busy) onClose(); }}>
    <form className="form" onSubmit={event => void submit(event)}>
      <p className="muted">{account.name} · {account.currency} · {traditional ? "Traditional account" : "Stellar account"}</p>
      {action.kind === "fund" ? <p className="form-note">{traditional ? "Add simulated USD to this account." : "Add testnet XLM to your Stellar account. Funding completes automatically."}</p> : <>
        {grant && <p className="form-note">{grant.name}: {grant.spent} of {grant.limit} {account.currency} used. Only verified recipients are allowed.</p>}
        <Field label={traditional ? "Traditional recipient reference" : "Recipient Stellar account ID"}><input required maxLength={traditional ? 128 : 56} value={recipient} disabled={busy} onChange={event => change(() => setRecipient(event.target.value))} placeholder={traditional ? "BANK_DEMO_… or DEMO-…" : "C…"} /></Field>
        <Field label="Payment reference"><input required maxLength={200} value={reference} disabled={busy} onChange={event => change(() => setReference(event.target.value))} /></Field>
      </>}
      <Field label={`Amount (${account.currency})`}><input required inputMode="decimal" pattern={traditional ? "[0-9]+(\\.[0-9]{1,2})?" : "[0-9]+(\\.[0-9]{1,7})?"} value={amount} disabled={busy} onChange={event => change(() => setAmount(event.target.value))} placeholder="0.00" /></Field>
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="form-actions"><button type="button" className="button" disabled={busy} onClick={onClose}>Cancel</button><button className="button is-primary" disabled={busy}>{busy ? traditional ? "Saving demo…" : "Confirming on Stellar…" : action.kind === "pay" ? "Confirm payment" : "Add funds"}</button></div>
    </form>
  </Dialog>;
}
