import { useCallback, useEffect, useRef, useState } from "react";
import type { AccountAgent, PaymentEntry, PaymentNetwork, PaymentWorkspace, SpendingAccount } from "@mandate/shared";
import { api, ApiError } from "./api.ts";
import { Agents } from "./Agents.tsx";
import { AccountForms, type AccountAction } from "./AccountForms.tsx";
import { NewMandate } from "./NewMandate.tsx";
import { MandateCard } from "./MandateCard.tsx";
import { ThemeToggle } from "./ThemeToggle.tsx";
import { PayPage } from "./PayPage.tsx";
import { ChatPage } from "./ChatPage.tsx";
import { SmartAccountAddress } from "./SmartAccountAddress.tsx";
import { SecretMandateId } from "./SecretMandateId.tsx";
import { SignIn } from "./SignIn.tsx";
import { StripeFundingReturn } from "./StripeFundingReturn.tsx";
import { initials, money, formatValue } from "./format.ts";
import { Logo, PlusIcon } from "./icons.tsx";

export function App() {
  const path = window.location.pathname.replace(/\/$/, "");
  return path === "/chat" ? <ChatPage /> : path === "/pay" ? <PayPage /> : <WorkspaceApp />;
}

function WorkspaceApp() {
  const pathname = window.location.pathname.replace(/\/$/, "");
  const page = pathname === "/agents" ? "agents" : pathname === "/activity" ? "activity" : "mandates";
  const [workspace, setWorkspace] = useState<PaymentWorkspace | null>(null);
  const [network, setNetwork] = useState<PaymentNetwork>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [action, setAction] = useState<AccountAction | null>(null);
  const [creatingMandate, setCreatingMandate] = useState(false);
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
      if (cause instanceof ApiError && cause.status === 401) { setWorkspace(null); setAction(null); setCreatingMandate(false); }
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
    try { await api.logout(); generation.current++; setWorkspace(null); setAction(null); setCreatingMandate(false); }
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
  const account = accounts[0];
  const title = page === "agents" ? "Agents" : page === "activity" ? "Activity" : "Mandates";
  const subtitle = page === "agents" ? "Identify the agents associated with your account." : page === "activity" ? "Follow your account funding and payments."
    : "Give people and agents permission to spend from your main account.";
  return <div className="page payment-page">
    <header className="glass topbar"><a className="brand" href="/"><Logo />Mandate</a><div className="topbar-side"><a className="button" href="/chat">Chat</a><a className="button" href="/pay">Pay</a><span className="pill">{network?.name ?? "Connecting…"}</span>{workspace && <><span className="owner"><span className="owner-avatar" aria-hidden="true">{initials(workspace.customer.name)}</span><span className="owner-name">{workspace.customer.name}</span></span><button className="button is-quiet" disabled={busy} onClick={() => void logout()}>Sign out</button></>}<ThemeToggle /></div></header>
    {error && <p className="banner is-bad" role="alert">{error} <button className="button is-quiet" onClick={() => void refresh()}>Retry</button></p>}
    {workspace && <StripeFundingReturn onDone={refresh} />}
    {loading ? <p className="loading muted">Loading your workspace…</p> : !workspace ? <SignIn onSignedIn={refresh} /> : <main>
      {account && <section className="hero main-account" aria-label="Main account">
        <div className="main-account-summary">
          <div><p className="eyebrow">Main account · {workspace.customer.name}</p><h2 className="balance hero-balance">{money(account.balance, account.currency)}</h2><Verification account={account} /><p className="muted">Your mandates spend from this balance.</p></div>
          <div className="main-account-stats"><p className="eyebrow">Active mandates</p><p className="parent-amount">{workspace.mandates.filter(mandate => mandate.status === "active").length}</p></div>
          <div className="account-buttons"><button className="button is-primary" onClick={() => setAction({ kind: "fund", account })}>Add funds</button><button className="button" onClick={() => setAction({ kind: "pay", account })}>Make payment</button></div>
        </div>
        <SmartAccountAddress address={account.address ?? account.id} />
        {account.explorerUrl && <a className="transaction-link" href={account.explorerUrl} target="_blank" rel="noreferrer">View account on Stellar ↗</a>}
        <p className="workspace-note">Share this address to receive payments.</p>
      </section>}
      <nav className="glass workspace-tabs" aria-label="Workspace"><a href="/agents" aria-current={page === "agents" ? "page" : undefined}>Agents <span>{workspace.agents.length}</span></a><a href="/mandates" aria-current={page === "mandates" ? "page" : undefined}>Mandates <span>{workspace.mandates.length}</span></a><a href="/activity" aria-current={page === "activity" ? "page" : undefined}>Activity</a></nav>
      <div className="section-header"><div className="page-title"><h1>{title}</h1><p className="muted">{subtitle}</p></div>{page === "mandates" && <button className="button is-primary" onClick={() => setCreatingMandate(true)}><PlusIcon /> New mandate</button>}</div>
      {page === "agents" && <Agents agents={workspace.agents} onDone={refresh} />}
      {page === "mandates" && <div className="mandates-layout"><section className="mandates-list-section">{workspace.mandates.length === 0 ? <p className="card empty">No mandates yet. Create one to share spending access to your account.</p> : <ul className="mandate-card-list">{workspace.mandates.map((mandate, index) => {
        const source = workspace.accounts.find(account => account.id === mandate.accountId);
        return <MandateCard key={mandate.reference} mandate={mandate} tone={index}><p className="muted">Source: {source?.name ?? mandate.accountId}</p><p className="parent-amount">{formatValue(mandate.spent, mandate.currency ?? source?.currency)} / {money(mandate.limit, mandate.currency ?? source?.currency)}</p><p className="muted">Per {mandate.period === "month" ? "30 days" : mandate.period === "week" ? "7 days" : "24 hours"} · expires {new Date(mandate.expiresAt).toLocaleDateString()}</p><p className="muted">Mandate user: {workspace.agents.find(agent => agent.id === mandate.recipient)?.name ?? mandate.recipient}</p><p className="muted">Allowed seller IDs: {mandate.sellerIds?.length ? mandate.sellerIds.join(", ") : "Any verified seller"}</p><div className="account-buttons"><a className="button" href="/pay">Open Pay page ↗</a>{source && <button className="button" onClick={() => setAction({ kind: "fund", account: source })}>Fund source account</button>}</div><SecretMandateId key={mandate.reference} reference={mandate.reference} />{(mandate.status === "active" || mandate.chainRevocationPending) && (confirmRevoke === mandate.reference ? <div className="confirm"><span>Revoke access?</span><button className="button is-danger" disabled={busy} onClick={() => void revoke(mandate.reference)}>Revoke</button><button className="button" disabled={busy} onClick={() => setConfirmRevoke(null)}>Cancel</button></div> : <button className="button is-quiet" onClick={() => setConfirmRevoke(mandate.reference)}>{mandate.chainRevocationPending ? "Retry revocation" : "Revoke mandate"}</button>)}</MandateCard>;
      })}</ul>}
        {workspace.shared.length > 0 && <><h2 className="shared-heading">Shared with you</h2><ul className="mandate-card-list">{workspace.shared.map(({ account, mandate, ownerName }) => <li className="card mandate-card" key={mandate.reference}><h3>{mandate.name}</h3><p className="muted">Allowed seller IDs: {mandate.sellerIds?.length ? mandate.sellerIds.join(", ") : "Any verified seller"}</p><p className="muted">{account.name} · shared by {ownerName}</p><p>{formatValue(mandate.spent, mandate.currency ?? account.currency)} / {money(mandate.limit, mandate.currency ?? account.currency)}</p><button className="button" disabled={mandate.status !== "active" || mandate.currency !== "USD"} onClick={() => setAction({ kind: "pay", account, mandate })}>Make payment</button></li>)}</ul></>}
      </section></div>}
      {page === "activity" && <Activity items={workspace.activity} accounts={workspace.accounts} agents={workspace.agents} />}
      <footer className="workspace-footer">Choose FIAT or Testnet when adding funds. All payments use demo USD on Stellar testnet. A mandate grants spending access to your main account.</footer>
    </main>}
    {workspace && creatingMandate && <NewMandate workspace={workspace} onDone={refresh} onClose={() => setCreatingMandate(false)} />}
    {workspace && action && <AccountForms key={JSON.stringify(action)} action={action} onDone={refresh} onClose={() => setAction(null)} />}
  </div>;
}

