// One shopper: what it has left to spend, and the owner's controls over it.
import { useEffect, useRef, useState, type CSSProperties } from "react";
import { toBaseUnits, type CatalogItem, type Mandate } from "@mandate/shared";
import { leftAmount, leftShare, moneyParts, periodWords, roundMoney } from "./format.ts";
import { BasketIcon } from "./icons.tsx";

interface ShopperCardProps {
  shopper: Mandate;
  /** Which of the three gauge colours this card uses. */
  tone: number;
  catalog: CatalogItem[];
  /** What this shopper is doing right now, e.g. "Shopping at FreshMart…". */
  busyLabel: string | null;
  onPurchase: (item: CatalogItem) => void;
  onStop: () => void;
}

export function ShopperCard({ shopper, tone, catalog, busyLabel, onPurchase, onStop }: ShopperCardProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [confirmingStop, setConfirmingStop] = useState(false);
  const menu = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const onMouseDown = (event: MouseEvent) => {
      if (!menu.current?.contains(event.target as Node)) setMenuOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMenuOpen(false);
    };
    document.addEventListener("mousedown", onMouseDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onMouseDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [menuOpen]);

  const share = leftShare(shopper);
  const left = moneyParts(leftAmount(shopper), shopper.token);
  const words = periodWords(shopper.period);
  const style = {
    "--tone": `var(--tone-${(tone % 3) + 1})`,
    "--share": `${Math.round(share * 100)}%`,
  } as CSSProperties;

  return (
    <article className={`glass shopper ${menuOpen ? "is-raised" : ""}`} style={style}>
      <div className="shopper-gauge">
        <span className="ring" role="img" aria-label={`${Math.round(share * 100)}% of its limit left ${words.current}`} />
        {share === 0 && <span className="shopper-flag">Nothing left {words.current}</span>}
      </div>

      <h3>{shopper.name}</h3>
      <p className="shopper-left">
        {left.lead}
        <span className="cents">{left.tail}</span> <span className="shopper-left-word">left</span>
      </p>
      <p className="quiet">
        of {roundMoney(shopper.limit ?? "0", shopper.token)} {words.a}
      </p>

      <footer className="shopper-actions">
        {confirmingStop ? (
          <>
            <span className="shopper-confirm">Stop this shopper?</span>
            <button
              className="button is-stop"
              onClick={() => {
                setConfirmingStop(false);
                onStop();
              }}
            >
              Stop
            </button>
            <button className="button is-quiet" onClick={() => setConfirmingStop(false)}>
              Keep
            </button>
          </>
        ) : (
          <>
            <div className="menu-anchor" ref={menu}>
              <button
                className="button"
                disabled={busyLabel !== null}
                aria-expanded={menuOpen}
                aria-haspopup="menu"
                onClick={() => setMenuOpen((open) => !open)}
              >
                {busyLabel ?? (
                  <>
                    <BasketIcon size={18} /> Send shopping…
                  </>
                )}
              </button>
              {menuOpen && (
                <div className="menu" role="menu">
                  <p className="menu-caption">Try it out: what should {shopper.name} buy?</p>
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
                        <span className="quiet">
                          {item.seller.name}
                          {!item.seller.verified && <em className="not-trusted">Not a trusted store</em>}
                        </span>
                      </span>
                      <span className="menu-price">{roundMoney(toBaseUnits(item.price), shopper.token)}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
            <button className="button is-quiet" disabled={busyLabel !== null} onClick={() => setConfirmingStop(true)}>
              Stop
            </button>
          </>
        )}
      </footer>
    </article>
  );
}
