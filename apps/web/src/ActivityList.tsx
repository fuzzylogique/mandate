// Everything agents did with the owner's money: payments that went through,
// and payments the account refused.
import type { Activity } from "@mandate/shared";
import { money, when } from "./format.ts";
import { BlockedIcon, CheckIcon, ChevronIcon, ShieldIcon } from "./icons.tsx";

interface ActivityListProps {
  items: Activity[];
  /** Ids that arrived since the page loaded, to draw the eye briefly. */
  freshIds: Set<string>;
  onOpen: (item: Activity) => void;
}

export function ActivityList({ items, freshIds, onOpen }: ActivityListProps) {
  if (items.length === 0) {
    return <p className="empty">Nothing yet. Payments your agents make will appear here.</p>;
  }
  return (
    <ul className="activity">
      {items.map((item) => {
        const declined = item.kind === "declined";
        return (
          <li key={item.id}>
            <button
              className={`activity-row ${freshIds.has(item.id) ? "is-fresh" : ""}`}
              onClick={() => onOpen(item)}
            >
              <span className={`activity-icon ${declined ? "is-declined" : "is-paid"}`}>
                {declined ? <BlockedIcon size={17} /> : <CheckIcon size={17} />}
              </span>
              <span className="activity-main">
                <span className="activity-seller">
                  {item.seller.name}
                  {item.seller.verified ? (
                    <span className="verified" title="Verified seller">
                      <ShieldIcon size={14} />
                    </span>
                  ) : (
                    <em className="tag is-danger">Unverified</em>
                  )}
                </span>
                <span className="muted">
                  {item.item} · {item.agent.name}
                </span>
                {declined && <span className="activity-reason">Declined: {item.reason}</span>}
              </span>
              <span className="activity-side">
                <span className={`activity-amount ${declined ? "is-declined" : ""}`}>
                  {money(item.amount, item.token)}
                </span>
                <span className="muted">{when(item.at)}</span>
              </span>
              <span className="activity-chevron">
                <ChevronIcon size={16} />
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
