// Small inline icons. All inherit the current text colour.
import type { ReactNode } from "react";

function Icon({ children, size = 16, weight = 1.8 }: { children: ReactNode; size?: number; weight?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={weight}
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
  <Icon size={size} weight={2.2}>
    <path d="M5 12l5 5 9-10" />
  </Icon>
);

/** A shield with a check: a store on the trusted list. */
export const ShieldIcon = ({ size }: Props) => (
  <Icon size={size}>
    <path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z" />
    <path d="M9 12l2 2 4-4" />
  </Icon>
);

export const PlusIcon = ({ size }: Props) => (
  <Icon size={size} weight={2}>
    <path d="M12 5v14M5 12h14" />
  </Icon>
);

export const CloseIcon = ({ size }: Props) => (
  <Icon size={size} weight={2}>
    <path d="M6 6l12 12M18 6L6 18" />
  </Icon>
);

export const ChevronIcon = ({ size }: Props) => (
  <Icon size={size} weight={2}>
    <path d="M9 6l6 6-6 6" />
  </Icon>
);

export const ArrowIcon = ({ size }: Props) => (
  <Icon size={size} weight={2.2}>
    <path d="M5 12h14M13 6l6 6-6 6" />
  </Icon>
);

export const BasketIcon = ({ size }: Props) => (
  <Icon size={size}>
    <path d="M4 9h16l-1.500 10h-13zM8 9l4-5 4 5" />
  </Icon>
);

export const SunIcon = ({ size }: Props) => (
  <Icon size={size}>
    <circle cx="12" cy="12" r="4" />
    <path d="M12 2v2M12 20v2M4.900 4.900l1.400 1.400M17.700 17.700l1.400 1.400M2 12h2M20 12h2M4.900 19.100l1.400-1.400M17.700 6.300l1.400-1.400" />
  </Icon>
);

export const MoonIcon = ({ size }: Props) => (
  <Icon size={size}>
    <path d="M20 14.500A8 8 0 019.500 4a8 8 0 1010.500 10.500z" />
  </Icon>
);

/** The Mandate mark: a plain ring. */
export const Logo = () => (
  <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
    <circle cx="9" cy="9" r="7.500" fill="none" stroke="currentColor" strokeWidth="3" />
  </svg>
);
