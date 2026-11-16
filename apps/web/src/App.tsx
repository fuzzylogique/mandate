// The owner's account: balance, what needs them, shoppers working on their own,
// and everything bought or blocked. Signed out, it's the sign-in page.
import { useCallback, useEffect, useRef, useState } from "react";
import type { Activity, ApprovalDecision, ApprovalRequest, Customer, Overview, PurchaseOutcome, SharedSpending, Shopper } from "@mandate/shared/api";
import { ActivityList } from "./ActivityList.tsx";
import { api, SignedOut } from "./api.ts";
import { money, moneyParts, roundMoney, ruleSummary } from "./format.ts";
import { Logo, MoonIcon, PlusIcon, ShieldIcon, SunIcon } from "./icons.tsx";
import { AddMoney, OpenAccount } from "./Money.tsx";
import { NewShopper } from "./NewShopper.tsx";
import { ReceiptDialog } from "./ReceiptDialog.tsx";
import { Requests } from "./Requests.tsx";
import { SharedBuy, SharedCards } from "./Shared.tsx";
import { ShopperCard } from "./ShopperCard.tsx";
import { SignIn } from "./SignIn.tsx";

const REFRESH_MS = 4000;
/** How many lines "Latest" shows before the owner asks for the rest. */
const LATEST_ROWS = 8;

interface Toast {
  id: number;
  kind: "good" | "bad";
  text: string;
}

const isToday = (iso: string) => new Date(iso).toDateString() === new Date().toDateString();

export function App() {
  const [customer, setCustomer] = useState<Customer | null | undefined>(undefined);

  useEffect(() => {
    api.me().then(setCustomer, () => setCustomer(null));
  }, []);

  if (customer === undefined) {
    return (
      <div className="page">
        <TopBar customer={null} />
        <main className="loading"><p className="quiet">Loading…</p></main>
      </div>
    );
  }
  if (customer === null) {
    return (
      <div className="page">
        <TopBar customer={null} />
        <SignIn onSignedIn={setCustomer} />
      </div>
    );
  }
  return <Home customer={customer} onSignedOut={() => setCustomer(null)} />;
}

