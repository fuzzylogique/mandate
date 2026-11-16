// Adding a shopper: the rule is one sentence, each word is tappable, and the
// owner slides to hand it over.
import { useRef, useState } from "react";
import type { MandatePeriod, TokenInfo } from "@mandate/shared";
import { Dialog } from "./Dialog.tsx";
import { isDollars } from "./format.ts";
import { ShieldIcon } from "./icons.tsx";
import { SlideToConfirm } from "./SlideToConfirm.tsx";

type Word = "name" | "amount" | "period" | "stores";

const PERIODS: MandatePeriod[] = ["day", "week", "month"];
const AMOUNT_PATTERN = /^\d+(\.\d{1,7})?$/;

interface NewShopperProps {
  token: TokenInfo;
  onCreate: (input: { name: string; limit: string; period: MandatePeriod }) => Promise<void>;
  onClose: () => void;
}

export function NewShopper({ token, onCreate, onClose }: NewShopperProps) {
  const dollars = isDollars(token);
  const picks = dollars ? ["25", "50", "100", "200"] : ["1", "2", "5", "10"];

  const [name, setName] = useState("");
  const [amount, setAmount] = useState(picks[1]!);
  const [otherAmount, setOtherAmount] = useState(false);
  const [period, setPeriod] = useState<MandatePeriod>("week");
  const [active, setActive] = useState<Word>("name");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [resetSignal, setResetSignal] = useState(0);
  const nameInput = useRef<HTMLInputElement>(null);

  const amountText = (value: string) => (dollars ? `$${value}` : `${value} ${token.symbol}`);

  /** Stops the hand-over, points at the word that needs fixing and sends the slider back. */
  const stopAt = (word: Word, message: string) => {
    setError(message);
    setActive(word);
    setResetSignal((signal) => signal + 1);
    // A field that is already showing won't take focus on its own.
    if (word === "name") nameInput.current?.focus();
  };

  const handOver = async () => {
    const cleanName = name.trim();
    if (!cleanName) return stopAt("name", "Give your shopper a name first.");
    if (!AMOUNT_PATTERN.test(amount) || Number(amount) <= 0) {
      return stopAt("amount", "Enter an amount greater than zero.");
    }
    setSaving(true);
    setError(null);
    try {
      await onCreate({ name: cleanName, limit: amount, period });
      onClose();
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

  return (
    <Dialog title="New shopper" onClose={saving ? () => undefined : onClose}>
      <p className="hint">Tap any word to change it</p>

      <div className="sentence-panel">
        <p className="sentence">
          Let {word("name", name.trim() || "a name", !name.trim())} spend up to{" "}
          {word("amount", amountText(amount || "0"))} every {word("period", period)} at{" "}
          {word("stores", "trusted stores")} only.
        </p>
      </div>

      <div className="editor">
        {active === "name" && (
          <label className="text-field">
            <span>Name</span>
            <input
              ref={nameInput}
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Groceries"
              maxLength={20}
              autoFocus
              disabled={saving}
            />
          </label>
        )}

        {active === "amount" && (
          <>
            <div className="chips" role="group" aria-label="How much">
              {picks.map((pick) => (
                <button
                  key={pick}
                  type="button"
                  className={`chip ${!otherAmount && amount === pick ? "is-selected" : ""}`}
                  aria-pressed={!otherAmount && amount === pick}
                  disabled={saving}
                  onClick={() => {
                    setOtherAmount(false);
                    setAmount(pick);
                  }}
                >
                  {dollars ? `$${pick}` : pick}
                </button>
              ))}
              <button
                type="button"
                className={`chip ${otherAmount ? "is-selected" : ""}`}
                aria-pressed={otherAmount}
                disabled={saving}
                onClick={() => setOtherAmount(true)}
              >
                Other
              </button>
            </div>
            {otherAmount && (
              <label className="text-field">
                <span>{dollars ? "Amount, $" : `Amount, ${token.symbol}`}</span>
                <input
                  value={amount}
                  onChange={(event) => setAmount(event.target.value.trim())}
                  inputMode="decimal"
                  placeholder={dollars ? "75" : "3"}
                  autoFocus
                  disabled={saving}
                />
              </label>
            )}
          </>
        )}

        {active === "period" && (
          <div className="chips" role="group" aria-label="How often the amount refills">
            {PERIODS.map((option) => (
              <button
                key={option}
                type="button"
                className={`chip ${period === option ? "is-selected" : ""}`}
                aria-pressed={period === option}
                disabled={saving}
                onClick={() => setPeriod(option)}
              >
                Every {option}
              </button>
            ))}
          </div>
        )}

        {active === "stores" && (
          <p className="editor-note">
            Shoppers can only pay stores on your trusted list. This one isn't optional.
          </p>
        )}
      </div>

      <p className="assurance">
        <ShieldIcon size={20} />
        <span>Anything over the limit, or at a store that isn't trusted, is stopped before any money moves.</span>
      </p>

      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}

      <SlideToConfirm
        label="Slide to hand it over"
        busyLabel="Setting up… about ten seconds"
        busy={saving}
        onConfirm={() => void handOver()}
        resetSignal={resetSignal}
      />
      <p className="fineprint">You can stop a shopper at any time.</p>
    </Dialog>
  );
}
