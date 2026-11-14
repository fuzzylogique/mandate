import { useState } from "react";
import { api } from "./api.ts";

/** A secret is fetched only after an explicit owner reveal, and cleared when hidden. */
export function SecretMandateId({ reference, initialValue }: { reference: string; initialValue?: string }) {
  const [visible, setVisible] = useState(false);
  const [value, setValue] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  const toggle = async () => {
    if (visible) { setVisible(false); setValue(undefined); setCopied(false); return; }
    setBusy(true); setError("");
    try {
      const mandateId = initialValue ?? (await api.revealMandate(reference)).mandateId;
      setValue(mandateId); setVisible(true);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not show the mandate ID"); }
    finally { setBusy(false); }
  };
  return <div className="secret-mandate">
    <label className="field">Mandate ID<input type={visible ? "text" : "password"} readOnly value={visible ? value ?? "" : "••••••••••••"} autoComplete="off" spellCheck={false} autoCapitalize="none" /></label>
    <div className="account-buttons"><button className="button" type="button" disabled={busy} aria-pressed={visible} onClick={() => void toggle()}>{busy ? "Loading mandate…" : visible ? "Hide mandate" : "Show mandate"}</button>
      {visible && value && navigator.clipboard && <button className="button" type="button" onClick={() => void navigator.clipboard.writeText(value).then(() => setCopied(true)).catch(() => setError("Could not copy the mandate ID"))}>{copied ? "Copied" : "Copy mandate ID"}</button>}
    </div>
    {error && <p className="form-error" role="alert">{error}</p>}
  </div>;
}
