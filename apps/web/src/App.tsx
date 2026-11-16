// The owner's account: balance, shoppers and what each has left, and everything
// the shoppers have bought or been blocked from buying.
import { useCallback, useEffect, useRef, useState } from "react";
import { toBaseUnits, type Activity, type CatalogItem, type Mandate, type MandatePeriod, type Overview } from "@mandate/shared";
import { ActivityList } from "./ActivityList.tsx";
import { api } from "./api.ts";
import { money, moneyParts, roundMoney, ruleSummary } from "./format.ts";
import { Logo, MoonIcon, PlusIcon, ShieldIcon, SunIcon } from "./icons.tsx";
import { NewShopper } from "./NewShopper.tsx";
import { ReceiptDialog } from "./ReceiptDialog.tsx";
import { ShopperCard } from "./ShopperCard.tsx";

const REFRESH_MS = 4000;
/** How many purchases "Latest" shows before the owner asks for the rest. */
const LATEST_ROWS = 8;

interface Toast {
  id: number;
  kind: "good" | "bad";
  text: string;
}

const isToday = (iso: string) => new Date(iso).toDateString() === new Date().toDateString();

export function App() {
  const [overview, setOverview] = useState<Overview | null>(null);
  const [activity, setActivity] = useState<Activity[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<Record<number, string>>({});
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [openItem, setOpenItem] = useState<Activity | null>(null);
  const [adding, setAdding] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const [freshIds, setFreshIds] = useState<Set<string>>(new Set());
  const seenIds = useRef<Set<string> | null>(null);
  const nextToastId = useRef(1);

  const refresh = useCallback(async () => {
    try {
      const [nextOverview, nextActivity] = await Promise.all([api.overview(), api.activity()]);
      setOverview(nextOverview);
      setActivity(nextActivity);
      setError(null);

      // Remember what was already there on first load; highlight what comes after.
      if (seenIds.current === null) {
        seenIds.current = new Set(nextActivity.map((item) => item.id));
      } else {
        const seen = seenIds.current;
        const arrived = nextActivity.filter((item) => !seen.has(item.id)).map((item) => item.id);
        if (arrived.length > 0) {
          arrived.forEach((id) => seen.add(id));
          setFreshIds((current) => new Set([...current, ...arrived]));
        }
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Something went wrong");
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), REFRESH_MS);
    return () => clearInterval(timer);
  }, [refresh]);

  const toast = useCallback((kind: Toast["kind"], text: string) => {
    const id = nextToastId.current++;
    setToasts((current) => [...current, { id, kind, text }]);
    setTimeout(() => setToasts((current) => current.filter((entry) => entry.id !== id)), 6000);
  }, []);

  /** Runs one action for a shopper, showing `label` on its card meanwhile. */
  const withBusy = async (ruleId: number, label: string, action: () => Promise<void>) => {
    setBusy((current) => ({ ...current, [ruleId]: label }));
    try {
      await action();
    } catch (cause) {
      toast("bad", cause instanceof Error ? cause.message : "Something went wrong");
    } finally {
      setBusy((current) => {
        const { [ruleId]: _done, ...rest } = current;
        return rest;
      });
      void refresh();
    }
  };

  const purchase = (shopper: Mandate, item: CatalogItem) =>
    withBusy(shopper.ruleId, `Shopping at ${item.seller.name}…`, async () => {
      const result = await api.purchase(shopper.ruleId, item.id);
      const price = roundMoney(toBaseUnits(item.price), shopper.token);
      if (result.status === "paid") {
        toast("good", `${shopper.name} paid ${item.seller.name} ${price} for ${item.title.toLowerCase()}.`);
      } else {
        const reason = result.reason ?? "Blocked by your account's rules";
        toast("bad", `Blocked: ${shopper.name} tried to pay ${item.seller.name} ${price}. ${reason}. Nothing was paid.`);
      }
    });

  const stop = (shopper: Mandate) =>
    withBusy(shopper.ruleId, "Stopping…", async () => {
      await api.revokeAgent(shopper.ruleId);
      toast("good", `${shopper.name} is stopped and can't spend any more.`);
    });

  const addShopper = async (input: { name: string; limit: string; period: MandatePeriod }) => {
    const shopper = await api.createAgent(input);
    toast("good", `${shopper.name} is ready. ${ruleSummary(shopper)}.`);
    void refresh();
  };

  if (!overview) {
    return (
      <div className="page">
        <TopBar ownerName={null} />
        <main className="loading">
          {error ? (
            <p className="glass banner" role="alert">
              {error}
            </p>
          ) : (
            <p className="quiet">Loading your account…</p>
          )}
        </main>
      </div>
    );
  }

  const { account, mandates: shoppers, sellers: stores, catalog, owner } = overview;
  const active = shoppers.filter((shopper) => shopper.status === "active");
  const stopped = shoppers.filter((shopper) => shopper.status === "revoked");
  const paidToday = activity.filter((item) => item.kind === "paid" && isToday(item.at));
  const blockedToday = activity.filter((item) => item.kind === "declined" && isToday(item.at));
  const spentToday = paidToday
    .filter((item) => item.token.id === account.token.id)
    .reduce((total, item) => total + BigInt(item.amount), 0n);
  const balance = moneyParts(account.balance, account.token);

  return (
    <div className="page">
      <TopBar ownerName={owner.name} />

      <main>
        <h1 className="sr-only">Your account</h1>
        {error && (
          <p className="glass banner" role="alert">
            {error}
          </p>
        )}

        <section className="hero" aria-label="Balance">
          <p className="hero-label">Available</p>
          <p className="hero-balance">
            {balance.lead}
            <span className="cents">{balance.tail}</span>
          </p>
          <p className="glass capsule">
            <span>{money(spentToday.toString(), account.token)} spent today</span>
            {blockedToday.length > 0 && (
              <>
                <span className="capsule-dot" aria-hidden="true" />
                <span className="capsule-blocked">{blockedToday.length} blocked</span>
              </>
            )}
          </p>
        </section>

        <section aria-labelledby="shoppers-heading">
          <div className="section-head">
            <div>
              <h2 id="shoppers-heading">Shoppers</h2>
              <p className="quiet">Each one spends only what you allow, and only at trusted stores.</p>
            </div>
            <button className="button is-lens" onClick={() => setAdding(true)}>
              <PlusIcon size={18} /> New shopper
            </button>
          </div>

          {active.length === 0 ? (
            <div className="glass empty-card">
              <p className="empty-title">Add your first shopper</p>
              <p className="quiet">Give it a name and a limit, and it can buy things for you within that limit.</p>
            </div>
          ) : (
            <div className="shopper-grid">
              {active.map((shopper, index) => (
                <ShopperCard
                  key={shopper.ruleId}
                  shopper={shopper}
                  tone={index}
                  catalog={catalog}
                  busyLabel={busy[shopper.ruleId] ?? null}
                  onPurchase={(item) => void purchase(shopper, item)}
                  onStop={() => void stop(shopper)}
                />
              ))}
            </div>
          )}

          {stopped.length > 0 && (
            <p className="stopped">
              <span className="stopped-label">Stopped</span>
              {stopped.map((shopper) => shopper.name).join(", ")}
            </p>
          )}
        </section>

        <div className="columns">
          <section className="glass panel is-list" aria-labelledby="latest-heading">
            <h2 id="latest-heading">Latest</h2>
            <ActivityList
              items={showAll ? activity : activity.slice(0, LATEST_ROWS)}
              freshIds={freshIds}
              onOpen={setOpenItem}
            />
            {!showAll && activity.length > LATEST_ROWS && (
              <button className="show-all" onClick={() => setShowAll(true)}>
                Show all {activity.length}
              </button>
            )}
          </section>

          <aside>
            <section className="glass panel" aria-labelledby="stores-heading">
              <h2 id="stores-heading">Trusted stores</h2>
              {stores.length === 0 ? (
                <p className="quiet">No trusted stores yet.</p>
              ) : (
                <ul className="stores">
                  {stores.map((store) => (
                    <li key={store.address}>
                      <span className="store-mark">
                        <ShieldIcon size={18} />
                      </span>
                      <span>
                        <strong>{store.name}</strong>
                        <span className="quiet">{store.domain}</span>
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section className="glass panel" aria-labelledby="protection-heading">
              <h2 id="protection-heading">How you're protected</h2>
              <ul className="protections">
                <li>Shoppers never hold your money. Each one can spend only up to its limit.</li>
                <li>Payments go to trusted stores only. Look-alikes are blocked.</li>
                <li>You can stop a shopper at any time.</li>
              </ul>
            </section>
          </aside>
        </div>

        <p className="footnote">Running on the Stellar test network</p>
      </main>

      {adding && <NewShopper token={account.token} onCreate={addShopper} onClose={() => setAdding(false)} />}
      {openItem && (
        <ReceiptDialog
          item={openItem}
          shopper={shoppers.find((shopper) => shopper.ruleId === openItem.agent.ruleId)}
          ownerName={owner.name}
          onClose={() => setOpenItem(null)}
        />
      )}

      <div className="toasts" role="status" aria-live="polite">
        {toasts.map((entry) => (
          <p key={entry.id} className={`glass toast is-${entry.kind}`}>
            {entry.text}
          </p>
        ))}
      </div>
    </div>
  );
}

type Theme = "light" | "dark";

/** Dark unless the owner picked light with the toggle. */
function useTheme(): [Theme, () => void] {
  const [theme, setTheme] = useState<Theme>(() =>
    document.documentElement.dataset.theme === "light" ? "light" : "dark",
  );

  const toggle = () => {
    const next: Theme = theme === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    try {
      localStorage.setItem("theme", next);
    } catch {
      // Storage can be blocked; the choice then lasts until reload.
    }
    setTheme(next);
  };

  return [theme, toggle];
}

function TopBar({ ownerName }: { ownerName: string | null }) {
  const [theme, toggleTheme] = useTheme();
  const next = theme === "dark" ? "light" : "dark";
  return (
    <header className="glass topbar">
      <a className="brand" href="/">
        <Logo />
        mandate
      </a>
      <div className="topbar-side">
        {ownerName && <span className="owner-name">{ownerName}</span>}
        <button
          type="button"
          className="icon-button is-plain"
          onClick={toggleTheme}
          aria-label={`Switch to ${next} mode`}
          title={`Switch to ${next} mode`}
        >
          {theme === "dark" ? <SunIcon size={20} /> : <MoonIcon size={20} />}
        </button>
      </div>
    </header>
  );
}
