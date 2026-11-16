import { useCallback, useEffect, useRef, useState } from "react";
import type { PaymentEntry, PaymentNetwork, PaymentWorkspace, SpendingAccount } from "@mandate/shared";
import { api, ApiError } from "./api.ts";
import { AccountForms, type AccountAction } from "./AccountForms.tsx";
import { AccountOpeningForm } from "./AccountOpeningForm.tsx";
import { CreateMandateForm } from "./CreateMandateForm.tsx";
import { PayPage } from "./PayPage.tsx";
import { SmartAccountAddress } from "./SmartAccountAddress.tsx";
import { SecretMandateId } from "./SecretMandateId.tsx";
import { SignIn } from "./SignIn.tsx";
import { initials, money, formatValue } from "./format.ts";
import { Logo, PlusIcon } from "./icons.tsx";

export function App() {
  return window.location.pathname.replace(/\/$/, "") === "/pay" ? <PayPage /> : <WorkspaceApp />;
}

function WorkspaceApp() {
  const pathname = window.location.pathname.replace(/\/$/, "");
  const page = pathname === "/accounts/new" ? "opening" : pathname === "/mandates" ? "mandates" : pathname === "/activity" ? "activity" : "accounts";
  const [workspace, setWorkspace] = useState<PaymentWorkspace | null>(null);
  const [network, setNetwork] = useState<PaymentNetwork>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(() => new URLSearchParams(window.location.search).get("account"));
  const [action, setAction] = useState<AccountAction | null>(null);
  const [confirmRevoke, setConfirmRevoke] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const generation = useRef(0);
  const refreshVersion = useRef(0);
  const refresh = useCallback(async () => {
    const session = generation.current;
    const version = ++refreshVersion.current;
    try {
      const data = await api.workspace();
      if (session === generation.current && version === refreshVersion.current) { setWorkspace(data); setNetwork(data.network); setError(""); }
    } catch (cause) {
      if (session !== generation.current || version !== refreshVersion.current) return;
      if (cause instanceof ApiError && cause.status === 401) { setWorkspace(null); setAction(null); }
      else setError(cause instanceof Error ? cause.message : "Could not load your workspace");
    } finally { if (session === generation.current && version === refreshVersion.current) setLoading(false); }
  }, []);
  useEffect(() => {
    const load = () => { void api.network().then(data => setNetwork(data.network)).catch(() => undefined); void refresh(); };
    const onFocus = () => { void refresh(); };
    const onVisibility = () => { if (document.visibilityState === "visible") void refresh(); };
    load();
    const timer = setInterval(load, 15_000);
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [refresh]);
  const logout = async () => {
    setBusy(true);
    try { await api.logout(); generation.current++; setWorkspace(null); setAction(null); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Could not sign out"); }
    finally { setBusy(false); }
  };
  const revoke = async (id: string) => {
    setBusy(true);
    try { await api.revoke(id); setConfirmRevoke(null); await refresh(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Could not revoke the mandate"); }
    finally { setBusy(false); }
  };
  const accounts = workspace?.accounts ?? [];
  const selected = accounts.find(account => account.id === selectedId) ?? accounts[0];
  const title = page === "opening" ? "Open an account" : page === "mandates" ? "Mandates" : page === "activity" ? "Payment activity" : "Your accounts";
  const subtitle = page === "opening" ? "Open a verified account, then choose how to add funds."
    : page === "mandates" ? "Give a person or agent permission to spend from an existing account."
    : page === "activity" ? "Follow account funding and payments on Stellar testnet."
    : "Verified accounts for receiving and sending payments. Create spending permissions in the Mandates tab.";
  return <div className="page payment-page">
    <header className="topbar"><a className="brand" href="/"><Logo />Mandate</a><div className="topbar-side"><a className="button" href="/pay">Pay</a><span className="pill">{network?.name ?? "Connecting…"}</span>{workspace && <><span className="owner"><span className="owner-avatar" aria-hidden="true">{initials(workspace.customer.name)}</span><span className="owner-name">{workspace.customer.name}</span></span><button className="button is-quiet" disabled={busy} onClick={() => void logout()}>Sign out</button></>}</div></header>
    {error && <p className="banner is-bad" role="alert">{error} <button className="button is-quiet" onClick={() => void refresh()}>Retry</button></p>}
    {loading ? <p className="loading muted">Loading your workspace…</p> : !workspace ? <SignIn onSignedIn={refresh} /> : <main>
      <section className="card parent-account" aria-label="Login profile">
        <div className="parent-heading"><span className="account-letter">{initials(workspace.customer.name)}</span><div><h2>{workspace.customer.name}</h2><p className="muted">{workspace.customer.email}</p><p className="muted">Your login manages accounts and holds no funds.</p></div></div>
        <div className="parent-balances"><div className="parent-stat"><p className="eyebrow">Financial accounts</p><p className="parent-amount">{accounts.length}</p></div><div className="parent-stat"><p className="eyebrow">Active mandates</p><p className="parent-amount">{workspace.mandates.filter(mandate => mandate.status === "active").length}</p></div></div>
      </section>
      <nav className="workspace-tabs" aria-label="Workspace"><a href="/" aria-current={page === "accounts" || page === "opening" ? "page" : undefined}>Accounts <span>{accounts.length}</span></a><a href="/mandates" aria-current={page === "mandates" ? "page" : undefined}>Mandates <span>{workspace.mandates.length}</span></a><a href="/activity" aria-current={page === "activity" ? "page" : undefined}>Activity</a></nav>
      <div className="section-header"><div className="page-title"><h1>{title}</h1><p className="muted">{subtitle}</p></div>{page === "accounts" && <a className="button is-primary" href="/accounts/new"><PlusIcon /> Open account</a>}{page === "opening" && <a className="button" href="/">Back to accounts</a>}</div>
      {page === "opening" && <section className="card account-opening-page"><AccountOpeningForm workspace={workspace} onDone={refresh} /></section>}
      {page === "accounts" && (accounts.length === 0 ? <section className="card welcome-empty"><span className="account-letter">+</span><h2>Open your first financial account</h2><p className="muted">Open an account, then choose FIAT or Testnet when you add funds.</p><a className="button is-primary" href="/accounts/new">Open an account</a></section> : <div className="account-layout">
        <section className="card account-tree" aria-label="Your accounts"><ul>{accounts.map(account => <li key={account.id}><button className={`tree-account ${selected?.id === account.id ? "is-selected" : ""}`} aria-pressed={selected?.id === account.id} onClick={() => setSelectedId(account.id)}><span className="small-letter">{initials(account.name)}</span><span><strong>{account.name}</strong><small>{account.currency} account · {money(account.balance, account.currency)}</small></span><span className={account.verified ? "verified" : "muted"}>{account.verified ? "✓" : "—"}</span></button></li>)}</ul></section>
        {selected && <section className="card account-detail"><div className="detail-heading"><div><span className="pill">{selected.currency} account</span><h2>{selected.name}</h2><Verification account={selected} /></div><span className="account-letter">{initials(selected.name)}</span></div><p className="balance">{money(selected.balance, selected.currency)}</p><p className="muted">Live testnet balance.</p><div className="account-buttons account-detail-actions"><button className="button is-primary" onClick={() => setAction({ kind: "fund", account: selected })}> Add funds</button><button className="button" onClick={() => setAction({ kind: "pay", account: selected })}>Make payment</button><a className="button" href="/mandates">Create a mandate</a></div>
          <SmartAccountAddress address={selected.address ?? selected.id} />
          {selected.explorerUrl && <p><a className="transaction-link" href={selected.explorerUrl} target="_blank" rel="noreferrer">View account on Stellar ↗</a></p>}
          <p className="workspace-note">Share this address to receive payments.</p>
        </section>}
      </div>)}
      {page === "mandates" && <div className="mandates-layout"><CreateMandateForm workspace={workspace} onDone={refresh} /><section className="mandates-list-section"><h2>Your mandates</h2>{workspace.mandates.length === 0 ? <p className="card empty">No mandates yet. Choose a source account to create one.</p> : <ul className="mandate-card-list">{workspace.mandates.map(mandate => {
        const source = workspace.accounts.find(account => account.id === mandate.accountId);
        return <li className="card mandate-card" key={mandate.reference}><div className="mandate-top"><h3>{mandate.name}</h3><span className={`status ${mandate.status === "active" ? "is-on" : ""}`}>{mandate.chainRevocationPending ? "Revocation pending" : mandate.status}</span></div><p className="pill mandate-method">Mandate</p><p className="muted">Source: {source?.name ?? mandate.accountId}</p><p className="parent-amount">{formatValue(mandate.spent, mandate.currency ?? source?.currency)} / {money(mandate.limit, mandate.currency ?? source?.currency)}</p><p className="muted">Per {mandate.period === "month" ? "30 days" : mandate.period === "week" ? "7 days" : "24 hours"} · expires {new Date(mandate.expiresAt).toLocaleDateString()}</p><p className="muted">Holder: {mandate.recipient}</p><p className="muted">Allowed seller IDs: {mandate.sellerIds?.length ? mandate.sellerIds.join(", ") : "Any verified seller"}</p><div className="account-buttons"><a className="button" href="/pay">Open Pay page ↗</a>{source && <button className="button" onClick={() => setAction({ kind: "fund", account: source })}>Fund source account</button>}</div><SecretMandateId key={mandate.reference} reference={mandate.reference} />{(mandate.status === "active" || mandate.chainRevocationPending) && (confirmRevoke === mandate.reference ? <div className="confirm"><span>Revoke access?</span><button className="button is-danger" disabled={busy} onClick={() => void revoke(mandate.reference)}>Revoke</button><button className="button" disabled={busy} onClick={() => setConfirmRevoke(null)}>Cancel</button></div> : <button className="button is-quiet" onClick={() => setConfirmRevoke(mandate.reference)}>{mandate.chainRevocationPending ? "Retry revocation" : "Revoke mandate"}</button>)}</li>;
      })}</ul>}
        {workspace.shared.length > 0 && <><h2 className="shared-heading">Shared with you</h2><ul className="mandate-card-list">{workspace.shared.map(({ account, mandate, ownerName }) => <li className="card mandate-card" key={mandate.reference}><h3>{mandate.name}</h3><p className="muted">Allowed seller IDs: {mandate.sellerIds?.length ? mandate.sellerIds.join(", ") : "Any verified seller"}</p><p className="muted">{account.name} · shared by {ownerName}</p><p>{formatValue(mandate.spent, mandate.currency ?? account.currency)} / {money(mandate.limit, mandate.currency ?? account.currency)}</p><button className="button" disabled={mandate.status !== "active" || mandate.currency !== "USD"} onClick={() => setAction({ kind: "pay", account, mandate })}>Make payment</button></li>)}</ul></>}
      </section></div>}
      {page === "activity" && <Activity items={workspace.activity} accounts={workspace.accounts} />}
      <footer className="workspace-footer">Choose FIAT or Testnet when adding funds. All payments use demo USD on Stellar testnet. A mandate grants spending access to an existing account.</footer>
    </main>}
    {workspace && action && <AccountForms key={JSON.stringify(action)} action={action} onDone={refresh} onClose={() => setAction(null)} />}
  </div>;
}

function Verification({ account }: { account: SpendingAccount }) {
  return <p className={account.verified ? "verified account-verification" : "form-error account-verification"}>{account.verified ? `✓ Verified recipient · on-chain registry` : "Unverified account"}</p>;
}
function Activity({ items, accounts }: { items: PaymentEntry[]; accounts: SpendingAccount[] }) {
  return <section className="card">{items.length === 0 ? <p className="empty">Funding and payments will appear here.</p> : <ul className="ledger-list">{items.map(entry => <li key={entry.id}><span className="ledger-symbol" aria-hidden="true">{entry.kind === "funding" ? "+" : "↗"}</span><div className="ledger-main"><strong>{entry.kind === "funding" ? `Account funded · ${entry.source === "Stellar testnet funding" ? "Testnet" : "FIAT"}` : entry.reference}</strong><p className="muted">{accounts.find(account => account.id === entry.accountId)?.name ?? "Previous account activity"}</p>{entry.kind === "payment" && <SmartAccountAddress address={entry.destination} label="Recipient Smart Account address" />}<small className="muted">{new Date(entry.createdAt).toLocaleString()} · {entry.settlement === "traditional-demo" ? "Banking demo · simulated" : "Stellar testnet"}{entry.mandateReference ? " · Via mandate" : ""}</small>{entry.explorerUrl && <p><a className="transaction-link" href={entry.explorerUrl} target="_blank" rel="noreferrer">View transaction ↗</a></p>}</div><strong className="ledger-amount">{money(entry.amount, entry.currency)}</strong></li>)}</ul>}</section>;
}
