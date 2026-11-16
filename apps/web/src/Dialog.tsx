// A centred modal. Closes on Escape and on a click outside the panel.
import { useEffect, useRef, type ReactNode } from "react";
import { CloseIcon } from "./icons.tsx";

interface DialogProps {
  title: string;
  onClose: () => void;
  children: ReactNode;
  /** "sheet" is one glass panel; "bare" leaves the glass to the content (the receipt). */
  variant?: "sheet" | "bare";
}

export function Dialog({ title, onClose, children, variant = "sheet" }: DialogProps) {
  const panel = useRef<HTMLDivElement>(null);
  // The latest onClose, without re-running the effect below on every render.
  const close = useRef(onClose);
  close.current = onClose;

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") close.current();
    };
    document.addEventListener("keydown", onKey);
    // Keep keyboard focus inside the dialog from the start, unless a field already took it.
    if (!panel.current?.contains(document.activeElement)) panel.current?.focus();
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div
      className="backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={panel}
        className={`dialog is-${variant}`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
      >
        <header className="dialog-header">
          <button className="icon-button" onClick={onClose} aria-label="Close">
            <CloseIcon size={20} />
          </button>
          <h2>{title}</h2>
          <span className="dialog-header-spacer" aria-hidden="true" />
        </header>
        {children}
      </div>
    </div>
  );
}
