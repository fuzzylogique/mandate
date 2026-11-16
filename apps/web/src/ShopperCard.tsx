// One shopper: what it has left, what it does on its own, and the owner's controls.
import { useEffect, useRef, useState, type CSSProperties } from "react";
import type { Shopper } from "@mandate/shared/api";
import { ConnectSteps } from "./ConnectSteps.tsx";
import { fromNow, leftAmount, leftShare, moneyParts, periodWords, roundMoney } from "./format.ts";
import { BasketIcon, PersonIcon, SparkIcon } from "./icons.tsx";

interface ShopperCardProps {
  shopper: Shopper;
  /** Which of the three gauge colours this card uses. */
  tone: number;
  /** What this shopper is doing right now, e.g. "Shopping…". */
  busyLabel: string | null;
  onShopNow: () => void;
  onTest: (test: "lookalike" | "over-limit") => void;
  onNewCode: () => void;
  onStop: () => void;
}

const KIND_LABEL = {
  hosted: { text: "Shops for you", icon: <BasketIcon size={14} /> },
  assistant: { text: "Your assistant", icon: <SparkIcon size={14} /> },
  person: { text: "Shared", icon: <PersonIcon size={14} /> },
} as const;

export function ShopperCard({ shopper, tone, busyLabel, onShopNow, onTest, onNewCode, onStop }: ShopperCardProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [confirmingStop, setConfirmingStop] = useState(false);
  const menu = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const onMouseDown = (event: MouseEvent) => { if (!menu.current?.contains(event.target as Node)) setMenuOpen(false); };
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") setMenuOpen(false); };
    document.addEventListener("mousedown", onMouseDown);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("mousedown", onMouseDown); document.removeEventListener("keydown", onKey); };
  }, [menuOpen]);

  const share = leftShare(shopper);
  const left = moneyParts(leftAmount(shopper));
  const words = periodWords(shopper.period);
  const style = { "--tone": `var(--tone-${(tone % 3) + 1})`, "--share": `${Math.round(share * 100)}%` } as CSSProperties;
  const label = KIND_LABEL[shopper.kind];
  const waiting = shopper.status === "waiting";
  const canTest = shopper.kind !== "assistant";

  return (
    <article className={`glass shopper ${menuOpen ? "is-raised" : ""} ${waiting ? "is-waiting" : ""}`} style={style}>
      <p className="shopper-kind">
        {label.icon} {label.text}
      </p>
      {!waiting && (
        <div className="shopper-gauge">
          <span className="ring" role="img" aria-label={`${Math.round(share * 100)}% of its limit left ${words.current}`} />
          {share === 0 && <span className="shopper-flag">Nothing left {words.current}</span>}
        </div>
      )}

      <h3>{shopper.name}</h3>
      {waiting ? (
        shopper.pairing ? (
          <ConnectSteps shopper={shopper} />
        ) : (
          <p className="quiet">The code expired before it was used. <button className="link-button" onClick={onNewCode}>Get a new code</button></p>
        )
      ) : (
        <>
          <p className="shopper-left">
            {left.lead}<span className="cents">{left.tail}</span> <span className="shopper-left-word">left</span>
          </p>
          <p className="quiet">of {roundMoney(shopper.limit)} {words.a}</p>
        </>
      )}

      {shopper.job && (
        <div className="shopper-job">
          <p><strong>Keeps {shopper.job.item} stocked</strong> · {periodWords(shopper.job.every).ly}</p>
          {busyLabel ? (
            <p className="quiet">{busyLabel}</p>
          ) : (
            <p className="quiet">
              {shopper.job.lastResult ? `${shopper.job.lastResult}. ` : "First run starting… "}
              {shopper.job.lastRunAt && `Next run ${fromNow(shopper.job.nextRunAt)}.`}
            </p>
          )}
        </div>
      )}
      {shopper.kind === "assistant" && !waiting && <p className="quiet shopper-job">Connected. It shops when you ask it to, within these rules.</p>}
      {shopper.kind === "person" && shopper.holder && <p className="quiet shopper-job">Shared with {shopper.holder}. They sign in to buy.</p>}

      <footer className="shopper-actions">
        {confirmingStop ? (
          <>
            <span className="shopper-confirm">Stop {shopper.name}?</span>
            <button className="button is-stop" onClick={() => { setConfirmingStop(false); onStop(); }}>Stop</button>
            <button className="button is-quiet" onClick={() => setConfirmingStop(false)}>Keep</button>
          </>
        ) : (
          <>
            {shopper.job && (
              <button className="button" disabled={busyLabel !== null} onClick={onShopNow}>
                <BasketIcon size={18} /> Shop now
              </button>
            )}
            {canTest && !waiting && (
              <div className="menu-anchor" ref={menu}>
                <button className="button is-quiet" disabled={busyLabel !== null} aria-expanded={menuOpen} aria-haspopup="menu" onClick={() => setMenuOpen((open) => !open)}>
                  Test the rules
                </button>
                {menuOpen && (
                  <div className="menu" role="menu">
                    <p className="menu-caption">Make {shopper.name} try something its rules forbid. The payment is really attempted.</p>
                    <button role="menuitem" className="menu-item" onClick={() => { setMenuOpen(false); onTest("lookalike"); }}>
                      <span><strong>Buy from a look-alike store</strong><span className="quiet">FreshMarrt, cheaper, not trusted</span></span>
                    </button>
                    <button role="menuitem" className="menu-item" onClick={() => { setMenuOpen(false); onTest("over-limit"); }}>
                      <span><strong>Buy something over the limit</strong><span className="quiet">The most expensive thing at a trusted store</span></span>
                    </button>
                  </div>
                )}
              </div>
            )}
            <button className="button is-quiet" disabled={busyLabel !== null} onClick={() => setConfirmingStop(true)}>Stop</button>
          </>
        )}
      </footer>
    </article>
  );
}
