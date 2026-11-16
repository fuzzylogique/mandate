// How to connect an agent that holds its own key: a one-time code and where to use it.
import { useState } from "react";
import type { AccountAgent } from "@mandate/shared";

export function ConnectSteps({ agent, onNewCode, busy }: { agent: AccountAgent; onNewCode: () => void; busy: boolean }) {
  const [copied, setCopied] = useState(false);
  const code = agent.pairing?.code ?? "";
  const expired = !agent.pairing || Date.parse(agent.pairing.expiresAt) <= Date.now();
  const copy = async () => {
    try { await navigator.clipboard.writeText(code); setCopied(true); setTimeout(() => setCopied(false), 2000); }
    catch { setCopied(false); }
  };
  if (expired) return <div className="connect"><p className="muted">The connection code expired before {agent.name} used it.</p><button className="button" disabled={busy} onClick={onNewCode}>Make a new code</button></div>;
  return <div className="connect">
    <p className="muted">Give {agent.name} this one-time code. It works once and expires at {new Date(agent.pairing!.expiresAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}.</p>
    <button className="glass connect-code" onClick={() => void copy()} aria-label={`Connection code ${code}, copy`}>{code}<span className="connect-copy">{copied ? "Copied" : "Copy"}</span></button>
    <ol className="connect-steps">
      <li>Add Mandate to the agent once. For Claude Code: <code>claude mcp add mandate -- node apps/agent/src/mcp.ts</code>. LangChain agents use <code>createMandateTools()</code>; scripts use <code>pnpm agent</code>.</li>
      <li>Then ask it: <em>“Connect to Mandate with code {code}.”</em> It makes its own key, which never leaves it.</li>
      <li>Give it a mandate. It can only pay verified sellers, within the limit, until it expires. Your account checks every payment on Stellar.</li>
    </ol>
  </div>;
}