function Home({ customer, onSignedOut }: { customer: Customer; onSignedOut: () => void }) {
  const [overview, setOverview] = useState<Overview | null>(null);
  const [activity, setActivity] = useState<Activity[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<Record<string, string>>({});
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [openItem, setOpenItem] = useState<Activity | null>(null);
  const [adding, setAdding] = useState(false);
  const [addingMoney, setAddingMoney] = useState(false);
  const [buyingShared, setBuyingShared] = useState<SharedSpending | null>(null);
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
      if (cause instanceof SignedOut) return onSignedOut();
      setError(cause instanceof Error ? cause.message : "Something went wrong");
    }
  }, [onSignedOut]);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), REFRESH_MS);
    return () => clearInterval(timer);
  }, [refresh]);

  const toast = useCallback((kind: Toast["kind"], text: string) => {
    const id = nextToastId.current++;
    setToasts((current) => [...current, { id, kind, text }]);
    setTimeout(() => setToasts((current) => current.filter((entry) => entry.id !== id)), 6500);
  }, []);

  /** Runs one action for a shopper, showing `label` on its card meanwhile. */
  const withBusy = async (id: string, label: string, action: () => Promise<void>) => {
    setBusy((current) => ({ ...current, [id]: label }));
    try {
      await action();
    } catch (cause) {
      toast("bad", cause instanceof Error ? cause.message : "Something went wrong");
    } finally {
      setBusy(({ [id]: _done, ...rest }) => rest);
      void refresh();
    }
  };

  const tellOutcome = (who: string, outcome: PurchaseOutcome) => {
    if (outcome.status === "paid") {
      toast("good", `${who} bought ${outcome.offer.title.toLowerCase()} from ${outcome.offer.store.name} for ${money(outcome.offer.price)}.`);
    } else if (outcome.status === "blocked") {
      toast("bad", `Blocked: ${outcome.offer.title} from ${outcome.offer.store.name}, ${money(outcome.offer.price)}. ${outcome.reason}. Nothing was paid.`);
    } else {
      toast("bad", outcome.reason);
    }
  };

  const shopNow = (shopper: Shopper) =>
    withBusy(shopper.id, "Comparing stores…", async () => tellOutcome(shopper.name, await api.run(shopper.id)));

  const test = (shopper: Shopper, kind: "lookalike" | "over-limit") =>
    withBusy(shopper.id, kind === "lookalike" ? "Trying a look-alike store…" : "Trying something too expensive…", async () =>
      tellOutcome(shopper.name, await api.run(shopper.id, kind)),
    );

  const newCode = (shopper: Shopper) =>
    withBusy(shopper.id, "Making a new code…", async () => {
      await api.newCode(shopper.id);
    });

  const stop = (shopper: Shopper) =>
    withBusy(shopper.id, "Stopping…", async () => {
      await api.stopShopper(shopper.id);
      toast("good", `${shopper.name} is stopped and can't spend any more.`);
    });

  const decide = async (request: ApprovalRequest, decision: ApprovalDecision) => {
    try {
      const result = await api.decide(request.id, decision);
      if (result.status === "failed") toast("bad", result.error ?? "That didn't go through");
      else if (decision === "allow-once") toast("good", `Paid ${request.offer.store.name} ${money(request.offer.price)} for ${request.shopper.name}, this once.`);
      else if (decision === "raise-limit") toast("good", `${request.shopper.name} can now spend up to ${roundMoney(request.suggestedLimit ?? "0")}. It'll buy it now.`);
      else toast("good", `Kept it blocked. ${request.shopper.name} won't buy it.`);
    } catch (cause) {
      toast("bad", cause instanceof Error ? cause.message : "Something went wrong");
    } finally {
      void refresh();
    }
  };

  const signOut = async () => {
    await api.logout().catch(() => undefined);
    onSignedOut();
  };

  if (!overview) {
    return (
      <div className="page">
        <TopBar customer={customer} onSignOut={() => void signOut()} />
        <main className="loading">
          {error ? <p className="glass banner" role="alert">{error}</p> : <p className="quiet">Loading your account…</p>}
        </main>
      </div>
    );
  }

  const { account, shoppers, stores, requests, shared } = overview;
  const hasAccount = account.status === "ready";
  const working = shoppers.filter((shopper) => shopper.status === "active" || shopper.status === "waiting");
  const stopped = shoppers.filter((shopper) => shopper.status === "stopped" || shopper.status === "expired");
  const spentToday = activity
    .filter((item) => item.kind === "paid" && isToday(item.at))
    .reduce((total, item) => total + Number(item.amount), 0);
  const blockedToday = activity.filter((item) => item.kind === "blocked" && isToday(item.at)).length;
  const balance = moneyParts(account.balance);
  const trusted = stores.filter((store) => store.trusted);
  const untrusted = stores.filter((store) => !store.trusted);

  return (
    <div className="page">
      <TopBar customer={customer} onSignOut={() => void signOut()} />

      <main>
        <h1 className="sr-only">Your account</h1>
        {error && <p className="glass banner" role="alert">{error}</p>}

        <SharedCards shared={shared} onOpen={setBuyingShared} />

        {!hasAccount ? (
          <OpenAccount
            name={customer.name}
            onOpened={() => {
              toast("good", "Your account is open. Add money, then add a shopper.");
              void refresh();
            }}
          />
        ) : (
          <>
            <section className="hero" aria-label="Balance">
              <p className="hero-label">Available</p>
              <p className="hero-balance">
                {balance.lead}
                <span className="cents">{balance.tail}</span>
              </p>
              <div className="hero-row">
                <p className="glass capsule">
                  <span>{money(String(spentToday))} spent today</span>
                  {blockedToday > 0 && (
                    <>
                      <span className="capsule-dot" aria-hidden="true" />
                      <span className="capsule-blocked">{blockedToday} blocked</span>
                    </>
                  )}
                </p>
                <button className="button" onClick={() => setAddingMoney(true)}>
                  <PlusIcon size={16} /> Add money
                </button>
              </div>
            </section>

            <Requests requests={requests} onDecide={decide} />

            <section aria-labelledby="shoppers-heading">
              <div className="section-head">
                <div>
                  <h2 id="shoppers-heading">Shoppers</h2>
                  <p className="quiet">They buy on their own, within your rules. You only hear from them when something's blocked.</p>
                </div>
                <button className="button is-lens" onClick={() => setAdding(true)}>
                  <PlusIcon size={18} /> New shopper
                </button>
              </div>

              {working.length === 0 ? (
                <div className="glass empty-card">
                  <p className="empty-title">Add your first shopper</p>
                  <p className="quiet">Have Mandate keep something stocked, connect your AI assistant, or share spending with someone you trust.</p>
                </div>
              ) : (
                <div className="shopper-grid">
                  {working.map((shopper, index) => (
                    <ShopperCard
                      key={shopper.id}
                      shopper={shopper}
                      tone={index}
                      busyLabel={busy[shopper.id] ?? null}
                      onShopNow={() => void shopNow(shopper)}
                      onTest={(kind) => void test(shopper, kind)}
                      onNewCode={() => void newCode(shopper)}
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
                <ActivityList items={showAll ? activity : activity.slice(0, LATEST_ROWS)} freshIds={freshIds} onOpen={setOpenItem} />
                {!showAll && activity.length > LATEST_ROWS && (
                  <button className="show-all" onClick={() => setShowAll(true)}>Show all {activity.length}</button>
                )}
              </section>

              <aside>
                <section className="glass panel" aria-labelledby="stores-heading">
                  <h2 id="stores-heading">Trusted stores</h2>
                  {trusted.length === 0 ? (
                    <p className="quiet">No trusted stores yet.</p>
                  ) : (
                    <ul className="stores">
                      {trusted.map((store) => (
                        <li key={store.address}>
                          <span className="store-mark"><ShieldIcon size={18} /></span>
                          <span>
                            <strong>{store.name}</strong>
                            <span className="quiet">{store.domain}</span>
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                  {untrusted.length > 0 && (
                    <>
                      <h3 className="stores-sub">Blocked</h3>
                      <ul className="stores is-blocked">
                        {untrusted.map((store) => (
                          <li key={store.address}>
                            <span className="store-mark is-not" aria-hidden="true">!</span>
                            <span>
                              <strong>{store.name}</strong>
                              <span className="quiet">{store.looksLike ? `Looks like ${store.looksLike}` : store.domain}</span>
                            </span>
                          </li>
                        ))}
                      </ul>
                    </>
                  )}
                </section>

                <section className="glass panel" aria-labelledby="protection-heading">
                  <h2 id="protection-heading">How you're protected</h2>
                  <ul className="protections">
                    <li>Shoppers never hold your money. Your account checks every payment against their rule.</li>
                    <li>Payments go to trusted stores only. Look-alikes are blocked.</li>
                    <li>Anything over a limit waits for you. Stop a shopper at any time.</li>
                  </ul>
                </section>
              </aside>
            </div>
          </>
        )}

        <p className="footnote">Running on the Stellar test network</p>
      </main>

      {adding && (
        <NewShopper
          onCreated={(shopper) => {
            toast("good", shopper.kind === "assistant" ? `${shopper.name} is waiting to connect.` : `${shopper.name} is ready. ${ruleSummary(shopper)}.`);
            void refresh();
          }}
          onClose={() => setAdding(false)}
        />
      )}
      {addingMoney && (
        <AddMoney
          onAdded={(amount) => {
            toast("good", `Added ${roundMoney(amount)} to your account.`);
            void refresh();
          }}
          onClose={() => setAddingMoney(false)}
        />
      )}
      {buyingShared && (
        <SharedBuy
          shared={buyingShared}
          onDone={(outcome) => {
            tellOutcome("You", outcome);
            void refresh();
          }}
          onClose={() => setBuyingShared(null)}
        />
      )}
      {openItem && (
        <ReceiptDialog
          item={openItem}
          shopper={shoppers.find((shopper) => shopper.id === openItem.shopper?.id)}
          ownerName={customer.name}
          onClose={() => setOpenItem(null)}
        />
      )}

      <div className="toasts" role="status" aria-live="polite">
        {toasts.map((entry) => (
          <p key={entry.id} className={`glass toast is-${entry.kind}`}>{entry.text}</p>
        ))}
      </div>
    </div>
  );
}

type Theme = "light" | "dark";

/** Dark unless the owner picked light with the toggle. */
function useTheme(): [Theme, () => void] {
  const [theme, setTheme] = useState<Theme>(() => (document.documentElement.dataset.theme === "light" ? "light" : "dark"));
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

function TopBar({ customer, onSignOut }: { customer: Customer | null; onSignOut?: () => void }) {
  const [theme, toggleTheme] = useTheme();
  const next = theme === "dark" ? "light" : "dark";
  return (
    <header className="glass topbar">
      <a className="brand" href="/">
        <Logo />
        mandate
      </a>
      <div className="topbar-side">
        {customer && <span className="owner-name">{customer.name}</span>}
        {onSignOut && <button type="button" className="link-button" onClick={onSignOut}>Sign out</button>}
        <button type="button" className="icon-button is-plain" onClick={toggleTheme} aria-label={`Switch to ${next} mode`} title={`Switch to ${next} mode`}>
          {theme === "dark" ? <SunIcon size={20} /> : <MoonIcon size={20} />}
        </button>
      </div>
    </header>
  );
}
