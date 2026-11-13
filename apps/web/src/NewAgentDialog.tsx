// Form for giving a new agent permission to spend.
import { useState, type FormEvent } from "react";
import type { MandatePeriod, TokenInfo } from "@mandate/shared";
import { Dialog } from "./Dialog.tsx";
import { ShieldIcon } from "./icons.tsx";

const PERIODS: { value: MandatePeriod; label: string }[] = [
  { value: "day", label: "Daily" },
  { value: "week", label: "Weekly" },
  { value: "month", label: "Monthly" },
];

interface NewAgentDialogProps {
  token: TokenInfo;
  onCreate: (input: { name: string; limit: string; period: MandatePeriod }) => Promise<void>;
  onClose: () => void;
}

export function NewAgentDialog({ token, onCreate, onClose }: NewAgentDialogProps) {
  const [name, setName] = useState("");
  const [limit, setLimit] = useState("");
  const [period, setPeriod] = useState<MandatePeriod>("day");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setError(null);
    try {
      await onCreate({ name: name.trim(), limit: limit.trim(), period });
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Something went wrong");
      setSaving(false);
    }
  };

  const dollars = token.symbol === "USDC";

  return (
    <Dialog title="New agent" onClose={saving ? () => undefined : onClose}>
      <form className="form" onSubmit={submit}>
        <label className="field">
          <span>Agent name</span>
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="e.g. Travel booker"
            maxLength={20}
            required
            autoFocus
            disabled={saving}
          />
        </label>

        <div className="field-row">
          <label className="field">
            <span>Spending limit</span>
            <span className="input-affix">
              {dollars && <span>$</span>}
              <input
                value={limit}
                onChange={(event) => setLimit(event.target.value)}
                inputMode="decimal"
                pattern="\d+(\.\d{1,7})?"
                placeholder="0.00"
                required
                disabled={saving}
              />
              {!dollars && <span>{token.symbol}</span>}
            </span>
          </label>

          <fieldset className="field">
            <legend>Resets</legend>
            <div className="segmented">
              {PERIODS.map((option) => (
                <label key={option.value} className={period === option.value ? "is-selected" : ""}>
                  <input
                    type="radio"
                    name="period"
                    value={option.value}
                    checked={period === option.value}
                    onChange={() => setPeriod(option.value)}
                    disabled={saving}
                  />
                  {option.label}
                </label>
              ))}
            </div>
          </fieldset>
        </div>

        <p className="form-note">
          <ShieldIcon size={15} /> This agent will only be able to pay verified sellers.
        </p>

        {error && <p className="form-error">{error}</p>}

        <footer className="form-actions">
          <button type="button" className="button is-quiet" onClick={onClose} disabled={saving}>
            Cancel
          </button>
          <button type="submit" className="button is-primary" disabled={saving}>
            {saving ? "Setting up…" : "Create agent"}
          </button>
        </footer>
        {saving && <p className="muted form-wait">This takes about ten seconds.</p>}
      </form>
    </Dialog>
  );
}
