// A centred modal. Closes on Escape and on a click outside the panel.
import { useEffect, useRef, type ReactNode } from "react";
import { CloseIcon } from "./icons.tsx";

interface DialogProps {
  title: string;
  onClose: () => void;
  children: ReactNode;
  /** Extra class on the panel, e.g. for the receipt's narrower width. */
  className?: string;
}

export function Dialog({ title, onClose, children, className }: DialogProps) {
  const panel = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    // Keep keyboard focus inside the dialog from the start.
    panel.current?.focus();
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      className="backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={panel}
        className={`dialog ${className ?? ""}`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
      >
        <header className="dialog-header">
          <h2>{title}</h2>
          <button className="icon-button" onClick={onClose} aria-label="Close">
            <CloseIcon size={18} />
          </button>
        </header>
        {children}
      </div>
    </div>
  );
}
