import { useSyncExternalStore } from "react";
import { SCHEMES, getThemeChoice, setThemeChoice, subscribeTheme, type ThemeChoice } from "../lib/theme";

/** Compact colour-scheme selector. Every mounted picker stays in sync through the theme store. */
export function ThemePicker({ className }: { className?: string }) {
  const choice = useSyncExternalStore(subscribeTheme, getThemeChoice, getThemeChoice);
  return <label className={className ? `theme-picker ${className}` : "theme-picker"}>
    <span className="theme-picker-swatch" aria-hidden="true" />
    <span className="theme-picker-label">Theme</span>
    <select className="theme-picker-select" value={choice} onChange={(event) => setThemeChoice(event.target.value as ThemeChoice)}>
      <option value="system">System (auto)</option>
      {SCHEMES.map((scheme) => <option key={scheme.id} value={scheme.id}>{scheme.name} — {scheme.description}</option>)}
    </select>
  </label>;
}

export default ThemePicker;
