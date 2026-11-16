// Everything shoppers did with the owner's money: purchases that went through,
// and payments the account blocked.
import type { Activity } from "@mandate/shared";
import { money, when } from "./format.ts";
import { ChevronIcon } from "./icons.tsx";

interface ActivityListProps {
  items: Activity[];
  /** Ids that arrived since the page loaded, to draw the eye briefly. */
  freshIds: Set<string>;
  onOpen: (item: Activity) => void;
}

export function ActivityList({ items, freshIds, onOpen }: ActivityListProps) {
  if (items.length === 0) {
    return <p className="empty">Purchases your shoppers make will show up here.</p>;
  }
  return (
    <ul className="activity">
      {items.map((item) => {
        const blocked = item.kind === "declined";
        return (
          <li key={item.id}>
            <button
              className={`activity-row ${blocked ? "is-blocked" : ""} ${freshIds.has(item.id) ? "is-fresh" : ""}`}
              onClick={() => onOpen(item)}
            >
              <span className="activity-main">
                <span className="activity-store">{blocked ? `Blocked: ${item.seller.name}` : item.seller.name}</span>
                <span className="quiet">
                  {blocked
                    ? `${item.reason ?? "Blocked by your account's rules"}. Nothing was paid.`
                    : `${item.item} · ${item.agent.name}`}
                </span>
              </span>
              <span className="activity-side">
                <span className="activity-amount">{money(item.amount, item.token)}</span>
                <span className="quiet">
                  {blocked ? `${item.agent.name}, ` : ""}
                  {when(item.at)}
                </span>
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
