// Spending someone shared with you: sign in, pick something, buy it. Your rule
// on their account decides, so you can't overspend or pay an untrusted store.
import { useEffect, useState } from "react";
import type { Offer, PurchaseOutcome, SharedSpending } from "@mandate/shared/api";
import { api } from "./api.ts";
import { Dialog } from "./Dialog.tsx";
import { leftAmount, money, newRequestId, periodWords, roundMoney } from "./format.ts";
import { PersonIcon, ShieldIcon } from "./icons.tsx";

export function SharedCards({ shared, onOpen }: { shared: SharedSpending[]; onOpen: (s: SharedSpending) => void }) {
  if (shared.length === 0) return null;
  return (
    <section aria-labelledby="shared-heading">
      <div className="section-head">
        <div>
          <h2 id="shared-heading">Shared with you</h2>
          <p className="quiet">Money other people let you spend, within their rules.</p>
        </div>
      </div>
      <div className="shopper-grid">
        {shared.map((s) => (
          <article key={s.id} className="glass shopper">
            <p className="shopper-kind"><PersonIcon size={14} /> From {s.ownerName}</p>
            <h3>{s.name}</h3>
            <p className="shopper-left">{money(leftAmount({ ...s, kind: "person", createdAt: "", status: s.status, id: s.id }))} <span className="shopper-left-word">left</span></p>
            <p className="quiet">of {roundMoney(s.limit)} {periodWords(s.period).a}</p>
            <footer className="shopper-actions">
              <button className="button is-lens" disabled={s.status !== "active"} onClick={() => onOpen(s)}>{s.status === "active" ? "Buy something" : "Stopped"}</button>
            </footer>
          </article>
        ))}
      </div>
    </section>
  );
}

export function SharedBuy({ shared, onDone, onClose }: { shared: SharedSpending; onDone: (outcome: PurchaseOutcome) => void; onClose: () => void }) {
  const [query, setQuery] = useState("");
  const [offers, setOffers] = useState<Offer[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const timer = setTimeout(() => {
      api.sharedOffers(shared.id, query).then(setOffers, (cause) => setError(cause instanceof Error ? cause.message : "Couldn't load stores"));
    }, 200);
    return () => clearTimeout(timer);
  }, [shared.id, query]);

  const buy = async (offer: Offer) => {
    setBusy(offer.id);
    setError(null);
    try {
      onDone(await api.sharedPay(shared.id, offer.id, newRequestId()));
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Something went wrong");
      setBusy(null);
    }
  };

  return (
    <Dialog title={shared.name} onClose={busy ? () => undefined : onClose}>
      <p className="hint">{shared.ownerName} lets you spend {roundMoney(shared.limit)} {periodWords(shared.period).a} at trusted stores</p>
      <label className="text-field"><span>Search</span><input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="herbs, basil, olive oil…" autoFocus /></label>
      <ul className="offer-list">
        {offers.map((offer) => (
          <li key={offer.id} className={offer.store.trusted ? "" : "is-untrusted"}>
            <span>
              <strong>{offer.title}</strong>
              <span className="quiet">
                {offer.store.name}
                {!offer.store.trusted && <em className="not-trusted">Not a trusted store</em>}
              </span>
            </span>
            <span className="menu-price">{money(offer.price)}</span>
            <button className="button" disabled={busy !== null} onClick={() => void buy(offer)}>{busy === offer.id ? "Buying…" : "Buy"}</button>
          </li>
        ))}
      </ul>
      {error && <p className="form-error" role="alert">{error}</p>}
      <p className="assurance"><ShieldIcon size={20} /><span>{shared.ownerName}'s account checks every purchase. Over the limit or at an untrusted store, it's blocked and they're asked.</span></p>
    </Dialog>
  );
}
