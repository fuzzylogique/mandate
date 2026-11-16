// "Needs you": purchases the account blocked, waiting for the owner.
// The only moment a person has to step in.
import { useState } from "react";
import type { ApprovalDecision, ApprovalRequest } from "@mandate/shared/api";
import { money, roundMoney, when } from "./format.ts";
import { BellIcon } from "./icons.tsx";

interface RequestsProps {
  requests: ApprovalRequest[];
  onDecide: (request: ApprovalRequest, decision: ApprovalDecision) => Promise<void>;
}

export function Requests({ requests, onDecide }: RequestsProps) {
  const [busy, setBusy] = useState<Record<string, ApprovalDecision>>({});
  if (requests.length === 0) return null;

  const decide = async (request: ApprovalRequest, decision: ApprovalDecision) => {
    setBusy((current) => ({ ...current, [request.id]: decision }));
    try {
      await onDecide(request, decision);
    } finally {
      setBusy(({ [request.id]: _done, ...rest }) => rest);
    }
  };

  return (
    <section className="needs-you" aria-labelledby="needs-heading">
      <div className="section-head">
        <div>
          <h2 id="needs-heading"><BellIcon size={20} /> Needs you</h2>
          <p className="quiet">Your shoppers handle everything else. These were blocked by your rules.</p>
        </div>
      </div>
      <div className="request-list">
        {requests.map((request) => {
          const working = busy[request.id];
          const fixable = request.kind === "over-limit";
          return (
            <article key={request.id} className={`glass request is-${request.kind}`}>
              <div className="request-main">
                <p className="request-title">
                  <strong>{request.shopper.name}</strong> wants {request.offer.title.toLowerCase()} from {request.offer.store.name}
                </p>
                <p className="quiet">{request.reason}. Nothing was paid. · {when(request.createdAt)}</p>
              </div>
              <p className="request-amount">{money(request.offer.price)}</p>
              <div className="request-actions">
                {fixable && (
                  <>
                    <button className="button is-lens" disabled={!!working} onClick={() => void decide(request, "allow-once")}>
                      {working === "allow-once" ? "Paying…" : "Allow once"}
                    </button>
                    {request.suggestedLimit && (
                      <button className="button" disabled={!!working} onClick={() => void decide(request, "raise-limit")}>
                        {working === "raise-limit" ? "Raising…" : `Raise limit to ${roundMoney(request.suggestedLimit)}`}
                      </button>
                    )}
                  </>
                )}
                <button className="button is-quiet" disabled={!!working} onClick={() => void decide(request, "decline")}>
                  {working === "decline" ? "…" : fixable ? "No" : "Keep it blocked"}
                </button>
              </div>
            </article>
          );
        })}
      </div>
    </section>
  );
}
