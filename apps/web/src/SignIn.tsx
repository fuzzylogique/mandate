import { useState, type FormEvent } from "react";
import { api } from "./api.ts";

export function SignIn({ onSignedIn }: { onSignedIn: () => Promise<void> }) {
  const [registering, setRegistering] = useState(false);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async (event: FormEvent) => {
    event.preventDefault(); setBusy(true); setError("");
    try { if (registering) await api.register({ name, email, password }); else await api.login({ email, password }); await onSignedIn(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Could not sign in"); }
    finally { setBusy(false); }
  };
  return <main className="auth-layout"><section className="auth-intro"><span className="eyebrow">PAYMENTS WITH PERMISSION</span><h1>Your money.<br />Your accounts.<br />Your rules.</h1><p className="muted">One email and password to manage your financial accounts. Shared access for the people and agents you trust.</p><div className="auth-model"><span>Email + password login · no balance</span><span aria-hidden="true">↓</span><span>Traditional account · Stellar account</span><span aria-hidden="true">↓</span><span>Separate mandates for people & agents</span></div></section><section className="card auth-card"><h2>{registering ? "Create your login" : "Welcome back"}</h2><p className="muted">{registering ? "Create your payment workspace, then open a financial account." : "Sign in with your email and password."}</p><form className="form" onSubmit={e => void submit(e)}>{registering && <label className="field">Your name<input required autoComplete="name" maxLength={120} value={name} onChange={e => setName(e.target.value)} /></label>}<label className="field">Email<input type="email" required autoComplete="email" maxLength={254} value={email} onChange={e => setEmail(e.target.value)} /></label><label className="field">Password<input type="password" required minLength={registering ? 12 : undefined} maxLength={256} autoComplete={registering ? "new-password" : "current-password"} value={password} onChange={e => setPassword(e.target.value)} /></label>{registering && <p className="muted">Use at least 12 characters.</p>}{error && <p className="form-error" role="alert">{error}</p>}<button className="button is-primary" disabled={busy}>{busy ? "Please wait…" : registering ? "Create login" : "Sign in"}</button><button type="button" className="button is-quiet" disabled={busy} onClick={() => { setRegistering(!registering); setError(""); }}>{registering ? "Already have a login? Sign in" : "New here? Create a login"}</button></form><p className="workspace-note">Traditional banking uses demo funds. Stellar payments use testnet XLM.</p></section></main>;
}

