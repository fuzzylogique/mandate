// The receipt for one purchase, drawn as a pass, or the record of one blocked
// payment. The proof section is where the on-chain details live.
import { useState } from "react";
import type { Activity, Shopper } from "@mandate/shared/api";
import { Dialog } from "./Dialog.tsx";
import { fullDate, moneyParts, periodWords, roundMoney, short } from "./format.ts";
import { CheckIcon, ShieldIcon } from "./icons.tsx";

interface ReceiptDialogProps {
  item: Activity;
  shopper: Shopper | undefined;
  ownerName: string;
  onClose: () => void;
}

export function ReceiptDialog({ item, shopper, ownerName, onClose }: ReceiptDialogProps) {
  const [proofOpen, setProofOpen] = useState(false);
  const blocked = item.kind === "blocked";
  const added = item.kind === "added";
  const amount = moneyParts(item.amount);
  const storeName = added ? "Money added" : item.store?.name ?? "Store";
  const rule = shopper && shopper.status !== "stopped" ? `${roundMoney(shopper.limit)} ${periodWords(shopper.period).a}` : shopper ? "Shopper since stopped" : null;

  return (
    <Dialog title={blocked ? "Blocked payment" : added ? "Money added" : "Receipt"} onClose={onClose} variant="bare">
      <div className={`pass ${blocked ? "is-blocked" : ""}`}>
        <div className="glass pass-top">
          <span className="store-disc" aria-hidden="true">{storeName.trim()[0]?.toUpperCase() ?? "?"}</span>
          <p className="pass-store">{storeName}</p>
          {!added && (item.store?.trusted ? (
            <p className="pass-trust is-trusted"><ShieldIcon size={16} /> Trusted store{item.store.domain ? ` · ${item.store.domain}` : ""}</p>
          ) : (
            <p className="pass-trust is-not">Not a trusted store{item.store?.looksLike ? ` · looks like ${item.store.looksLike}` : ""}</p>
          ))}
          <p className="pass-amount">{amount.lead}<span className="cents">{amount.tail}</span></p>
          <p className="quiet">{fullDate(item.at)}</p>
          {blocked && <p className="pass-verdict">Blocked. Your money didn't move.</p>}
        </div>

        <div className="glass pass-bottom">
          <dl className="pass-rows">
            {blocked && (<div><dt>Why</dt><dd>{item.reason ?? "Blocked by your account's rules"}</dd></div>)}
            {!added && (<div><dt>For</dt><dd>{item.item}</dd></div>)}
            {added && (<div><dt>From</dt><dd>Demo bank transfer</dd></div>)}
            {item.shopper && (<div><dt>{blocked ? "Tried by" : item.paidBy === "you" ? "Bought for" : "Bought by"}</dt><dd>{item.shopper.name}</dd></div>)}
            {item.note && (<div><dt>Why this one</dt><dd>{item.note}</dd></div>)}
            {!added && (<div><dt>{blocked ? "On behalf of" : item.paidBy === "you" ? "Approved by" : "Allowed by"}</dt><dd>{item.paidBy === "you" ? `You (${ownerName})` : ownerName}</dd></div>)}
            {rule && !added && item.paidBy !== "you" && (<div><dt>Under the rule</dt><dd>{rule}</dd></div>)}
          </dl>

          {!blocked && item.txHash && (
            <div className="seal-row">
              <span className="seal" aria-hidden="true"><span className="seal-core"><CheckIcon size={24} /></span></span>
              <div>
                <p className="seal-title">Sealed</p>
                <p className="quiet">
                  Nobody can edit or fake this receipt, not even us.{" "}
                  {item.proof ? (
                    <button className="link-button" onClick={() => setProofOpen((open) => !open)}>{proofOpen ? "Hide the proof" : "See the proof"}</button>
                  ) : (
                    <a href={item.explorerUrl} target="_blank" rel="noreferrer">See the proof</a>
                  )}
                </p>
              </div>
            </div>
          )}

          {proofOpen && item.proof && (
            <div className="proof">
              <ul className="proof-checks">
                {item.proof.checks.map((check) => (<li key={check}><CheckIcon size={14} /> {check}</li>))}
              </ul>
              <dl className="proof-rows">
                <div><dt>Account</dt><dd><code>{short(item.proof.smartAccount)}</code></dd></div>
                {item.proof.ruleId !== undefined && (<div><dt>Rule</dt><dd>#{item.proof.ruleId}{item.proof.ruleId === 0 ? " (owner)" : ""}</dd></div>)}
                {item.proof.agentKey && (<div><dt>Shopper's key</dt><dd><code>{short(item.proof.agentKey)}</code></dd></div>)}
                {item.txHash && (<div><dt>Transaction</dt><dd><code>{short(item.txHash)}</code></dd></div>)}
              </dl>
              {item.explorerUrl && <a className="button is-quiet is-wide" href={item.explorerUrl} target="_blank" rel="noreferrer">View on Stellar</a>}
            </div>
          )}
        </div>
      </div>
    </Dialog>
  );
}
