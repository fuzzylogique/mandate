// The receipt for one purchase, drawn as a pass, or the record of one blocked payment.
import type { Activity, Mandate } from "@mandate/shared";
import { Dialog } from "./Dialog.tsx";
import { fullDate, moneyParts, periodWords, roundMoney } from "./format.ts";
import { CheckIcon, ShieldIcon } from "./icons.tsx";

const PROOF_URL = "https://stellar.expert/explorer/testnet/tx/";

interface ReceiptDialogProps {
  item: Activity;
  /** The shopper that paid, if it is still known. */
  shopper: Mandate | undefined;
  ownerName: string;
  onClose: () => void;
}

function ruleLine(shopper: Mandate | undefined): string | null {
  if (!shopper) return null;
  if (shopper.status === "revoked" || shopper.limit === null) return "Shopper since stopped";
  return `${roundMoney(shopper.limit, shopper.token)} ${periodWords(shopper.period).a}`;
}

export function ReceiptDialog({ item, shopper, ownerName, onClose }: ReceiptDialogProps) {
  const blocked = item.kind === "declined";
  const amount = moneyParts(item.amount, item.token);
  const rule = ruleLine(shopper);

  return (
    <Dialog title={blocked ? "Blocked payment" : "Receipt"} onClose={onClose} variant="bare">
      <div className={`pass ${blocked ? "is-blocked" : ""}`}>
        <div className="glass pass-top">
          <span className="store-disc" aria-hidden="true">
            {item.seller.name.trim()[0]?.toUpperCase() ?? "?"}
          </span>
          <p className="pass-store">{item.seller.name}</p>
          {item.seller.verified ? (
            <p className="pass-trust is-trusted">
              <ShieldIcon size={16} /> Trusted store
            </p>
          ) : (
            <p className="pass-trust is-not">Not a trusted store</p>
          )}
          <p className="pass-amount">
            {amount.lead}
            <span className="cents">{amount.tail}</span>
          </p>
          <p className="quiet">{fullDate(item.at)}</p>
          {blocked && <p className="pass-verdict">Blocked. Your money didn't move.</p>}
        </div>

        <div className="glass pass-bottom">
          <dl className="pass-rows">
            {blocked && (
              <div>
                <dt>Why</dt>
                <dd>{item.reason ?? "Blocked by your account's rules"}</dd>
              </div>
            )}
            <div>
              <dt>For</dt>
              <dd>{item.item}</dd>
            </div>
            <div>
              <dt>{blocked ? "Tried by" : "Paid by"}</dt>
              <dd>{item.agent.name}</dd>
            </div>
            <div>
              <dt>{blocked ? "On behalf of" : "Allowed by"}</dt>
              <dd>{ownerName}</dd>
            </div>
            {rule && (
              <div>
                <dt>Under the rule</dt>
                <dd>{rule}</dd>
              </div>
            )}
          </dl>

          {!blocked && item.txHash && (
            <div className="seal-row">
              <span className="seal" aria-hidden="true">
                <span className="seal-core">
                  <CheckIcon size={24} />
                </span>
              </span>
              <div>
                <p className="seal-title">Sealed</p>
                <p className="quiet">
                  Nobody can edit or fake this receipt, not even us.{" "}
                  <a href={`${PROOF_URL}${item.txHash}`} target="_blank" rel="noreferrer">
                    See the proof
                  </a>
                </p>
              </div>
            </div>
          )}
        </div>
      </div>
    </Dialog>
  );
}
