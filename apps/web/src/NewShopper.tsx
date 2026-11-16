// Adding a shopper. First: who does the shopping. Then the rule as one
// sentence with tappable words, and a slide to hand it over. An assistant then
// gets a one-time code to connect with.
import { useRef, useState, type ReactNode } from "react";
import type { Period, Shopper, ShopperKind } from "@mandate/shared/api";
import { api } from "./api.ts";
import { Dialog } from "./Dialog.tsx";
import { newRequestId, shortDate } from "./format.ts";
import { BasketIcon, ShieldIcon, SparkIcon, PersonIcon } from "./icons.tsx";
import { SlideToConfirm } from "./SlideToConfirm.tsx";
import { ConnectSteps } from "./ConnectSteps.tsx";

type Word = "name" | "item" | "amount" | "period" | "stores" | "holder";

const PERIODS: Period[] = ["day", "week", "month"];
const AMOUNT_PATTERN = /^\d+(\.\d{1,2})?$/;
const ITEMS = ["herbs", "basil", "olive oil", "napkins"];
const ENDS = new Date(Date.now() + 90 * 86_400_000).toISOString();

const KINDS: { kind: ShopperKind; title: string; text: string; icon: ReactNode }[] = [
  { kind: "hosted", title: "Mandate shops for you", text: "Keeps something stocked on a schedule. Compares stores and buys from the cheapest trusted one.", icon: <BasketIcon size={22} /> },
  { kind: "assistant", title: "Your AI assistant", text: "Let Claude, or another assistant you already use, buy for you within your rules.", icon: <SparkIcon size={22} /> },
  { kind: "person", title: "Someone you trust", text: "Share spending with a person on your team or in your household. They sign in to buy.", icon: <PersonIcon size={22} /> },
];

interface NewShopperProps {
  onCreated: (shopper: Shopper) => void;
  onClose: () => void;
}

export function NewShopper({ onCreated, onClose }: NewShopperProps) {
  const [kind, setKind] = useState<ShopperKind | null>(null);
  const [created, setCreated] = useState<Shopper | null>(null);

  if (created?.pairing) {
    return (
      <Dialog title="Connect your assistant" onClose={onClose}>
        <ConnectSteps shopper={created} />
        <button className="button is-lens is-wide" onClick={onClose}>Done</button>
      </Dialog>
    );
  }

  if (!kind) {
    return (
      <Dialog title="New shopper" onClose={onClose}>
        <p className="hint">Who does the shopping?</p>
        <div className="kind-list">
          {KINDS.map((option) => (
            <button key={option.kind} className="glass kind-option" onClick={() => setKind(option.kind)}>
              <span className="kind-icon">{option.icon}</span>
              <span>
                <strong>{option.title}</strong>
                <span className="quiet">{option.text}</span>
              </span>
            </button>
          ))}
        </div>
      </Dialog>
    );
  }

  return (
    <RuleSentence
      kind={kind}
      onBack={() => setKind(null)}
      onClose={onClose}
      onCreated={(shopper) => {
        onCreated(shopper);
        if (shopper.pairing) setCreated(shopper);
        else onClose();
      }}
    />
  );
}

