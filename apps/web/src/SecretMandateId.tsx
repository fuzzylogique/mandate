import { api } from "./api.ts";
import { MaskedValue } from "./MaskedValue.tsx";

/** The owner fetches a secret only after explicitly choosing Show or Copy. */
export function SecretMandateId({ reference, initialValue }: { reference: string; initialValue?: string }) {
  return <MaskedValue key={reference} label="Mandate ID" getValue={async () => initialValue ?? (await api.revealMandate(reference)).mandateId} showLabel="Show mandate" hideLabel="Hide mandate" copyLabel="Copy mandate ID" />;
}
