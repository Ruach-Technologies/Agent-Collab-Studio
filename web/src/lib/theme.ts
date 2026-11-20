// Colour-scheme selection for the console. The active scheme is the `data-theme`
// attribute on <html>; styles.css defines the tokens for each id listed here.
// main.tsx imports this module first, so the stored choice is applied before
// React renders. The hub's Content-Security-Policy (script-src 'self') blocks
// inline scripts, which is why there is no inline boot snippet in index.html.

export const THEME_STORAGE_KEY = "agent-collab-hub.theme";

export interface Scheme {
  id: string;
  name: string;
  kind: "dark" | "light";
  description: string;
}

export const SCHEMES = [
  { id: "midnight", name: "Midnight", kind: "dark", description: "Cool dark" },
  { id: "daylight", name: "Daylight", kind: "light", description: "Clean light" },
  { id: "ember", name: "Ember", kind: "dark", description: "Warm dark" },
  { id: "paper", name: "Paper", kind: "light", description: "Soft sepia, low glare" },
  { id: "contrast", name: "Contrast", kind: "dark", description: "High contrast" },
] as const satisfies readonly Scheme[];

export type SchemeId = (typeof SCHEMES)[number]["id"];
export type ThemeChoice = SchemeId | "system";

/** Used until the person picks something. */
export const DEFAULT_THEME_CHOICE: ThemeChoice = "midnight";
const SYSTEM_DARK: SchemeId = "midnight";
const SYSTEM_LIGHT: SchemeId = "daylight";
const LIGHT_QUERY = "(prefers-color-scheme: light)";

const isSchemeId = (value: unknown): value is SchemeId => SCHEMES.some((scheme) => scheme.id === value);
const isChoice = (value: unknown): value is ThemeChoice => value === "system" || isSchemeId(value);

function readStored(): ThemeChoice | null {
  try {
    const value = window.localStorage.getItem(THEME_STORAGE_KEY);
    return isChoice(value) ? value : null;
  } catch {
    return null; // storage blocked or unavailable: fall back to the in-memory choice
  }
}

function systemPrefersLight(): boolean {
  try {
    return typeof window.matchMedia === "function" && window.matchMedia(LIGHT_QUERY).matches;
  } catch {
    return false;
  }
}

let choice: ThemeChoice = DEFAULT_THEME_CHOICE;
let started = false;
const listeners = new Set<() => void>();

/** The scheme a choice currently resolves to ("system" follows the OS). */
export function resolveTheme(value: ThemeChoice = choice): SchemeId {
  if (value !== "system") return value;
  return systemPrefersLight() ? SYSTEM_LIGHT : SYSTEM_DARK;
}

function apply(): void {
  if (typeof document === "undefined") return;
  const resolved = resolveTheme();
  if (document.documentElement.getAttribute("data-theme") !== resolved) document.documentElement.setAttribute("data-theme", resolved);
}

function update(next: ThemeChoice): void {
  choice = next;
  apply();
  listeners.forEach((listener) => listener());
}

export function getThemeChoice(): ThemeChoice {
  return choice;
}

/** Select a scheme (or "system"), apply it now and remember it when storage allows. */
export function setThemeChoice(next: ThemeChoice): void {
  if (!isChoice(next)) return;
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, next);
  } catch {
    // Not persisted; the choice still holds for this page.
  }
  update(next);
}

/** Subscribe to choice changes; returns an unsubscribe function. */
export function subscribeTheme(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** Read the stored choice, apply it and start following OS and other-tab changes. Safe to call repeatedly. */
export function initTheme(): void {
  if (typeof window === "undefined") return;
  choice = readStored() ?? DEFAULT_THEME_CHOICE;
  apply();
  if (started) return;
  started = true;
  try {
    const media = window.matchMedia(LIGHT_QUERY);
    const onSystemChange = () => { if (choice === "system") apply(); };
    if (typeof media.addEventListener === "function") media.addEventListener("change", onSystemChange);
    else media.addListener(onSystemChange);
  } catch {
    // No media query support: "system" stays on the dark scheme.
  }
  window.addEventListener("storage", (event) => {
    if (event.key !== null && event.key !== THEME_STORAGE_KEY) return;
    const stored = readStored() ?? DEFAULT_THEME_CHOICE;
    if (stored !== choice) update(stored);
  });
}

initTheme();
