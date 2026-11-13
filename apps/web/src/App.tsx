// The owner's dashboard: balance, agents and their limits, and everything the
// agents have bought or been refused.
import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import type { Activity, CatalogItem, Mandate, MandatePeriod, Overview } from "@mandate/shared";
import { ActivityList } from "./ActivityList.tsx";
import { AgentCard } from "./AgentCard.tsx";
import { api } from "./api.ts";
import { hueFor, initials, money, ruleSummary } from "./format.ts";
import { Logo, PlusIcon, ShieldIcon } from "./icons.tsx";
import { NewAgentDialog } from "./NewAgentDialog.tsx";
import { ReceiptDialog } from "./ReceiptDialog.tsx";

const REFRESH_MS = 4000;

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
  const [creating, setCreating] = useState(false);
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

  /** Runs one action for an agent, showing `label` on its card meanwhile. */
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

  const purchase = (mandate: Mandate, item: CatalogItem) =>
    withBusy(mandate.ruleId, `Buying ${item.title.toLowerCase()}…`, async () => {
      const result = await api.purchase(mandate.ruleId, item.id);
      if (result.status === "paid") {
        toast("good", `${mandate.name} paid ${item.seller.name} for a ${item.title.toLowerCase()}.`);
      } else {
        toast("bad", `${mandate.name}'s payment to ${item.seller.name} was declined: ${result.reason}.`);
      }
    });

  const revoke = (mandate: Mandate) =>
    withBusy(mandate.ruleId, "Revoking access…", async () => {
      await api.revokeAgent(mandate.ruleId);
      toast("good", `${mandate.name} can no longer spend from your account.`);
    });

  const createAgent = async (input: { name: string; limit: string; period: MandatePeriod }) => {
    const mandate = await api.createAgent(input);
    toast("good", `${mandate.name} is ready. ${ruleSummary(mandate)}.`);
    void refresh();
  };

  if (!overview) {
    return (
      <div className="page">
        <Header ownerName={null} />
        <main className="loading">
          {error ? <p className="banner is-bad">{error}</p> : <p className="muted">Loading your account…</p>}
        </main>
      </div>
    );
  }

  const { account, mandates, sellers, catalog, owner } = overview;
  const active = mandates.filter((mandate) => mandate.status === "active");
  const revoked = mandates.filter((mandate) => mandate.status === "revoked");
  const paidToday = activity.filter((item) => item.kind === "paid" && isToday(item.at));
  const declinedToday = activity.filter((item) => item.kind === "declined" && isToday(item.at));
  const spentToday = paidToday
    .filter((item) => item.token.id === account.token.id)
    .reduce((total, item) => total + BigInt(item.amount), 0n);

  return (
    <div className="page">
      <Header ownerName={owner.name} />

      <main>
        {error && <p className="banner is-bad">{error}</p>}

        <div className="page-title">
          <h1>Agent spending</h1>
          <p className="muted">See what your agents buy, and decide what they're allowed to.</p>
        </div>

        <section className="card hero" aria-label="Account summary">
          <div>
            <p className="eyebrow">Available balance</p>
            <p className="balance">{money(account.balance, account.token)}</p>
            <p className="muted">Your agents draw on this, each within its own limit.</p>
          </div>
          <dl className="stats">
            <div>
              <dt>Spent today</dt>
              <dd>{money(spentToday.toString(), account.token)}</dd>
            </div>
            <div>
              <dt>Active agents</dt>
              <dd>{active.length}</dd>
            </div>
            <div>
              <dt>Declined today</dt>
              <dd>{declinedToday.length}</dd>
            </div>
          </dl>
        </section>

        <section aria-labelledby="agents-heading">
          <div className="section-header">
            <div>
              <h2 id="agents-heading">Agents</h2>
              <p className="muted">Each agent spends only within the limit you set, and only at verified sellers.</p>
            </div>
            <button className="button is-primary" onClick={() => setCreating(true)}>
              <PlusIcon size={16} /> New agent
            </button>
          </div>
          {active.length === 0 ? (
            <p className="empty">No agents yet. Create one to let it spend on your behalf.</p>
          ) : (
            <div className="agent-grid">
              {active.map((mandate) => (
                <AgentCard
                  key={mandate.ruleId}
                  mandate={mandate}
                  catalog={catalog}
                  busyLabel={busy[mandate.ruleId] ?? null}
                  onPurchase={(item) => void purchase(mandate, item)}
                  onRevoke={() => void revoke(mandate)}
                />
              ))}
            </div>
          )}
          {revoked.length > 0 && (
            <ul className="revoked-list" aria-label="Agents whose access was revoked">
              <li className="revoked-label">Access revoked:</li>
              {revoked.map((mandate) => (
                <li key={mandate.ruleId}>
                  <span className="avatar" style={{ "--hue": hueFor(mandate.name) } as CSSProperties} aria-hidden="true">
                    {initials(mandate.name)}
                  </span>
                  {mandate.name}
                </li>
              ))}
            </ul>
          )}
        </section>

        <div className="columns">
          <section className="card" aria-labelledby="activity-heading">
            <div className="section-header is-inside">
              <h2 id="activity-heading">Activity</h2>
            </div>
            <ActivityList items={activity} freshIds={freshIds} onOpen={setOpenItem} />
          </section>

          <aside>
            <section className="card side" aria-labelledby="sellers-heading">
              <h2 id="sellers-heading">Verified sellers</h2>
              {sellers.length === 0 ? (
                <p className="muted">No verified sellers yet.</p>
              ) : (
                <ul className="sellers">
                  {sellers.map((seller) => (
                    <li key={seller.address}>
                      <span className="verified">
                        <ShieldIcon size={16} />
                      </span>
                      <span>
                        <strong>{seller.name}</strong>
                        <span className="muted">{seller.domain}</span>
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section className="card side" aria-labelledby="protection-heading">
              <h2 id="protection-heading">How you're protected</h2>
              <ul className="protections">
                <li>Agents never hold your money. Each one can spend only up to its limit.</li>
                <li>Payments go to verified sellers only. Look-alikes are refused.</li>
                <li>You can revoke an agent at any time.</li>
              </ul>
            </section>
          </aside>
        </div>
      </main>

      {creating && (
        <NewAgentDialog token={account.token} onCreate={createAgent} onClose={() => setCreating(false)} />
      )}
      {openItem && (
        <ReceiptDialog
          item={openItem}
          mandate={mandates.find((mandate) => mandate.ruleId === openItem.agent.ruleId)}
          ownerName={owner.name}
          onClose={() => setOpenItem(null)}
        />
      )}

      <div className="toasts" role="status" aria-live="polite">
        {toasts.map((entry) => (
          <p key={entry.id} className={`toast is-${entry.kind}`}>
            {entry.text}
          </p>
        ))}
      </div>
    </div>
  );
}

function Header({ ownerName }: { ownerName: string | null }) {
  return (
    <header className="topbar">
      <a className="brand" href="/">
        <Logo />
        Mandate
      </a>
      <div className="topbar-side">
        <span className="pill">Test network</span>
        {ownerName && (
          <span className="owner">
            <span className="owner-avatar" aria-hidden="true">
              {initials(ownerName)}
            </span>
            <span className="owner-name">{ownerName}</span>
          </span>
        )}
      </div>
    </header>
  );
}
