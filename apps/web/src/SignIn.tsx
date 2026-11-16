// Sign in, or create a login. A login holds no money: the account comes next.
import { useState, type FormEvent } from "react";
import type { Customer } from "@mandate/shared/api";
import { api } from "./api.ts";
import { ShieldIcon } from "./icons.tsx";

export function SignIn({ onSignedIn }: { onSignedIn: (customer: Customer) => void }) {
  const [mode, setMode] = useState<"in" | "up">("in");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      onSignedIn(mode === "in" ? await api.login({ email, password }) : await api.register({ name, email, password }));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Something went wrong");
      setBusy(false);
    }
  };

  return (
    <main className="sign-in">
      <section className="glass panel sign-in-card">
        <h1>{mode === "in" ? "Welcome back" : "Let shoppers handle the buying"}</h1>
        <p className="quiet">
          {mode === "in" ? "Sign in to your account." : "You set the limits and the stores. Shoppers buy on their own, and ask you only when something's outside your rules."}
        </p>
        <div className="segmented" role="tablist">
          <button role="tab" aria-selected={mode === "in"} className={mode === "in" ? "is-on" : ""} onClick={() => { setMode("in"); setError(null); }}>Sign in</button>
          <button role="tab" aria-selected={mode === "up"} className={mode === "up" ? "is-on" : ""} onClick={() => { setMode("up"); setError(null); }}>Create account</button>
        </div>
        <form className="form" onSubmit={(event) => void submit(event)}>
          {mode === "up" && (
            <label className="text-field"><span>Your name or business</span><input required value={name} onChange={(e) => setName(e.target.value)} autoComplete="organization" /></label>
          )}
          <label className="text-field"><span>Email</span><input required type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" /></label>
          <label className="text-field">
            <span>Password{mode === "up" ? ", at least 12 characters" : ""}</span>
            <input required type="password" minLength={mode === "up" ? 12 : undefined} value={password} onChange={(e) => setPassword(e.target.value)} autoComplete={mode === "up" ? "new-password" : "current-password"} />
          </label>
          {error && <p className="form-error" role="alert">{error}</p>}
          <button className="button is-lens is-wide" disabled={busy}>{busy ? "One moment…" : mode === "in" ? "Sign in" : "Create account"}</button>
        </form>
        <p className="assurance"><ShieldIcon size={18} /><span>Your rules are enforced by your account itself, so no shopper can spend past them.</span></p>
      </section>
    </main>
  );
}