function RuleSentence({ kind, onBack, onClose, onCreated }: { kind: ShopperKind; onBack: () => void; onClose: () => void; onCreated: (s: Shopper) => void }) {
  const picks = kind === "hosted" ? ["10", "25", "50"] : ["20", "50", "100"];
  const [name, setName] = useState(kind === "assistant" ? "Claude" : "");
  const [item, setItem] = useState("herbs");
  const [holder, setHolder] = useState("");
  const [amount, setAmount] = useState(picks[0]!);
  const [otherAmount, setOtherAmount] = useState(false);
  const [period, setPeriod] = useState<Period>("week");
  const [active, setActive] = useState<Word>(kind === "hosted" ? "item" : kind === "person" ? "holder" : "name");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [resetSignal, setResetSignal] = useState(0);
  const [requestId] = useState(newRequestId);
  const field = useRef<HTMLInputElement>(null);

  const hostedName = `${item.trim().replace(/^./, (c) => c.toUpperCase())} restock`;

  const stopAt = (word: Word, message: string) => {
    setError(message);
    setActive(word);
    setResetSignal((signal) => signal + 1);
    field.current?.focus();
  };

  const handOver = async () => {
    if (kind === "hosted" && !item.trim()) return stopAt("item", "Say what to keep stocked.");
    if (kind === "person" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(holder.trim())) return stopAt("holder", "Enter their email address.");
    if (kind !== "hosted" && !name.trim()) return stopAt("name", "Give it a name first.");
    if (!AMOUNT_PATTERN.test(amount) || Number(amount) <= 0) return stopAt("amount", "Enter an amount greater than zero.");
    setSaving(true);
    setError(null);
    try {
      const shopper = await api.createShopper({
        name: kind === "hosted" ? hostedName.slice(0, 40) : name.trim(),
        kind, limit: amount, period, expiresAt: ENDS, requestId,
        ...(kind === "hosted" ? { job: { item: item.trim(), every: period, startNow: true } } : {}),
        ...(kind === "person" ? { holder: holder.trim() } : {}),
      });
      onCreated(shopper);
    } catch (cause) {
      setSaving(false);
      setError(cause instanceof Error ? cause.message : "Something went wrong. Try again.");
      setResetSignal((signal) => signal + 1);
    }
  };

  const word = (id: Word, text: string, empty = false) => (
    <button
      type="button"
      className={`word ${active === id ? "is-active" : ""} ${empty ? "is-empty" : ""}`}
      aria-pressed={active === id}
      disabled={saving}
      onClick={() => setActive(id)}
    >
      {text}
    </button>
  );
  const amountWord = word("amount", `$${amount || "0"}`);
  const periodWord = word("period", period);
  const storesWord = word("stores", "trusted stores");

  return (
    <Dialog title="New shopper" onClose={saving ? () => undefined : onClose}>
      <p className="hint hint-row">
        <button className="link-button" onClick={onBack} disabled={saving}>← Who shops</button>
        <span>Tap any word to change it</span>
      </p>

      <div className="sentence-panel">
        {kind === "hosted" && (
          <p className="sentence">
            Keep {word("item", item.trim() || "something", !item.trim())} stocked. Spend up to {amountWord} every {periodWord} at {storesWord} only.
          </p>
        )}
        {kind === "assistant" && (
          <p className="sentence">
            Let {word("name", name.trim() || "my assistant", !name.trim())} spend up to {amountWord} every {periodWord} at {storesWord} only.
          </p>
        )}
        {kind === "person" && (
          <p className="sentence">
            Let {word("holder", holder.trim() || "their email", !holder.trim())} spend up to {amountWord} every {periodWord} at {storesWord} only.
          </p>
        )}
      </div>

      <div className="editor">
        {active === "item" && (
          <>
            <div className="chips" role="group" aria-label="What to keep stocked">
              {ITEMS.map((pick) => (
                <button key={pick} type="button" className={`chip ${item === pick ? "is-selected" : ""}`} aria-pressed={item === pick} disabled={saving} onClick={() => setItem(pick)}>
                  {pick}
                </button>
              ))}
            </div>
            <label className="text-field">
              <span>Or type it</span>
              <input ref={field} value={item} onChange={(e) => setItem(e.target.value)} maxLength={40} disabled={saving} />
            </label>
          </>
        )}
        {active === "name" && (
          <label className="text-field">
            <span>What you call it</span>
            <input ref={field} value={name} onChange={(e) => setName(e.target.value)} placeholder="Claude" maxLength={40} autoFocus disabled={saving} />
          </label>
        )}
        {active === "holder" && (
          <>
            <label className="text-field">
              <span>Their email</span>
              <input ref={field} type="email" value={holder} onChange={(e) => setHolder(e.target.value)} placeholder="sam@example.com" autoFocus disabled={saving} />
            </label>
            <label className="text-field">
              <span>Name it</span>
              <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Sam's supplies" maxLength={40} disabled={saving} />
            </label>
          </>
        )}
        {active === "amount" && (
          <>
            <div className="chips" role="group" aria-label="How much">
              {picks.map((pick) => (
                <button key={pick} type="button" className={`chip ${!otherAmount && amount === pick ? "is-selected" : ""}`} aria-pressed={!otherAmount && amount === pick} disabled={saving} onClick={() => { setOtherAmount(false); setAmount(pick); }}>
                  ${pick}
                </button>
              ))}
              <button type="button" className={`chip ${otherAmount ? "is-selected" : ""}`} aria-pressed={otherAmount} disabled={saving} onClick={() => setOtherAmount(true)}>
                Other
              </button>
            </div>
            {otherAmount && (
              <label className="text-field">
                <span>Amount, $</span>
                <input ref={field} value={amount} onChange={(e) => setAmount(e.target.value.trim())} inputMode="decimal" placeholder="75" autoFocus disabled={saving} />
              </label>
            )}
          </>
        )}
        {active === "period" && (
          <div className="chips" role="group" aria-label="How often the amount refills">
            {PERIODS.map((option) => (
              <button key={option} type="button" className={`chip ${period === option ? "is-selected" : ""}`} aria-pressed={period === option} disabled={saving} onClick={() => setPeriod(option)}>
                Every {option}
              </button>
            ))}
          </div>
        )}
        {active === "stores" && (
          <p className="editor-note">Shoppers can only pay stores on your trusted list. This one isn't optional.</p>
        )}
      </div>

      <p className="assurance">
        <ShieldIcon size={20} />
        <span>
          {kind === "hosted"
            ? "It compares every store and buys from the cheapest trusted one. Anything over the limit is stopped before money moves, and you're asked."
            : "Anything over the limit, or at a store that isn't trusted, is stopped before any money moves. You're asked what to do."}
        </span>
      </p>

      {error && <p className="form-error" role="alert">{error}</p>}

      <SlideToConfirm
        label="Slide to hand it over"
        busyLabel="Setting up… about ten seconds"
        busy={saving}
        onConfirm={() => void handOver()}
        resetSignal={resetSignal}
      />
      <p className="fineprint">Ends {shortDate(ENDS)}. You can stop it at any time.</p>
    </Dialog>
  );
}