function Verification({ account }: { account: SpendingAccount }) {
  return <p className={account.verified ? "verified account-verification" : "form-error account-verification"}>{account.verified ? `✓ Verified recipient · on-chain registry` : "Unverified account"}</p>;
}
function Activity({ items, accounts, agents }: { items: PaymentEntry[]; accounts: SpendingAccount[]; agents: AccountAgent[] }) {
  return <section className="card">{items.length === 0 ? <p className="empty">Funding and payments will appear here.</p> : <ul className="ledger-list">{items.map(entry => <li key={entry.id}><span className="ledger-symbol" aria-hidden="true">{entry.kind === "funding" ? "+" : "↗"}</span><div className="ledger-main"><strong>{entry.kind === "funding" ? `Account funded · ${entry.source === "Stellar testnet funding" ? "Testnet" : "FIAT"}` : entry.reference}</strong><p className="muted">{accounts.find(account => account.id === entry.accountId)?.name ?? "Previous account activity"}</p>{entry.agentId && <p className="muted">Agent: {agents.find(agent => agent.id === entry.agentId)?.name ?? entry.agentId} · {entry.agentId}</p>}{entry.kind === "payment" && <SmartAccountAddress address={entry.destination} label="Recipient Smart Account address" />}<small className="muted">{new Date(entry.createdAt).toLocaleString()} · {entry.settlement === "traditional-demo" ? "Banking demo · simulated" : "Stellar testnet"}{entry.mandateReference ? " · Via mandate" : ""}</small>{entry.explorerUrl && <p><a className="transaction-link" href={entry.explorerUrl} target="_blank" rel="noreferrer">View transaction ↗</a></p>}</div><strong className="ledger-amount">{money(entry.amount, entry.currency)}</strong></li>)}</ul>}</section>;
}
