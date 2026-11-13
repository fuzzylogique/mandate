// The receipt for one agent payment, or the record of one refused attempt.
import type { Activity, Mandate } from "@mandate/shared";
import { Dialog } from "./Dialog.tsx";
import { fullDate, money, ruleSummary } from "./format.ts";
import { BlockedIcon, CheckIcon, ExternalIcon, ShieldIcon } from "./icons.tsx";

const EXPLORER_TX = "https://stellar.expert/explorer/testnet/tx/";

interface ReceiptDialogProps {
  item: Activity;
  /** The agent's mandate, if it is still known. */
  mandate: Mandate | undefined;
  ownerName: string;
  onClose: () => void;
}

export function ReceiptDialog({ item, mandate, ownerName, onClose }: ReceiptDialogProps) {
  const declined = item.kind === "declined";
  return (
    <Dialog title={declined ? "Declined payment" : "Receipt"} onClose={onClose} className="receipt">
      <div className="receipt-top">
        <span className={`receipt-badge ${declined ? "is-declined" : "is-paid"}`}>
          {declined ? <BlockedIcon size={22} /> : <CheckIcon size={22} />}
        </span>
        <p className={`receipt-amount ${declined ? "is-declined" : ""}`}>
          {money(item.amount, item.token)}
        </p>
        <p className="receipt-status">
          {declined ? "Declined. No money left your account." : `Paid to ${item.seller.name}`}
        </p>
      </div>

      <dl className="receipt-lines">
        {declined && (
          <div className="is-emphasis">
            <dt>Reason</dt>
            <dd>{item.reason}</dd>
          </div>
        )}
        <div>
          <dt>Date</dt>
          <dd>{fullDate(item.at)}</dd>
        </div>
        <div>
          <dt>Item</dt>
          <dd>{item.item}</dd>
        </div>
        <div>
          <dt>Seller</dt>
          <dd>
            {item.seller.name}
            {item.seller.domain && <span className="muted"> · {item.seller.domain}</span>}
            <br />
            {item.seller.verified ? (
              <span className="verified is-labelled">
                <ShieldIcon size={14} /> Verified seller
              </span>
            ) : (
              <em className="tag is-danger">Not a verified seller</em>
            )}
          </dd>
        </div>
        <div>
          <dt>{declined ? "Attempted by" : "Bought by"}</dt>
          <dd>{item.agent.name}</dd>
        </div>
        <div>
          <dt>{declined ? "On behalf of" : "Authorized by"}</dt>
          <dd>{ownerName}</dd>
        </div>
        {mandate && (
          <div>
            <dt>Agent's rules</dt>
            <dd>{ruleSummary(mandate)}</dd>
          </div>
        )}
      </dl>

      <footer className="receipt-footer">
        {item.txHash ? (
          <>
            <span className="muted">Recorded on the Stellar network</span>
            <a href={`${EXPLORER_TX}${item.txHash}`} target="_blank" rel="noreferrer">
              View proof <ExternalIcon size={14} />
            </a>
          </>
        ) : (
          <span className="muted">
            Your account's rules refused this before any payment was sent.
          </span>
        )}
      </footer>
    </Dialog>
  );
}
