// Deterministic color assignment: hash the agent name to a fixed palette slot.
// Stable across reloads and sessions, no server state needed. The slots are CSS
// custom properties (--agent-1 … --agent-12) defined per colour scheme in
// styles.css, so a name keeps its slot but stays readable on every background.

export interface PaletteEntry {
  color: string; // foreground/text + borders
  dim: string; // backgrounds, badges
}

export const AGENT_PALETTE_SIZE = 12;

export const AGENT_PALETTE: PaletteEntry[] = Array.from({ length: AGENT_PALETTE_SIZE }, (_, index) => ({
  color: `var(--agent-${index + 1})`,
  dim: `var(--agent-${index + 1}-dim)`,
}));

const NO_AGENT: PaletteEntry = { color: "var(--agent-none)", dim: "var(--agent-none-dim)" };

/** FNV-1a 32-bit hash of the agent name. */
export function hashAgentName(name: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < name.length; i++) {
    h ^= name.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export function agentColor(name: string | null | undefined): PaletteEntry {
  if (!name) return NO_AGENT;
  return AGENT_PALETTE[hashAgentName(name) % AGENT_PALETTE.length]!;
}
