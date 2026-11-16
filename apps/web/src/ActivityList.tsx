// Everything that happened with the owner's money: purchases, blocked
// attempts, and money added.
import type { Activity } from "@mandate/shared/api";
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
        const blocked = item.kind === "blocked";
        const added = item.kind === "added";
        const who = item.paidBy === "you" ? `you, for ${item.shopper?.name ?? "a shopper"}` : item.shopper?.name ?? "";
        return (
          <li key={item.id}>
            <button
              className={`activity-row ${blocked ? "is-blocked" : ""} ${added ? "is-added" : ""} ${freshIds.has(item.id) ? "is-fresh" : ""}`}
              onClick={() => onOpen(item)}
            >
              <span className="activity-main">
                <span className="activity-store">
                  {added ? "Money added" : blocked ? `Blocked: ${item.store?.name ?? "a store"}` : item.store?.name}
                </span>
                <span className="quiet">
                  {added ? "Demo bank transfer" : blocked ? `${item.reason ?? "Blocked by your account's rules"}. Nothing was paid.` : `${item.item} · ${who}`}
                </span>
              </span>
              <span className="activity-side">
                <span className="activity-amount">{added ? "+" : ""}{money(item.amount)}</span>
                <span className="quiet">{blocked && item.shopper ? `${item.shopper.name}, ` : ""}{when(item.at)}</span>
              </span>
              <span className="activity-chevron"><ChevronIcon size={16} /></span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
