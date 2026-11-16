// How to connect an assistant: a one-time code and where to type it.
import { useState } from "react";
import type { Shopper } from "@mandate/shared/api";
import { fromNow } from "./format.ts";

export function ConnectSteps({ shopper }: { shopper: Shopper }) {
  const [copied, setCopied] = useState(false);
  const code = shopper.pairing?.code ?? "";
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  };
  return (
    <div className="connect">
      <p className="quiet">Give {shopper.name} this one-time code. It works once and expires {shopper.pairing ? fromNow(shopper.pairing.expiresAt) : "soon"}.</p>
      <button className="glass code" onClick={() => void copy()} aria-label={`Pairing code ${code}, click to copy`}>
        {code}
        <span className="code-copy">{copied ? "Copied" : "Copy"}</span>
      </button>
      <ol className="connect-steps">
        <li>Add Mandate to your assistant once. In Claude Code: <code>claude mcp add mandate -- node apps/agent/src/mcp.ts</code></li>
        <li>Then ask it: <em>"Connect to Mandate with code {code}."</em></li>
        <li>From then on, ask it to buy things. It checks your rules first, and the account blocks anything outside them.</li>
      </ol>
    </div>
  );
}
