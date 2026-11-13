// Small inline icons. All inherit the current text colour.
import type { ReactNode } from "react";

function Icon({ children, size = 16 }: { children: ReactNode; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

type Props = { size?: number };

export const CheckIcon = ({ size }: Props) => (
  <Icon size={size}>
    <path d="M5 12.5l4.5 4.5L19 7.5" />
  </Icon>
);

export const BlockedIcon = ({ size }: Props) => (
  <Icon size={size}>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M6 18L18 6" />
  </Icon>
);

export const ShieldIcon = ({ size }: Props) => (
  <Icon size={size}>
    <path d="M12 3l7 3v5.5c0 4.2-2.8 7.6-7 9.5-4.2-1.900-7-5.300-7-9.500V6l7-3z" />
    <path d="M9 12l2.200 2.200L15.200 10" />
  </Icon>
);

export const PlusIcon = ({ size }: Props) => (
  <Icon size={size}>
    <path d="M12 5v14M5 12h14" />
  </Icon>
);

export const CloseIcon = ({ size }: Props) => (
  <Icon size={size}>
    <path d="M6 6l12 12M18 6L6 18" />
  </Icon>
);

export const ExternalIcon = ({ size }: Props) => (
  <Icon size={size}>
    <path d="M9 6h9v9M18 6L7 17" />
  </Icon>
);

export const ChevronIcon = ({ size }: Props) => (
  <Icon size={size}>
    <path d="M9 6l6 6-6 6" />
  </Icon>
);

/** The Mandate mark: a seal with a check. */
export const Logo = () => (
  <svg width="28" height="28" viewBox="0 0 28 28" aria-hidden="true">
    <rect width="28" height="28" rx="8" fill="var(--accent)" />
    <path
      d="M8.500 14.500l3.700 3.700 7.300-8.200"
      fill="none"
      stroke="var(--on-accent)"
      strokeWidth="2.600"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);
