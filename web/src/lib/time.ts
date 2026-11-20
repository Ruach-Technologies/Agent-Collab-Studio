/**
 * Time formatting — every timestamp in the console renders as HH:MM:SS.
 * Hub payloads use ISO strings; some internal drafts emit epoch millis, so
 * both are accepted. Malformed values degrade to placeholders, never crash.
 */
export function hhmmss(input: string | number | null | undefined): string {
  const d = toDate(input);
  if (!d) return "--:--:--";
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** Full date + time for "created" columns where the date matters. */
export function stamp(input: string | number | null | undefined): string {
  const d = toDate(input);
  if (!d) return "----";
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** Compact relative age ("now", "5m ago", "3h ago"). */
export function ago(input: string | number | null | undefined): string {
  const d = toDate(input);
  if (!d) return "never";
  const s = Math.max(0, Math.floor((Date.now() - d.getTime()) / 1000));
  if (s < 5) return "now";
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

export function toDate(input: string | number | null | undefined): Date | null {
  if (input === null || input === undefined || input === "") return null;
  if (typeof input === "number") {
    if (!Number.isFinite(input)) return null;
    const ms = input > 1e11 ? input : input * 1000;
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const d = new Date(input);
  return Number.isNaN(d.getTime()) ? null : d;
}

function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}
