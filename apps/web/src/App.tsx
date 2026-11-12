// Owner dashboard: every payment an agent made, newest first.
// TODO: mandate management (create, change limit, revoke) and owner sign-in.
import { useEffect, useState } from "react";
import { formatAmount, type Receipt } from "@mandate/shared";

const RECEIPTS_URL = import.meta.env.VITE_RECEIPTS_URL ?? "http://localhost:4022";
const EXPLORER_TX = "https://stellar.expert/explorer/testnet/tx/";

const short = (address: string) => `${address.slice(0, 4)}…${address.slice(-4)}`;

export function App() {
  const [receipts, setReceipts] = useState<Receipt[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const response = await fetch(`${RECEIPTS_URL}/receipts`);
        if (!response.ok) throw new Error(`Receipt service returned ${response.status}`);
        const body = (await response.json()) as Receipt[];
        if (!cancelled) {
          setReceipts(body);
          setError(null);
        }
      } catch (cause) {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
      }
    };
    void load();
    const timer = setInterval(load, 5000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  return (
    <main>
      <h1>Agent receipts</h1>
      {error && <p className="error">Can't reach the receipt service: {error}</p>}
      {!error && receipts.length === 0 && <p>No agent payments yet.</p>}
      {receipts.length > 0 && (
        <table>
          <thead>
            <tr>
              <th>When</th>
              <th>Agent</th>
              <th>Seller</th>
              <th>What</th>
              <th className="amount">Amount (USDC)</th>
              <th>Proof</th>
            </tr>
          </thead>
          <tbody>
            {receipts.map((receipt) => (
              <tr key={receipt.id}>
                <td>{new Date(receipt.paidAt).toLocaleString()}</td>
                <td>{receipt.annotation?.agentName ?? `Mandate #${receipt.contextRuleId}`}</td>
                <td title={receipt.seller}>
                  {receipt.annotation?.sellerDomain ?? short(receipt.seller)}
                </td>
                <td>{receipt.annotation?.description ?? receipt.annotation?.resource ?? "—"}</td>
                <td className="amount">{formatAmount(receipt.amount)}</td>
                <td>
                  <a href={`${EXPLORER_TX}${receipt.txHash}`} target="_blank" rel="noreferrer">
                    {short(receipt.txHash)}
                  </a>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </main>
  );
}
