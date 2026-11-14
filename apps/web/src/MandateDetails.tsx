import type { AccountMandate, SpendingAccount } from "@mandate/shared";
import { SecretMandateId } from "./SecretMandateId.tsx";

export function MandateDetails({ mandate, account, mandateId, onClose }: {
  mandate: AccountMandate; account: SpendingAccount; mandateId: string; onClose: () => void;
}) {
  const rail = mandate.rail ?? account.rail;
  const payUrl = `${window.location.origin}/pay?rail=${rail}`;
  return <div className="form">
    <p>The mandate is ready and spends from <strong>{account.name}</strong>.</p>
    <p className="form-note">{rail === "traditional" ? "Traditional banking demo · simulated USD payments only." : "Stellar testnet contract rules apply."}</p>
    <SecretMandateId reference={mandate.reference} initialValue={mandateId} />
    <p className="form-note">The mandate ID authorizes payments. Keep it private and give it only to the intended holder. The Pay link does not contain it.</p>
    <label className="field">Payment page link<input readOnly value={payUrl} onFocus={event => event.target.select()} /></label>
    <label className="field">Source account reference<input readOnly value={account.address ?? account.id} onFocus={event => event.target.select()} /></label>
    <div className="form-actions"><button className="button is-primary" type="button" onClick={onClose}>Done</button></div>
  </div>;
}
