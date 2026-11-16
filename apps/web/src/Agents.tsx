import { useState, type FormEvent } from "react";
import type { AccountAgent } from "@mandate/shared";
import { api } from "./api.ts";
import { initials } from "./format.ts";
import { Dialog } from "./Dialog.tsx";
import { PlusIcon } from "./icons.tsx";

export function Agents({ agents, onDone }: { agents: AccountAgent[]; onDone: () => Promise<void> }) {
  const [creating, setCreating] = useState(false);
  return <section className="agents-section">
    <div className="section-header"><p className="muted">Agents identify who is paying. Any registered agent can use a mandate from this account.</p><button className="button is-primary" onClick={() => setCreating(true)}><PlusIcon /> Add agent</button></div>
    {agents.length === 0 ? <p className="card empty">No agents yet. Add an agent to get its identification value.</p> : <ul className="agent-grid">{agents.map(agent => <li className="card agent-card" key={agent.id}>
      <div className="agent-heading"><span className="account-letter" aria-hidden="true">{initials(agent.name)}</span><div><h2>{agent.name}</h2><span className={agent.verified ? "verified" : "form-error"}>{agent.verified ? "Verified on chain" : "Not verified on chain"}</span></div></div>
      <AgentIdentity agent={agent} />
      {agent.explorerUrl && <a className="transaction-link" href={agent.explorerUrl} target="_blank" rel="noreferrer">View registration on Stellar ↗</a>}
    </li>)}</ul>}
    {creating && <NewAgent onDone={onDone} onClose={() => setCreating(false)} />}
  </section>;
}

function AgentIdentity({ agent }: { agent: AccountAgent }) {
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState("");
  const copy = async () => {
    setError("");
    try { await navigator.clipboard.writeText(agent.id); setCopied(true); }
    catch { setError("Could not copy the identification value."); }
  };
  return <div className="agent-identity"><label className="field">Agent identification<input readOnly value={agent.id} /></label><button className="button" onClick={() => void copy()}>Copy identification</button>{copied && <p className="muted" role="status">Copied to clipboard.</p>}{error && <p role="alert" className="form-error">{error}</p>}</div>;
}

function NewAgent({ onDone, onClose }: { onDone: () => Promise<void>; onClose: () => void }) {
  const [name, setName] = useState("");
  const [requestId, setRequestId] = useState(() => crypto.randomUUID());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const submit = async (event: FormEvent) => {
    event.preventDefault(); setBusy(true); setError("");
    try { await api.createAgent({ name, requestId }); await onDone(); onClose(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Could not register the agent"); }
    finally { setBusy(false); }
  };
  return <Dialog title="Add agent" onClose={() => { if (!busy) onClose(); }}><form className="form" onSubmit={event => void submit(event)}>
    <label className="field">Agent name<input required autoFocus maxLength={120} disabled={busy} value={name} onChange={event => { setName(event.target.value); setRequestId(crypto.randomUUID()); }} placeholder="Travel booker" /></label>
    <p className="muted">An identification value will be registered to your account on chain. Give the agent this value and a mandate ID when it needs to pay.</p>
    {error && <p className="form-error" role="alert">{error}</p>}
    <div className="form-actions"><button className="button" type="button" disabled={busy} onClick={onClose}>Cancel</button><button className="button is-primary" disabled={busy}>{busy ? "Registering on Stellar…" : "Add agent"}</button></div>
  </form></Dialog>;
}
