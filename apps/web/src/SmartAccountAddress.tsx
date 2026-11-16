import { MaskedValue } from "./MaskedValue.tsx";

export function SmartAccountAddress({ address, label = "Smart Account address" }: { address: string; label?: string }) {
  return <MaskedValue key={address} label={label} getValue={() => address} showLabel="Show Smart Account address" hideLabel="Hide Smart Account address" copyLabel="Copy Smart Account address" />;
}
