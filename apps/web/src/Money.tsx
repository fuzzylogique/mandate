// Opening the account and adding money to it.
import { useState } from "react";
import { api } from "./api.ts";
import { Dialog } from "./Dialog.tsx";
import { newRequestId } from "./format.ts";
import { ShieldIcon } from "./icons.tsx";

const PICKS = ["25", "50", "100"];

/** First run: a login has no account until the owner opens one. */
export function OpenAccount({ name, onOpened }: { name: string; onOpened: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const open = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.openAccount();
      onOpened();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Something went wrong");
      setBusy(false);
    }
  };
  return (
    <section className="glass panel welcome">
      <h2>Hi {name}. Open your account to start.</h2>
      <p className="quiet">It holds the money your shoppers spend. Each shopper gets its own limit on it, and you can stop any of them at any time.</p>
      <ul className="protections">
        <li>No card, no credit check.</li>
        <li>Shoppers never hold your money. They can only spend from here, within their rules.</li>
      </ul>
      {error && <p className="form-error" role="alert">{error}</p>}
      <button className="button is-lens" disabled={busy} onClick={() => void open()}>
        {busy ? <><span className="spinner" aria-hidden="true" /> Opening your account… about ten seconds</> : "Open my account"}
      </button>
    </section>
  );
}

export function AddMoney({ onAdded, onClose }: { onAdded: (amount: string) => void; onClose: () => void }) {
  const [amount, setAmount] = useState("50");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [requestId, setRequestId] = useState(newRequestId);
  const add = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.addMoney(amount, requestId);
      onAdded(amount);
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Something went wrong");
      setBusy(false);
    }
  };
  return (
    <Dialog title="Add money" onClose={busy ? () => undefined : onClose}>
      <p className="hint">From your bank (demo dollars on the test network)</p>
      <div className="chips" role="group" aria-label="How much">
        {PICKS.map((pick) => (
          <button key={pick} className={`chip ${amount === pick ? "is-selected" : ""}`} aria-pressed={amount === pick} disabled={busy} onClick={() => { setAmount(pick); setRequestId(newRequestId()); }}>
            ${pick}
          </button>
        ))}
      </div>
      <p className="assurance"><ShieldIcon size={20} /><span>Money goes into your account. Shoppers can only spend it within the rules you give them.</span></p>
      {error && <p className="form-error" role="alert">{error}</p>}
      <button className="button is-lens is-wide" disabled={busy} onClick={() => void add()}>
        {busy ? <><span className="spinner" aria-hidden="true" /> Adding ${amount}…</> : `Add $${amount}`}
      </button>
    </Dialog>
  );
}
