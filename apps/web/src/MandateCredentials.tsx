import { useState } from "react";
import type { AccountMandate, SpendingAccount } from "@mandate/shared";

export function MandateCredentials({ mandate, account, token, onClose }: {
  mandate: AccountMandate; account: SpendingAccount; token: string; onClose: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const rail = mandate.rail ?? (account.rail === "traditional" ? "traditional" : "blockchain");
  const payUrl = `${window.location.origin}/pay?mandateId=${encodeURIComponent(mandate.id)}&rail=${rail}`;
  return <div className="form">
    <p>The mandate is ready and spends from <strong>{account.name}</strong>. Save its payment credential now.</p>
    <p className="form-note">{rail === "traditional" ? "Traditional banking demo · simulated USD payments only." : "Blockchain payment · Stellar testnet contract rules."}</p>
    <label className="field">Third-party payment link<input readOnly value={payUrl} onFocus={e => e.target.select()} /></label>
    <label className="field">Mandate ID<input readOnly value={mandate.id} onFocus={e => e.target.select()} /></label>
    <label className="field">Source account reference<input readOnly value={account.address ?? account.id} onFocus={e => e.target.select()} /></label>
    <label className="field">Payment credential<textarea readOnly rows={3} value={token} onFocus={e => e.target.select()} autoComplete="off" /></label>
    <p className="form-note">Anyone holding this credential can spend within the mandate's rules. Share it privately with the intended payer. The link itself contains no credential.</p>
    <div className="form-actions">
      {navigator.clipboard && <button className="button" onClick={() => void navigator.clipboard.writeText(`Pay: ${payUrl}\nMandate ID: ${mandate.id}\nAccount: ${account.address ?? account.id}\nCredential: ${token}`).then(() => setCopied(true)).catch(() => setCopied(false))}>{copied ? "Copied" : "Copy payment details"}</button>}
      <button className="button is-primary" onClick={onClose}>I've saved the details</button>
    </div>
  </div>;
}
