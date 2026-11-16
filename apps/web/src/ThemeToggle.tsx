import { useState } from "react";
import { MoonIcon, SunIcon } from "./icons.tsx";

export function ThemeToggle() {
  const [theme, setTheme] = useState(() => document.documentElement.dataset.theme === "light" ? "light" : "dark");
  const next = theme === "dark" ? "light" : "dark";
  const toggle = () => {
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem("theme", next); } catch { /* Keep the choice for this page when storage is unavailable. */ }
    setTheme(next);
  };
  return <button type="button" className="icon-button is-plain" onClick={toggle} aria-label={`Switch to ${next} mode`} title={`Switch to ${next} mode`}>{theme === "dark" ? <SunIcon size={20} /> : <MoonIcon size={20} />}</button>;
}
