// A deliberate confirmation: drag the knob to the end of the track.
// From the keyboard, Enter, Space or the right arrow does the same.
import { useEffect, useRef, useState, type KeyboardEvent, type MouseEvent, type PointerEvent } from "react";
import { ArrowIcon } from "./icons.tsx";

const KNOB = 56;
const INSET = 4;
/** How far along the track counts as "slid all the way". */
const COMPLETE_AT = 0.92;

interface SlideToConfirmProps {
  label: string;
  /** Shown in place of the label while the confirmed action runs. */
  busyLabel: string;
  busy: boolean;
  onConfirm: () => void;
  /** Change this to send the knob back to the start, e.g. after an error. */
  resetSignal: number;
}

export function SlideToConfirm({ label, busyLabel, busy, onConfirm, resetSignal }: SlideToConfirmProps) {
  const track = useRef<HTMLDivElement>(null);
  const drag = useRef({ pointerX: 0, startX: 0 });
  const [x, setX] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [done, setDone] = useState(false);

  useEffect(() => {
    setDone(false);
    setX(0);
  }, [resetSignal]);

  const travel = () => Math.max(0, (track.current?.clientWidth ?? 0) - KNOB - INSET * 2);

  const complete = () => {
    if (done || busy) return;
    setDone(true);
    setX(travel());
    onConfirm();
  };

  const onPointerDown = (event: PointerEvent<HTMLButtonElement>) => {
    if (done || busy) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { pointerX: event.clientX, startX: x };
    setDragging(true);
  };

  const onPointerMove = (event: PointerEvent<HTMLButtonElement>) => {
    if (!dragging) return;
    const next = drag.current.startX + event.clientX - drag.current.pointerX;
    setX(Math.max(0, Math.min(travel(), next)));
  };

  const release = (finished: boolean) => {
    if (!dragging) return;
    setDragging(false);
    if (finished && x >= travel() * COMPLETE_AT) complete();
    else setX(0);
  };

  // Keyboards and screen readers "click" without a pointer (detail 0); a mouse click is not a slide.
  const onClick = (event: MouseEvent) => {
    if (event.detail === 0) complete();
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === "ArrowRight") {
      event.preventDefault();
      complete();
    }
  };

  const progress = travel() > 0 ? x / travel() : 0;

  return (
    <div ref={track} className={`slide ${dragging ? "is-dragging" : ""} ${done ? "is-done" : ""}`}>
      <span className="slide-label" style={{ opacity: busy || done ? 1 : Math.max(0, 1 - progress * 1.6) }} aria-live="polite">
        {busy ? busyLabel : label}
      </span>
      <button
        type="button"
        className="slide-knob"
        style={{ transform: `translateX(${x}px)` }}
        aria-label={`${label}. Press Enter to confirm.`}
        aria-disabled={busy || done}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={() => release(true)}
        onPointerCancel={() => release(false)}
        onClick={onClick}
        onKeyDown={onKeyDown}
      >
        {busy ? <span className="spinner" aria-hidden="true" /> : <ArrowIcon size={22} />}
      </button>
    </div>
  );
}
