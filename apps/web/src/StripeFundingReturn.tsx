import { useEffect, useState } from "react";
import { api } from "./api.ts";

export function StripeFundingReturn({ onDone }: { onDone: () => Promise<void> }) {
  const [params] = useState(() => new URLSearchParams(window.location.search));
  const [message, setMessage] = useState(params.get("funding") === "cancelled" ? "Stripe checkout cancelled. You can start another deposit." : "Confirming your Stripe test payment and account funding…");
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [visible, setVisible] = useState(true);
  const sessionId = params.get("session_id");
  useEffect(() => {
    if (params.get("funding") !== "success" || !sessionId) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const confirm = async () => {
      try {
        const result = await api.fiatFundingStatus(sessionId);
        if (!active) return;
        setError("");
        if (result.status === "paid") { setMessage("Stripe test payment confirmed. Funds have been added to your account."); await onDone(); }
        else if (result.status === "expired") setMessage("This Stripe checkout expired. Start a new deposit to try again.");
        else { setMessage("Waiting for Stripe payment confirmation. Your balance will update once funding completes."); timer = setTimeout(() => void confirm(), 3000); }
      } catch (cause) { if (active) setError(cause instanceof Error ? cause.message : "Could not confirm account funding"); }
    };
    void confirm();
    return () => { active = false; clearTimeout(timer); };
  }, [sessionId, params, attempt, onDone]);
  if (!visible || !["success", "cancelled"].includes(params.get("funding") ?? "")) return null;
  return <div className={`banner${error ? " is-bad" : ""}`} role={error ? "alert" : "status"}>
    {error || message}
    {error && <button className="button is-quiet" onClick={() => setAttempt(value => value + 1)}>Retry confirmation</button>}
    <button className="button is-quiet" onClick={() => {
      setVisible(false);
      const url = new URL(window.location.href);
      url.searchParams.delete("funding"); url.searchParams.delete("session_id");
      window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
    }}>Dismiss</button>
  </div>;
}
