// The company and team this workspace buys for.
import { useState, type FormEvent } from "react";
import type { Customer } from "@mandate/shared";
import { api } from "./api.ts";
import { Dialog } from "./Dialog.tsx";

export function EditProfile({ customer, onDone, onClose }: { customer: Customer; onDone: () => Promise<void>; onClose: () => void }) {
  const [company, setCompany] = useState(customer.company ?? "");
  const [team, setTeam] = useState(customer.team ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const submit = async (event: FormEvent) => {
    event.preventDefault(); setBusy(true); setError("");
    try { await api.updateProfile({ company, team }); await onDone(); onClose(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Could not save your team"); }
    finally { setBusy(false); }
  };
  return <Dialog title="Your team" onClose={() => { if (!busy) onClose(); }}><form className="form" onSubmit={event => void submit(event)}>
    <label className="field">Company<input autoFocus maxLength={80} disabled={busy} value={company} onChange={event => setCompany(event.target.value)} placeholder="Larkfield Logistics" /></label>
    <label className="field">Team<input maxLength={80} disabled={busy} value={team} onChange={event => setTeam(event.target.value)} placeholder="Operations" /></label>
    <p className="muted">Shown on your workspace and in the instructions your agents get.</p>
    {error && <p className="form-error" role="alert">{error}</p>}
    <div className="form-actions"><button className="button" type="button" disabled={busy} onClick={onClose}>Cancel</button><button className="button is-primary" disabled={busy}>{busy ? "Saving…" : "Save"}</button></div>
  </form></Dialog>;
}
