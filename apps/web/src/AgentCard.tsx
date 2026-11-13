// One agent: who it is, what it may spend, how much it has used, and the
// owner's controls over it.
import { useEffect, useRef, useState, type CSSProperties } from "react";
import { toBaseUnits, type CatalogItem, type Mandate } from "@mandate/shared";
import { hueFor, initials, money, periodWords, usedShare } from "./format.ts";
import { ShieldIcon } from "./icons.tsx";

interface AgentCardProps {
  mandate: Mandate;
  catalog: CatalogItem[];
  /** What this agent is doing right now, e.g. "Buying weather report…". */
  busyLabel: string | null;
  onPurchase: (item: CatalogItem) => void;
  onRevoke: () => void;
}

export function AgentCard({ mandate, catalog, busyLabel, onPurchase, onRevoke }: AgentCardProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [confirmingRevoke, setConfirmingRevoke] = useState(false);
  const menu = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const close = (event: MouseEvent) => {
      if (!menu.current?.contains(event.target as Node)) setMenuOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [menuOpen]);

  const revoked = mandate.status === "revoked";
  const share = usedShare(mandate);
  const atLimit = !revoked && share >= 1;
  const words = periodWords(mandate.period);
  const avatarStyle = { "--hue": hueFor(mandate.name) } as CSSProperties;

  return (
    <article className={`card agent ${revoked ? "is-revoked" : ""}`}>
      <header className="agent-header">
        <span className="avatar" style={avatarStyle} aria-hidden="true">
          {initials(mandate.name)}
        </span>
        <div className="agent-title">
          <h3>{mandate.name}</h3>
          <span className={`status ${revoked ? "is-off" : atLimit ? "is-warn" : "is-on"}`}>
            {revoked ? "Access revoked" : atLimit ? "Limit reached" : "Active"}
          </span>
        </div>
      </header>

      {revoked || mandate.limit === null ? (
        <p className="muted agent-note">This agent can no longer spend from your account.</p>
      ) : (
        <>
          <div className="usage">
            <div className="usage-figures">
              <span className="usage-spent">{money(mandate.spent, mandate.token)}</span>
              <span className="muted">
                of {money(mandate.limit, mandate.token)} {words.current}
              </span>
            </div>
            <div
              className={`meter ${atLimit ? "is-full" : share >= 0.8 ? "is-high" : ""}`}
              role="progressbar"
              aria-label={`Spending limit used ${words.current}`}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(share * 100)}
            >
              <span style={{ width: `${Math.max(share * 100, share > 0 ? 3 : 0)}%` }} />
            </div>
          </div>

          <ul className="rules">
            <li>
              <ShieldIcon size={15} /> Verified sellers only
            </li>
            <li>{words.resets}</li>
          </ul>

          <footer className="agent-actions">
            <div className="menu-anchor" ref={menu}>
              <button
                className="button"
                disabled={busyLabel !== null}
                aria-expanded={menuOpen}
                onClick={() => setMenuOpen((open) => !open)}
              >
                {busyLabel ?? "Send to buy…"}
              </button>
              {menuOpen && (
                <div className="menu" role="menu">
                  <p className="menu-caption">Demo: ask this agent to make a purchase</p>
                  {catalog.map((item) => (
                    <button
                      key={item.id}
                      role="menuitem"
                      className="menu-item"
                      onClick={() => {
                        setMenuOpen(false);
                        onPurchase(item);
                      }}
                    >
                      <span>
                        <strong>{item.title}</strong>
                        <span className="muted">
                          {item.seller.name}
                          {!item.seller.verified && <em className="tag is-danger">Unverified</em>}
                        </span>
                      </span>
                      <span className="menu-price">
                        {money(toBaseUnits(item.price), mandate.token)}
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </div>

            {confirmingRevoke ? (
              <span className="confirm">
                Revoke access?
                <button
                  className="button is-danger"
                  onClick={() => {
                    setConfirmingRevoke(false);
                    onRevoke();
                  }}
                >
                  Revoke
                </button>
                <button className="button is-quiet" onClick={() => setConfirmingRevoke(false)}>
                  Keep
                </button>
              </span>
            ) : (
              <button
                className="button is-quiet"
                disabled={busyLabel !== null}
                onClick={() => setConfirmingRevoke(true)}
              >
                Revoke access
              </button>
            )}
          </footer>
        </>
      )}
    </article>
  );
}
