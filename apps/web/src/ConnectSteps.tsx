// How to connect an agent that holds its own key: a one-time code and where to use it.
import { useState } from "react";
import type { AccountAgent } from "@mandate/shared";
import { mcpCommand } from "./workflows.ts";

function useCopy() {
  const [copied, setCopied] = useState("");
  const copy = async (label: string, value: string) => {
    try { await navigator.clipboard.writeText(value); setCopied(label); setTimeout(() => setCopied(""), 2000); }
    catch { setCopied(""); }
  };
  return { copied, copy };
}

/** `brief`: ready-made instructions for the agent, when it was set up as a purchasing workflow. */
export function ConnectSteps({ agent, onNewCode, busy, brief }: { agent: AccountAgent; onNewCode: () => void; busy: boolean; brief?: string }) {
  const { copied, copy } = useCopy();
  const code = agent.pairing?.code ?? "";
  const expired = !agent.pairing || Date.parse(agent.pairing.expiresAt) <= Date.now();
  if (expired) return <div className="connect"><p className="muted">The connection code expired before {agent.name} used it.</p><button className="button" disabled={busy} onClick={onNewCode}>Make a new code</button></div>;
  return <div className="connect">
    <p className="muted">Give {agent.name} this one-time code. It works once and expires at {new Date(agent.pairing!.expiresAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}.</p>
    <button className="glass connect-code" onClick={() => void copy("code", code)} aria-label={`Connection code ${code}, copy`}>{code}<span className="connect-copy">{copied === "code" ? "Copied" : "Copy"}</span></button>
    <ol className="connect-steps">
      <li>Add Mandate to the agent once. For Claude Code: <code>{mcpCommand()}</code>. LangChain agents use <code>createMandateTools()</code>; scripts use <code>pnpm agent</code>.</li>
      {brief
        ? <li>Paste these instructions into the agent. It makes its own key, which never leaves it.<div className="brief"><pre>{brief}</pre><button className="button" type="button" onClick={() => void copy("brief", brief)}>{copied === "brief" ? "Copied" : "Copy instructions"}</button></div></li>
        : <li>Then ask it: <em>“Connect to Mandate with code {code}.”</em> It makes its own key, which never leaves it.</li>}
      <li>{brief ? "Its budget goes on Stellar the moment it connects." : "Give it a mandate."} It can only pay verified sellers, within the limit, until it expires. Your account checks every payment on Stellar.</li>
    </ol>
  </div>;
}
