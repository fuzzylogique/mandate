import { useState, type FormEvent } from "react";
import { api } from "./api.ts";

export function SignIn({ onSignedIn }: { onSignedIn: () => Promise<void> }) {
  const [registering, setRegistering] = useState(false);
  const [name, setName] = useState("");
  const [company, setCompany] = useState("");
  const [team, setTeam] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async (event: FormEvent) => {
    event.preventDefault(); setBusy(true); setError("");
    try { if (registering) await api.register({ name, email, password, ...(company.trim() ? { company } : {}), ...(team.trim() ? { team } : {}) }); else await api.login({ email, password }); await onSignedIn(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Could not sign in"); }
    finally { setBusy(false); }
  };
  return <main className="auth-layout"><section className="auth-intro"><span className="eyebrow">PURCHASING AGENTS WITH LIMITS</span><h1>Your team's buying.<br />Run by agents.<br />Inside your rules.</h1><p className="muted">Set up a purchasing workflow in a minute: what an agent buys, which vendors it may use and its budget. Every payment is checked on Stellar, and every one leaves a receipt.</p><div className="auth-model"><span>Set up a purchasing workflow</span><span aria-hidden="true">↓</span><span>Connect an agent with its own key</span><span aria-hidden="true">↓</span><span>Limits and vendors enforced on Stellar</span></div></section><section className="card auth-card"><h2>{registering ? "Create your account" : "Welcome back"}</h2><p className="muted">{registering ? "Your account is set up automatically when you sign up." : "Sign in with your email and password."}</p><form className="form" onSubmit={e => void submit(e)}>{registering && <label className="field">Your name<input required autoComplete="name" maxLength={120} value={name} onChange={e => setName(e.target.value)} /></label>}{registering && <div className="field-row"><label className="field">Company (optional)<input autoComplete="organization" maxLength={80} value={company} onChange={e => setCompany(e.target.value)} /></label><label className="field">Team (optional)<input maxLength={80} value={team} onChange={e => setTeam(e.target.value)} placeholder="Operations" /></label></div>}<label className="field">Email<input type="email" required autoComplete="email" maxLength={254} value={email} onChange={e => setEmail(e.target.value)} /></label><label className="field">Password<input type="password" required minLength={registering ? 12 : undefined} maxLength={256} autoComplete={registering ? "new-password" : "current-password"} value={password} onChange={e => setPassword(e.target.value)} /></label>{registering && <p className="muted">Use at least 12 characters.</p>}{error && <p className="form-error" role="alert">{error}</p>}<button className="button is-primary" disabled={busy}>{busy ? registering ? "Setting up your account…" : "Signing in…" : registering ? "Create account" : "Sign in"}</button><button type="button" className="button is-quiet" disabled={busy} onClick={() => { setRegistering(!registering); setError(""); }}>{registering ? "Already have an account? Sign in" : "New here? Create an account"}</button></form><p className="workspace-note">Demo USD payments settle on Stellar testnet.</p></section></main>;
}

