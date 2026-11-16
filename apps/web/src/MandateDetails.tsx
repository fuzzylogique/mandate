import type { AccountMandate, SpendingAccount } from "@mandate/shared";
import { SmartAccountAddress } from "./SmartAccountAddress.tsx";
import { SecretMandateId } from "./SecretMandateId.tsx";

export function MandateDetails({ mandate, account, mandateId, onClose }: {
  mandate: AccountMandate; account: SpendingAccount; mandateId: string; onClose: () => void;
}) {
  const payUrl = `${window.location.origin}/pay`;
  return <div className="form">
    <p>The mandate is ready and spends {mandate.currency ?? account.currency} from <strong>{account.name}</strong>.</p>
    <p className="form-note">Spending limits and verified recipients are enforced on Stellar testnet.</p>
    <p className="muted">Allowed seller IDs: {mandate.sellerIds?.length ? mandate.sellerIds.join(", ") : "Any verified seller"}</p>
    <SecretMandateId reference={mandate.reference} initialValue={mandateId} />
    <p className="form-note">The mandate ID authorizes payments. Keep it private and give it only to the intended holder. The Pay link does not contain it.</p>
    <label className="field">Payment page link<input readOnly value={payUrl} onFocus={event => event.target.select()} /></label>
    <SmartAccountAddress address={account.address ?? account.id} label="Source Smart Account address" />
    <div className="form-actions"><button className="button is-primary" type="button" onClick={onClose}>Done</button></div>
  </div>;
}
