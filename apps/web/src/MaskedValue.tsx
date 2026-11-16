import { useState } from "react";

/** Only Show changes the field value. Copy obtains the value without revealing it. */
export function MaskedValue({ label, getValue, showLabel, hideLabel, copyLabel }: {
  label: string;
  getValue: () => string | Promise<string>;
  showLabel: string;
  hideLabel: string;
  copyLabel: string;
}) {
  const [visible, setVisible] = useState(false);
  const [value, setValue] = useState<string>();
  const [busy, setBusy] = useState<"show" | "copy" | null>(null);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  const toggle = async () => {
    setError(""); setCopied(false);
    if (visible) { setVisible(false); setValue(undefined); return; }
    setBusy("show");
    try { setValue(await getValue()); setVisible(true); }
    catch (cause) { setError(cause instanceof Error ? cause.message : `Could not show ${label}`); }
    finally { setBusy(null); }
  };
  const copy = async () => {
    setBusy("copy"); setError(""); setCopied(false);
    try {
      if (!navigator.clipboard) throw new Error("Clipboard access is unavailable in this browser.");
      const copiedValue = visible && value ? value : await getValue();
      await navigator.clipboard.writeText(copiedValue);
      setCopied(true);
    } catch (cause) { setError(cause instanceof Error ? cause.message : `Could not copy ${label}`); }
    finally { setBusy(null); }
  };
  return <div className="secret-mandate">
    <label className="field">{label}<input type={visible ? "text" : "password"} readOnly value={visible ? value ?? "" : "••••••••••••"} autoComplete="off" spellCheck={false} autoCapitalize="none" onFocus={event => { if (visible) event.target.select(); }} /></label>
    <div className="account-buttons">
      <button className="button" type="button" disabled={!!busy} aria-pressed={visible} onClick={() => void toggle()}>{busy === "show" ? "Loading…" : visible ? hideLabel : showLabel}</button>
      <button className="button" type="button" disabled={!!busy} aria-label={copyLabel} onClick={() => void copy()}>{busy === "copy" ? "Copying…" : copied ? "Copied" : copyLabel}</button>
    </div>
    {copied && <span className="muted" role="status">Copied to clipboard.</span>}
    {error && <p className="form-error" role="alert">{error}</p>}
  </div>;
}
