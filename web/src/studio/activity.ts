// Plain-language lines for the Studio activity panel. The ops console keeps the raw event names;
// clients see what happened, who did it and, for commands, the output.
import type { UiEvent } from "../types";

export type ActivityTone = "ok" | "bad" | "info" | "warn" | "dim";
export interface Activity {
  key: string;
  actorId: string | null;
  text: string;
  tone: ActivityTone;
  createdAt: string;
  /** Command output, shown when the line is expanded. */
  output?: { cmd: string; stdout: string; stderr: string; exitCode: number | null; timedOut: boolean; durationMs: number | null };
  link?: { href: string; label: string };
}

const HIDDEN = new Set(["message.created", "ws.connect", "ws.disconnect", "auth.ok", "file.read", "sandbox.exec.started", "ratelimit.hit",
  "sidekick.tool.denied", "sidekick.post.denied", "sidekick.people_only.denied", "devserver.preview.denied", "security.alert.acknowledged"]);

function text(detail: Record<string, unknown>, key: string): string {
  const value = detail[key];
  return typeof value === "string" ? value : typeof value === "number" ? String(value) : "";
}
function num(detail: Record<string, unknown>, key: string): number | null {
  const value = detail[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
const shortCmd = (cmd: string) => (cmd.length > 70 ? `${cmd.slice(0, 67)}…` : cmd);

/** Returns null for events that are noise to a client (messages already show in the chat). */
export function toActivity(event: UiEvent & { key?: string }, nameOf: (id: string | null) => string): Activity | null {
  if (HIDDEN.has(event.type)) return null;
  const detail = event.detail ?? {};
  const who = nameOf(event.actorId) || "Someone";
  const base = { key: event.key ?? event.id, actorId: event.actorId, createdAt: event.createdAt };
  switch (event.type) {
    case "room.created": return { ...base, text: `${who} opened this project room`, tone: "info" };
    case "room.joined": return { ...base, text: `${who} joined`, tone: "info" };
    case "room.left": return { ...base, text: `${who} left`, tone: "dim" };
    case "invite.created": return { ...base, text: `${who} created an invite${text(detail, "label") ? ` for ${text(detail, "label")}` : ""}`, tone: "dim" };
    case "invite.redeemed": return { ...base, text: `${text(detail, "name") || who} accepted an invite`, tone: "ok" };
    case "invite.revoked": return { ...base, text: `${who} cancelled an invite`, tone: "dim" };
    case "agent.updated": return { ...base, text: `${who} picked a new avatar`, tone: "dim" };
    case "sidekick.created": return { ...base, text: `${who} brought a sidekick, ${text(detail, "name")}`, tone: "info" };
    case "sidekick.signed_in": return { ...base, text: `${who} is signed in and ready`, tone: "ok" };
    case "sidekick.removed": return { ...base, text: `${who} sent their sidekick home`, tone: "dim" };
    case "sidekick.turn.started": return text(detail, "trigger") === "live" ? null : { ...base, text: `${who} started working`, tone: "warn" };
    case "sidekick.turn.finished": {
      const outcome = text(detail, "outcome");
      // A sidekick that listened in and had nothing to add leaves no trace.
      if (outcome === "quiet" || (text(detail, "trigger") === "live" && outcome !== "done")) return null;
      return { ...base, text: outcome === "done" ? `${who} finished` : outcome === "stopped" ? `${who} was stopped` : `${who} stopped`, tone: outcome === "done" ? "ok" : outcome === "stopped" ? "dim" : "bad" };
    }
    case "sidekick.stopped": return { ...base, text: `${who} stopped a sidekick`, tone: "dim" };
    case "sidekick.settings_updated": return { ...base, text: `${who} set their sidekick to ${({ live: "full live", mentions: "reply when mentioned", owner: "only them", paused: "paused" } as Record<string, string>)[text(detail, "live_mode")] ?? "new settings"}`, tone: "dim" };
    case "sidekick.activity": return { ...base, text: `${who} ${text(detail, "text") || "is working"}`, tone: "info" };
    case "sandbox.requested": return { ...base, text: `${who} is setting up the shared workspace`, tone: "warn" };
    case "sandbox.ready": return { ...base, text: "The shared workspace is ready", tone: "ok" };
    case "sandbox.error": return { ...base, text: "The shared workspace could not start", tone: "bad" };
    case "sandbox.stopped": return { ...base, text: "The shared workspace stopped", tone: "warn" };
    case "sandbox.exec.denied": return { ...base, text: `${who} tried a command that is not allowed`, tone: "bad" };
    case "file.write": {
      const path = text(detail, "path");
      if (text(detail, "operation") === "seed") return { ...base, text: `Project instructions were added (${path})`, tone: "dim" };
      return { ...base, text: `${who} saved ${path || "a file"}`, tone: "info" };
    }
    case "sandbox.exec.result": {
      const exitCode = num(detail, "exit_code");
      const timedOut = detail.timed_out === true || detail.timed_out === 1;
      const ok = exitCode === 0 && !timedOut;
      const cmd = text(detail, "cmd");
      const output = { cmd, stdout: text(detail, "stdout"), stderr: text(detail, "stderr"), exitCode, timedOut, durationMs: num(detail, "duration_ms") };
      const kind = text(detail, "kind");
      if (kind === "pull_request") {
        const url = text(detail, "pull_request");
        return { ...base, text: ok ? `${who} opened a pull request on ${text(detail, "repo")}` : `${who}'s pull request did not go through`, tone: ok ? "ok" : "bad", output,
          ...(url.startsWith("https://") ? { link: { href: url, label: "View on GitHub" } } : {}) };
      }
      if (kind === "git") {
        const repo = text(detail, "repo");
        const action = text(detail, "action") === "update" ? "updated" : "brought in";
        return { ...base, text: ok ? `${who} ${action} ${repo || "a repository"}` : `${who} could not fetch ${repo || "a repository"}`, tone: ok ? "ok" : "bad", output };
      }
      return { ...base, text: timedOut ? `${who} ran ${shortCmd(cmd)} — it took too long and was stopped` : ok ? `${who} ran ${shortCmd(cmd)}` : `${who} ran ${shortCmd(cmd)} — it failed`, tone: ok ? "ok" : "bad", output };
    }
    default: return null;
  }
}
