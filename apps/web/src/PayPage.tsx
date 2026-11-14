import { useEffect, useState, type FormEvent } from "react";
import type { MandatePaymentPreview, MandatePaymentResult, PaymentNetwork } from "@mandate/shared";
import { formatValue, money } from "./format.ts";
import { api } from "./api.ts";
import { Logo } from "./icons.tsx";

export function PayPage() {
  const [rail, setRail] = useState<"traditional" | "blockchain">(() => new URLSearchParams(window.location.search).get("rail") === "blockchain" ? "blockchain" : "traditional");
  const traditional = rail === "traditional";
  const [network, setNetwork] = useState<PaymentNetwork>();
  const [mandateId, setMandateId] = useState("");
  const [sellerAddress, setSellerAddress] = useState("");
  const [sellerName, setSellerName] = useState("");
  const [amount, setAmount] = useState("");
  const [reference, setReference] = useState("");
  const [requestId, setRequestId] = useState(() => crypto.randomUUID());
  const [preview, setPreview] = useState<MandatePaymentPreview | null>(null);
  const [result, setResult] = useState<MandatePaymentResult | null>(null);
  const [error, setError] = useState("");
  const [networkError, setNetworkError] = useState("");
  const [busy, setBusy] = useState<"check" | "pay" | null>(null);
  useEffect(() => {
    let active = true;
    const load = async () => {
      try {
        const data = await api.network();
        if (active) { setNetwork(data.network); setNetworkError(data.mode === "stellar-testnet" ? "" : "This payment page requires the Stellar testnet service."); }
      } catch (cause) { if (active) setNetworkError(cause instanceof Error ? cause.message : "Could not connect"); }
    };
    void load();
    const timer = setInterval(() => void load(), 10_000);
    return () => { active = false; clearInterval(timer); };
  }, []);
  const pending = result?.status === "pending";
  const completed = result?.status === "paid";
  const locked = !!busy || pending || completed;
  const change = (update: () => void) => { update(); setRequestId(crypto.randomUUID()); setPreview(null); setResult(null); setError(""); };
  const input = () => ({ mandateId: mandateId.trim(), sellerAddress: sellerAddress.trim(), sellerName: sellerName.trim(), amount: amount.trim(), reference: reference.trim(), requestId, rail });
  const check = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const checking = (event.nativeEvent as SubmitEvent).submitter?.getAttribute("value") === "check";
    setBusy(checking ? "check" : "pay"); setError("");
    try {
      if (checking) setPreview(await api.previewMandatePayment(input()));
      else {
        const next = await api.payWithMandate(input());
        // A mandate may expire or be revoked while a submitted payment is pending.
        // That cannot tell us whether the original transaction settled.
        if (pending && next.status === "declined") setError(`Confirmation could not be refreshed: ${next.reason}. Check the original transaction in the explorer; its outcome is still unconfirmed here.`);
        else setResult(next);
      }
    } catch (cause) { setError(cause instanceof Error ? cause.message : "The payment service could not complete this request"); }
    finally { setBusy(null); }
  };
  return <div className="page payment-page">
    <header className="topbar"><a className="brand" href="/"><Logo />Mandate</a><div className="topbar-side"><span className="pill">{traditional ? "Traditional banking demo" : network?.name ?? "Connecting…"}</span><a className="button" href="/">Owner dashboard</a></div></header>
    <main className="public-pay">
      <div className="page-title"><p className="eyebrow">THIRD-PARTY PAYMENT</p><h1>Pay with a mandate.</h1><p className="muted">Use a traditional or blockchain mandate to pay a verified account. No owner login is required.</p></div>
      <section className="card"><form className="form pay-form" onSubmit={event => void check(event)}>
        <label className="field">Payment method<select value={rail} disabled={locked} onChange={event => change(() => { setRail(event.target.value as typeof rail); setSellerAddress(""); setAmount(""); })}><option value="traditional">Traditional payment · hardcoded banking demo</option><option value="blockchain">Stellar account payment · blockchain</option></select></label>
        <fieldset className="field pay-fieldset"><legend>Mandate details</legend>
          <label className="field">Mandate ID<input type="password" required maxLength={128} value={mandateId} disabled={locked} onChange={e => change(() => setMandateId(e.target.value))} autoComplete="off" spellCheck={false} autoCapitalize="none" placeholder="mnd_…" /></label>
          <p className="muted">Your mandate ID is secret and authorizes this payment. It always stays masked here.</p>
        </fieldset>
        <fieldset className="field pay-fieldset"><legend>Seller details</legend>
          <label className="field">Seller name<input required maxLength={120} value={sellerName} disabled={locked} onChange={e => change(() => setSellerName(e.target.value))} placeholder="Seller display name" /></label>
          <label className="field">{traditional ? "Verified traditional recipient reference" : "Seller Stellar account address"}<input required maxLength={traditional ? 128 : 56} value={sellerAddress} disabled={locked} onChange={e => change(() => setSellerAddress(e.target.value))} placeholder={traditional ? "BANK_DEMO_… or DEMO-…" : "C…"} /></label>
          <p className="muted">{traditional ? "The recipient must be a traditional demo account marked verified in this app. No bank transfer is submitted." : "The recipient address is checked against the on-chain registry. The display name does not establish verification."}</p>
        </fieldset>
        <div className="field-row"><label className="field">Amount ({traditional ? "USD · demo" : network?.currency ?? "configured asset"})<input required inputMode="decimal" pattern={traditional ? "[0-9]+(\\.[0-9]{1,2})?" : "[0-9]+(\\.[0-9]{1,7})?"} value={amount} disabled={locked} onChange={e => change(() => setAmount(e.target.value))} placeholder="0.10" /></label><label className="field">Payment reference<input required maxLength={200} value={reference} disabled={locked} onChange={e => change(() => setReference(e.target.value))} placeholder="What are you paying for?" /></label></div>
        {preview && <div className="pay-checks"><h2>{preview.mandate.name}</h2><p className="muted">{formatValue(preview.mandate.spent, preview.currency)} of {money(preview.mandate.limit, preview.currency)} used · expires {new Date(preview.mandate.expiresAt).toLocaleString()}</p><ul>{preview.checks.map(item => <li key={item.label} className={item.passed ? "check-pass" : "check-fail"}><span aria-hidden="true">{item.passed ? "✓" : "×"}</span> {item.label}</li>)}</ul><p className="muted">{traditional ? "The service validates the demo mandate again when you submit." : "Checks are a preview. The contract validates the actual payment at submission."}</p></div>}
        {(networkError || error) && <p className="banner is-bad" role="alert">{networkError || error}</p>}
        {result && <div role="status" aria-live="polite" className={`pay-result ${result.status}`}>
          <h2>{result.status === "paid" ? "Payment succeeded" : result.status === "declined" ? "Payment declined" : "Awaiting confirmation"}</h2>
          {result.status === "paid" ? <><p>{money(result.payment.amount, result.payment.currency)} paid to {sellerName}.</p>{result.payment.explorerUrl ? <a href={result.payment.explorerUrl} target="_blank" rel="noreferrer">View transaction on Stellar ↗</a> : <p>Banking demo · simulated transfer. No real funds moved.</p>}</> : <p>{result.reason}</p>}
          {result.status === "pending" && <><p>Retry confirmation with the same request ID. Do not create another payment while this one is unconfirmed.</p><a href={`${network?.explorerUrl}/tx/${result.txHash}`} target="_blank" rel="noreferrer">View pending transaction ↗</a></>}
        </div>}
        <p className="workspace-note">Request ID: <code>{requestId}</code>. An unchanged retry is processed once.</p>
        <div className="form-actions">{completed ? <button className="button" type="button" onClick={() => { setResult(null); setPreview(null); setAmount(""); setReference(""); setRequestId(crypto.randomUUID()); }}>Start another payment</button> : <><button className="button" type="submit" value="check" disabled={!!busy || pending}>{busy === "check" ? "Checking…" : "Check mandate & seller"}</button><button className="button is-primary" type="submit" value="pay" disabled={!!busy || (!traditional && !network?.mandates)}>{busy === "pay" ? traditional ? "Processing demo payment…" : "Confirming on Stellar…" : pending ? "Check confirmation" : "Make payment"}</button></>}</div>
      </form></section>
      <p className="workspace-note">Traditional payments are simulated. Blockchain payments use Stellar testnet. A payment can be declined for an invalid mandate ID, an expired or revoked mandate, an unverified or incompatible recipient, an exceeded limit, or insufficient funds.</p>
    </main>
  </div>;
}
