// REST client for /v1. Tokens are scoped to this browser tab with
// sessionStorage and are never logged or rendered after submission.
import type { ExecResult, FileEntry, GitCommitDetail, GitOverview, RepoResult, UiAgent, UiEvent, UiMessage, UiRoom } from "../types";
import {
  arrayPayload,
  normalizeAgent,
  normalizeEvent,
  normalizeExecResult,
  normalizeFileEntry,
  normalizeMessage,
  normalizeRoom,
  normalizeSandbox,
} from "./normalize";
import { freshDeviceKey, proof, SESSION_TOKEN } from "./device";

const BASE = "/v1";
export const TOKEN_KEY = "agent-collab-hub.token";
let memoryToken: string | null = null;

export function getToken(): string | null {
  try { return sessionStorage.getItem(TOKEN_KEY) ?? localStorage.getItem(TOKEN_KEY) ?? memoryToken; } catch { return memoryToken; }
}
/** `remember` keeps an invited client signed in on this device; a pasted token stays tab-only. */
export function saveToken(token: string, remember = false): void {
  memoryToken = token;
  try {
    sessionStorage.setItem(TOKEN_KEY, token);
    if (remember) localStorage.setItem(TOKEN_KEY, token); else localStorage.removeItem(TOKEN_KEY);
  } catch { /* memory-only environment */ }
}
export function clearToken(): void {
  memoryToken = null;
  try { sessionStorage.removeItem(TOKEN_KEY); localStorage.removeItem(TOKEN_KEY); } catch { /* unavailable storage */ }
}

// The local operator credential picks which workspace each request acts in.
export const WORKSPACE_KEY = "agent-collab-hub.workspace";
let memoryWorkspace: string | null = null;
export function getWorkspace(): string | null {
  try { return sessionStorage.getItem(WORKSPACE_KEY) ?? memoryWorkspace; } catch { return memoryWorkspace; }
}
export function saveWorkspace(workspace: string | null): void {
  memoryWorkspace = workspace;
  try { if (workspace) sessionStorage.setItem(WORKSPACE_KEY, workspace); else sessionStorage.removeItem(WORKSPACE_KEY); } catch { /* memory-only environment */ }
}

/** Fired when the hub says this browser's client session is over (time limit, sign-out, wrong device). */
export const SESSION_ENDED_EVENT = "agent-collab-hub.session-ended";
const SESSION_CODES = new Set(["SESSION_INVALID", "SESSION_ENDED", "SESSION_EXPIRED", "PROOF_REQUIRED", "PROOF_INVALID"]);

export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
    this.name = "ApiError";
  }
}

async function request<T>(path: string, method = "GET", body?: unknown, anonymous = false): Promise<T> {
  const token = getToken();
  if (!token && !anonymous) throw new ApiError(0, "NO_TOKEN", "no token set");
  // A client session signs every request with this browser's device key.
  const signedProof = token && SESSION_TOKEN.test(token) ? await proof(token, method, `${BASE}${path}`) : null;
  let response: Response;
  try {
    response = await fetch(`${BASE}${path}`, {
      method,
      redirect: "error",
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(signedProof ? { "X-Hub-Proof": signedProof } : {}),
        "ngrok-skip-browser-warning": "1",
        ...(getWorkspace() ? { "X-Hub-Workspace": getWorkspace()! } : {}),
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, "NETWORK", "network error — hub unreachable");
  }

  const rawText = await response.text();
  let payload: unknown = undefined;
  if (rawText) {
    try { payload = JSON.parse(rawText); } catch { payload = rawText; }
  }
  if (!response.ok) {
    const rec = payload !== null && typeof payload === "object" ? payload as Record<string, unknown> : {};
    const error = rec.error !== null && typeof rec.error === "object" ? rec.error as Record<string, unknown> : {};
    if (response.status === 401 && token && SESSION_TOKEN.test(token) && typeof error.code === "string" && SESSION_CODES.has(error.code)) {
      window.dispatchEvent(new CustomEvent(SESSION_ENDED_EVENT, { detail: { code: error.code, message: typeof error.message === "string" ? error.message : "" } }));
    }
    throw new ApiError(
      response.status,
      typeof error.code === "string" ? error.code : `HTTP_${response.status}`,
      typeof error.message === "string" ? error.message : response.statusText || "request failed",
    );
  }
  return payload as T;
}

function objectPayload(value: unknown, key: string): unknown {
  if (value !== null && typeof value === "object") {
    const result = (value as Record<string, unknown>)[key];
    if (result !== undefined) return result;
  }
  return value;
}

export interface SessionInfo {
  session: { id: string; via: string; createdAt: string; expiresAt: string } | null;
  passkeys: Array<{ id: string; label: string | null; createdAt: string; lastUsedAt: string | null }>;
  cycleHours: number;
}
export interface SignedIn { token: string; expiresAt: string; name: string; passkeys: number }
interface RawSignedIn { session_token: string; expires_at: string; agent: { name?: string }; passkeys: number }
const signedIn = (raw: RawSignedIn): SignedIn => ({ token: raw.session_token, expiresAt: raw.expires_at, name: String(raw.agent?.name ?? ""), passkeys: Number(raw.passkeys) || 0 });

export interface MemberProfile { id: string; name: string; role: string; avatar: string | null; guest: boolean; sidekickOf: string | null; }
export interface Sidekick {
  id: string; agentId: string; ownerId: string; provider: string; name: string; avatar: string | null;
  signIn: "signed_out" | "waiting_for_code" | "waiting_for_approval" | "signed_in"; working: boolean;
  current: { roomId: string; trigger: SidekickTrigger; startedAt: string; steps: number; posts: number } | null;
  settings: SidekickSettings;
  usage: SidekickUsage;
}
export type LiveMode = "live" | "mentions" | "owner" | "paused";
export type Banter = "chatty" | "brief" | "quiet";
export type SidekickTrigger = "owner" | "mention" | "live";
export interface SidekickSettings { liveMode: LiveMode; banter: Banter; jobsPerHour: number; jobsPerDay: number; stepsPerJob: number; tokensPerDay: number | null; }
export interface SidekickUsage {
  hourJobs: number; dayJobs: number; dayTokens: number; dayCachedTokens: number; dayCostUsd: number | null; dayMinutes: number; daySteps: number; dayPosts: number; dayLiveJobs: number;
  recent: Array<{ room: string; trigger: SidekickTrigger; startedAt: string; outcome: string | null; steps: number; tokens: number; durationMs: number | null }>;
}
const num = (value: unknown, fallback = 0) => (typeof value === "number" && Number.isFinite(value) ? value : fallback);
const trig = (value: unknown): SidekickTrigger => (value === "live" || value === "mention" ? value : "owner");
function toSidekick(value: unknown): Sidekick | null {
  if (value === null || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  return { id: String(row.id), agentId: String(row.agent_id), ownerId: String(row.owner_id), provider: String(row.provider), name: String(row.name),
    avatar: typeof row.avatar === "string" ? row.avatar : null,
    signIn: row.sign_in === "signed_in" || row.sign_in === "waiting_for_code" || row.sign_in === "waiting_for_approval" ? row.sign_in : "signed_out", working: row.working === true,
    current: row.current && typeof row.current === "object" ? (() => { const c = row.current as Record<string, unknown>;
      return { roomId: String(c.room_id), trigger: trig(c.trigger), startedAt: String(c.started_at), steps: num(c.steps), posts: num(c.posts) }; })() : null,
    settings: (() => { const c = (row.settings ?? {}) as Record<string, unknown>;
      return { liveMode: (["live", "mentions", "owner", "paused"].includes(String(c.live_mode)) ? c.live_mode : "live") as LiveMode,
        banter: (["chatty", "brief", "quiet"].includes(String(c.banter)) ? c.banter : "chatty") as Banter,
        jobsPerHour: num(c.jobs_per_hour, 20), jobsPerDay: num(c.jobs_per_day, 150), stepsPerJob: num(c.steps_per_job, 40),
        tokensPerDay: typeof c.tokens_per_day === "number" ? c.tokens_per_day : null }; })(),
    usage: (() => { const u = (row.usage ?? {}) as Record<string, unknown>;
      return { hourJobs: num(u.hour_jobs), dayJobs: num(u.day_jobs), dayTokens: num(u.day_tokens), dayCachedTokens: num(u.day_cached_tokens),
        dayCostUsd: typeof u.day_cost_usd === "number" ? u.day_cost_usd : null, dayMinutes: num(u.day_minutes), daySteps: num(u.day_steps), dayPosts: num(u.day_posts), dayLiveJobs: num(u.day_live_jobs),
        recent: (Array.isArray(u.recent) ? u.recent : []).map((item) => { const r = item as Record<string, unknown>;
          return { room: String(r.room ?? ""), trigger: trig(r.trigger), startedAt: String(r.started_at), outcome: typeof r.outcome === "string" ? r.outcome : null,
            steps: num(r.steps), tokens: num(r.tokens), durationMs: typeof r.duration_ms === "number" ? r.duration_ms : null }; }) }; })() };
}
export interface BoardPerson {
  agentId: string; linesAdded: number; linesRemoved: number; saves: number; commands: number; failed: number; checks: number; checksPassed: number;
  recent: Array<{ type: string; createdAt: string; detail: Record<string, unknown> }>;
}
export interface Board { rules: string; customRules: boolean; people: BoardPerson[]; }
const toBoard = (value: { rules?: unknown; custom_rules?: unknown; people?: unknown }): Board => ({
  rules: typeof value.rules === "string" ? value.rules : "", customRules: value.custom_rules === true,
  people: (Array.isArray(value.people) ? value.people : []).map((entry) => {
    const row = entry as Record<string, unknown>;
    const n = (key: string) => (typeof row[key] === "number" ? row[key] as number : 0);
    return { agentId: String(row.agent_id), linesAdded: n("lines_added"), linesRemoved: n("lines_removed"), saves: n("saves"), commands: n("commands"),
      failed: n("failed"), checks: n("checks"), checksPassed: n("checks_passed"),
      recent: (Array.isArray(row.recent) ? row.recent : []).map((item) => {
        const r = item as Record<string, unknown>;
        return { type: String(r.type), createdAt: String(r.created_at), detail: (r.payload && typeof r.payload === "object" ? r.payload : {}) as Record<string, unknown> };
      }) };
  }),
});
export interface InvitePreview { roomName: string; project: string | null; invitedBy: string; expiresAt: string; suggestedName: string | null; }

export const api = {
  async board(roomId: string): Promise<Board> {
    return toBoard(await request(`/rooms/${encodeURIComponent(roomId)}/board`));
  },
  /** Staff only. Null goes back to the default rules. */
  async saveRules(roomId: string, rules: string | null): Promise<Board> {
    return toBoard(await request(`/rooms/${encodeURIComponent(roomId)}/rules`, "PUT", { rules }));
  },
  async memberProfiles(roomId: string): Promise<MemberProfile[]> {
    return arrayPayload(await request(`/rooms/${encodeURIComponent(roomId)}/members`)).map((entry) => {
      const row = entry as Record<string, unknown>;
      return { id: String(row.agent_id), name: String(row.name ?? row.agent_id), role: String(row.role ?? "agent"),
        avatar: typeof row.avatar === "string" ? row.avatar : null, guest: row.guest === 1 || row.guest === true,
        sidekickOf: typeof row.sidekick_of === "string" ? row.sidekick_of : null };
    });
  },
  async mySidekick(): Promise<Sidekick | null> {
    return toSidekick((await request<{ sidekick: unknown }>("/sidekicks/mine")).sidekick);
  },
  async createSidekick(name: string, avatar: string, provider: "claude" | "codex"): Promise<Sidekick> {
    return toSidekick((await request<{ sidekick: unknown }>("/sidekicks", "POST", { name, avatar, provider })).sidekick)!;
  },
  /**
   * Starts the provider's own sign-in in the sidekick's container. Claude shows a code to paste back
   * ("paste"); ChatGPT shows a one-time code the owner types on OpenAI's page ("device").
   */
  async sidekickSignIn(id: string): Promise<{ url: string; code: string | null; method: "paste" | "device" }> {
    const payload = await request<{ url: string; code?: string | null; method?: string }>(`/sidekicks/${encodeURIComponent(id)}/sign-in`, "POST", {});
    return { url: payload.url, code: payload.code ?? null, method: payload.method === "device" ? "device" : "paste" };
  },
  async sidekickCancelSignIn(id: string): Promise<Sidekick> {
    return toSidekick((await request<{ sidekick: unknown }>(`/sidekicks/${encodeURIComponent(id)}/sign-in/cancel`, "POST", {})).sidekick)!;
  },
  async sidekickSettings(id: string, settings: Partial<SidekickSettings>): Promise<Sidekick> {
    const body: Record<string, unknown> = {};
    if (settings.liveMode !== undefined) body.live_mode = settings.liveMode;
    if (settings.banter !== undefined) body.banter = settings.banter;
    if (settings.jobsPerHour !== undefined) body.jobs_per_hour = settings.jobsPerHour;
    if (settings.jobsPerDay !== undefined) body.jobs_per_day = settings.jobsPerDay;
    if (settings.stepsPerJob !== undefined) body.steps_per_job = settings.stepsPerJob;
    if (settings.tokensPerDay !== undefined) body.tokens_per_day = settings.tokensPerDay;
    return toSidekick((await request<{ sidekick: unknown }>(`/sidekicks/${encodeURIComponent(id)}/settings`, "PATCH", body)).sidekick)!;
  },
  /** Stops what the sidekick is doing now; with pause, it also stops listening until turned back on. */
  async stopSidekick(id: string, pause = false): Promise<Sidekick> {
    return toSidekick((await request<{ sidekick: unknown }>(`/sidekicks/${encodeURIComponent(id)}/stop`, "POST", { pause })).sidekick)!;
  },
  async sidekickCode(id: string, code: string): Promise<Sidekick> {
    return toSidekick((await request<{ sidekick: unknown }>(`/sidekicks/${encodeURIComponent(id)}/sign-in/code`, "POST", { code })).sidekick)!;
  },
  async sidekickSignOut(id: string): Promise<void> {
    await request(`/sidekicks/${encodeURIComponent(id)}/sign-out`, "POST", {});
  },
  async removeSidekick(id: string): Promise<void> {
    await request(`/sidekicks/${encodeURIComponent(id)}`, "DELETE");
  },
  async updateAvatar(avatar: string): Promise<void> {
    await request("/me", "PATCH", { avatar });
  },
  async createInvite(roomId: string, label?: string): Promise<{ url: string | null; code: string; shareable: boolean; expiresAt: string }> {
    const payload = await request<{ url: string | null; code: string; shareable: boolean; invite: { expires_at: string } }>(
      `/rooms/${encodeURIComponent(roomId)}/invites`, "POST", label ? { label } : {});
    return { url: payload.url, code: payload.code, shareable: payload.shareable, expiresAt: payload.invite.expires_at };
  },
  /** Called before the visitor has an identity; a signed-in guest's token rides along if present. */
  async previewInvite(code: string): Promise<InvitePreview> {
    const payload = await request<{ room: { name: string; project: string | null }; invited_by: string; expires_at: string; suggested_name: string | null }>(
      "/invites/preview", "POST", { code }, true);
    return { roomName: payload.room.name, project: payload.room.project, invitedBy: payload.invited_by, expiresAt: payload.expires_at, suggestedName: payload.suggested_name };
  },
  /** A new person gets a session bound to a fresh device key; a signed-in client just gains the room. */
  async redeemInvite(code: string, name: string | undefined, avatar: string | undefined): Promise<{ token: string | null; roomId: string; passkeys: number }> {
    const device_key = name ? await freshDeviceKey() : undefined;
    const payload = await request<{ session_token: string | null; room: { id: string }; passkeys?: number }>("/invites/redeem", "POST",
      { code, ...(name ? { name } : {}), ...(avatar ? { avatar } : {}), ...(device_key ? { device_key } : {}) }, true);
    return { token: payload.session_token, roomId: payload.room.id, passkeys: num(payload.passkeys) };
  },
  async session(): Promise<SessionInfo> {
    const payload = await request<{ session: { id: string; via: string; created_at: string; expires_at: string } | null; passkeys: Array<{ id: string; label: string | null; created_at: string; last_used_at: string | null }>; cycle_hours: number }>("/session");
    return {
      session: payload.session ? { id: payload.session.id, via: payload.session.via, createdAt: payload.session.created_at, expiresAt: payload.session.expires_at } : null,
      passkeys: payload.passkeys.map((key) => ({ id: key.id, label: key.label, createdAt: key.created_at, lastUsedAt: key.last_used_at })),
      cycleHours: num(payload.cycle_hours, 3),
    };
  },
  async signOutSession(): Promise<void> { await request("/session/sign-out", "POST"); },
  /** Staff: a one-time link that signs a client back in (valid 15 minutes). */
  async signInLink(agentId: string): Promise<{ url: string; expiresAt: string; name: string }> {
    const payload = await request<{ url: string | null; path: string; expires_at: string; name: string }>(`/agents/${encodeURIComponent(agentId)}/sign-in-link`, "POST");
    return { url: payload.url ?? `${window.location.origin}${payload.path}`, expiresAt: payload.expires_at, name: payload.name };
  },
  async signInWithLink(code: string): Promise<SignedIn> {
    const device_key = await freshDeviceKey();
    return signedIn(await request<RawSignedIn>("/signin/link", "POST", { code, device_key }, true));
  },
  async passkeyLoginOptions(): Promise<{ challengeId: string; options: Record<string, unknown> }> {
    const payload = await request<{ challenge_id: string; options: Record<string, unknown> }>("/passkeys/login/options", "POST", undefined, true);
    return { challengeId: payload.challenge_id, options: payload.options };
  },
  async passkeyLoginVerify(challengeId: string, response: unknown): Promise<SignedIn> {
    const device_key = await freshDeviceKey();
    return signedIn(await request<RawSignedIn>("/passkeys/login/verify", "POST", { challenge_id: challengeId, response, device_key }, true));
  },
  async passkeyRegisterOptions(): Promise<Record<string, unknown>> { return request<Record<string, unknown>>("/passkeys/register/options", "POST"); },
  async passkeyRegisterVerify(response: unknown, label?: string): Promise<void> {
    await request("/passkeys/register/verify", "POST", { response, ...(label ? { label } : {}) });
  },
  async removePasskey(id: string): Promise<void> { await request(`/passkeys/${encodeURIComponent(id)}`, "DELETE"); },
  async whoami(): Promise<UiAgent & { operator: boolean }> {
    const payload = await request<{ agent: Record<string, unknown>; workspace?: { name?: string }; operator?: boolean }>("/whoami");
    return { ...normalizeAgent({ ...payload.agent, workspace_name: payload.workspace?.name }), operator: payload.operator === true };
  },
  async listWorkspaces(): Promise<Array<{ id: string; name: string }>> {
    return arrayPayload(await request<unknown>("/operator/workspaces")).map((entry) => {
      const row = entry as Record<string, unknown>;
      return { id: String(row.id), name: String(row.name) };
    });
  },
  async listAgents(): Promise<UiAgent[]> {
    return arrayPayload(await request<unknown>("/agents")).map(normalizeAgent);
  },
  async listRooms(): Promise<UiRoom[]> {
    return arrayPayload(await request<unknown>("/rooms")).map(normalizeRoom);
  },
  async createRoom(name: string, project?: string): Promise<UiRoom> {
    return normalizeRoom(objectPayload(await request("/rooms", "POST", { name, ...(project ? { project } : {}) }), "room"));
  },
  async listMembers(roomId: string): Promise<string[]> {
    return arrayPayload(await request(`/rooms/${encodeURIComponent(roomId)}/members`))
      .map((entry) => String((entry as { agent_id: string }).agent_id));
  },
  async sandboxStatus(roomId: string) {
    const row = objectPayload(await request(`/rooms/${encodeURIComponent(roomId)}/sandbox`), "sandbox");
    return row ? normalizeSandbox(row) : null;
  },
  async provisionSandbox(roomId: string) {
    return normalizeSandbox(objectPayload(await request(`/rooms/${encodeURIComponent(roomId)}/sandbox`, "POST", {}), "sandbox"));
  },
  async listExecs(sandboxId: string) {
    return arrayPayload(await request(`/sandboxes/${encodeURIComponent(sandboxId)}/execs`));
  },
  async listMessages(roomId: string): Promise<UiMessage[]> {
    return arrayPayload(await request<unknown>(`/rooms/${encodeURIComponent(roomId)}/messages`))
      .map(normalizeMessage)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  },
  async joinRoom(roomId: string): Promise<void> {
    await request(`/rooms/${encodeURIComponent(roomId)}/join`, "POST", {});
  },
  async postMessage(roomId: string, body: string, to?: string): Promise<UiMessage> {
    const payload = await request<unknown>(`/rooms/${encodeURIComponent(roomId)}/messages`, "POST", to ? { body, to } : { body });
    return normalizeMessage(objectPayload(payload, "message"));
  },
  async listEvents(): Promise<UiEvent[]> {
    return arrayPayload(await request<unknown>("/events"))
      .map(normalizeEvent)
      .filter((event): event is UiEvent => event !== null)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  },
  async sandboxExec(sandboxId: string, cmd: string): Promise<ExecResult> {
    const result = await request<unknown>(`/sandboxes/${encodeURIComponent(sandboxId)}/exec`, "POST", { cmd });
    return normalizeExecResult(objectPayload(result, "result"));
  },
  async listFiles(sandboxId: string, path: string): Promise<FileEntry[]> {
    const result = await request<unknown>(`/sandboxes/${encodeURIComponent(sandboxId)}/files?path=${encodeURIComponent(path)}`);
    return arrayPayload(result).map((entry) => normalizeFileEntry(entry, path));
  },
  async readFile(sandboxId: string, path: string): Promise<string> {
    const result = await request<unknown>(`/sandboxes/${encodeURIComponent(sandboxId)}/file?path=${encodeURIComponent(path)}`);
    const rec = result !== null && typeof result === "object" ? result as Record<string, unknown> : {};
    return typeof rec.content === "string" ? rec.content : "";
  },
  async writeFile(sandboxId: string, path: string, content: string): Promise<void> {
    await request(`/sandboxes/${encodeURIComponent(sandboxId)}/file`, "PUT", { path, content });
  },
  async gitRepos(sandboxId: string): Promise<string[]> {
    return arrayPayload(await request<unknown>(`/sandboxes/${encodeURIComponent(sandboxId)}/git/repos`)).map(String);
  },
  async gitLog(sandboxId: string, dir: string): Promise<GitOverview> {
    return request<GitOverview>(`/sandboxes/${encodeURIComponent(sandboxId)}/git/log?dir=${encodeURIComponent(dir)}`);
  },
  async gitCommit(sandboxId: string, dir: string, sha: string): Promise<GitCommitDetail> {
    return (await request<{ commit: GitCommitDetail }>(`/sandboxes/${encodeURIComponent(sandboxId)}/git/commit?dir=${encodeURIComponent(dir)}&sha=${sha}`)).commit;
  },
  async gitPatch(sandboxId: string, dir: string, sha: string, path: string): Promise<string> {
    return (await request<{ patch: string }>(`/sandboxes/${encodeURIComponent(sandboxId)}/git/commit?dir=${encodeURIComponent(dir)}&sha=${sha}&path=${encodeURIComponent(path)}`)).patch;
  },
  async gitCheckout(sandboxId: string, dir: string, branch: string): Promise<ExecResult> {
    return normalizeExecResult(await request<unknown>(`/sandboxes/${encodeURIComponent(sandboxId)}/git/checkout`, "POST", { dir, branch }));
  },
  async cloneRepo(sandboxId: string, repo: string, ref?: string): Promise<RepoResult> {
    const result = await request<unknown>(`/sandboxes/${encodeURIComponent(sandboxId)}/repos`, "POST", { repo, ...(ref ? { ref } : {}) });
    const rec = result !== null && typeof result === "object" ? result as Record<string, unknown> : {};
    return {
      ...normalizeExecResult(result),
      action: rec.action === "update" ? "update" : "clone",
      dir: typeof rec.dir === "string" ? rec.dir : "",
      seeded: Array.isArray(rec.seeded) ? rec.seeded.map(String) : [],
    };
  },
  // ---------- dev server preview ----------
  async devServerStatus(sandboxId: string): Promise<{
    state: "stopped" | "starting" | "running" | "exited"; cmd: string; dir: string; port: number; startedAt: string | null;
    startedBy: string | null; exitCode: number | null; listening: boolean; log: string; logTruncated: boolean;
    preview: { enabled: boolean; reachable: boolean; localOnly: boolean; message: string | null };
  }> {
    const payload = await request<Record<string, unknown>>(`/sandboxes/${encodeURIComponent(sandboxId)}/dev-server`);
    const dev = (payload?.dev_server ?? {}) as Record<string, unknown>;
    const preview = (payload?.preview ?? {}) as Record<string, unknown>;
    const state = ["starting", "running", "exited"].includes(String(dev.state)) ? dev.state as "starting" | "running" | "exited" : "stopped";
    return {
      state, cmd: typeof dev.cmd === "string" ? dev.cmd : "npm run dev", dir: typeof dev.dir === "string" ? dev.dir : "",
      port: typeof dev.port === "number" ? dev.port : 5173, startedAt: typeof dev.started_at === "string" ? dev.started_at : null,
      startedBy: typeof dev.started_by === "string" ? dev.started_by : null, exitCode: typeof dev.exit_code === "number" ? dev.exit_code : null,
      listening: dev.listening === true, log: typeof dev.log === "string" ? dev.log : "", logTruncated: dev.log_truncated === true,
      preview: { enabled: preview.enabled === true, reachable: preview.reachable === true, localOnly: preview.local_only === true,
        message: typeof preview.message === "string" ? preview.message : null },
    };
  },
  /** How Start would run the workspace's app, worked out by the hub from the cloned files; null when there is nothing to run. */
  async devServerPlan(sandboxId: string, port?: number): Promise<{ dir: string; installDir: string; cmd: string; port: number; framework: string; needsInstall: boolean; summary: string } | null> {
    const payload = await request<{ plan?: Record<string, unknown> | null }>(`/sandboxes/${encodeURIComponent(sandboxId)}/dev-server/plan${port ? `?port=${port}` : ""}`);
    const plan = payload?.plan;
    if (!plan || typeof plan.cmd !== "string" || typeof plan.dir !== "string") return null;
    return { dir: plan.dir, installDir: typeof plan.install_dir === "string" ? plan.install_dir : plan.dir, cmd: plan.cmd,
      port: typeof plan.port === "number" ? plan.port : 5173, framework: typeof plan.framework === "string" ? plan.framework : "App",
      needsInstall: plan.needs_install === true, summary: typeof plan.summary === "string" ? plan.summary : "" };
  },
  async startDevServer(sandboxId: string, input: { cmd?: string; port?: number; dir?: string }): Promise<void> {
    await request(`/sandboxes/${encodeURIComponent(sandboxId)}/dev-server`, "POST", input);
  },
  /** Downloads the folder's npm packages through the hub's gate (registries only, no install scripts). */
  async installDependencies(sandboxId: string, dir: string, scripts = true): Promise<{ ok: boolean; output: string }> {
    const result = await request<{ exitCode?: number | null; stdout?: string; stderr?: string; timedOut?: boolean }>(`/sandboxes/${encodeURIComponent(sandboxId)}/install`, "POST", { dir: dir || ".", scripts });
    return { ok: result.exitCode === 0 && !result.timedOut, output: `${result.stdout ?? ""}${result.stderr ? `\n${result.stderr}` : ""}`.trim() };
  },
  async stopDevServer(sandboxId: string): Promise<void> {
    await request(`/sandboxes/${encodeURIComponent(sandboxId)}/dev-server`, "DELETE");
  },
  /** A one-minute, single-use link that signs this browser in to the separate preview address. */
  async devServerTicket(sandboxId: string, path = "/"): Promise<{ url: string | null; message: string | null }> {
    const payload = await request<Record<string, unknown>>(`/sandboxes/${encodeURIComponent(sandboxId)}/dev-server/ticket`, "POST", { path });
    const access = (payload?.access ?? {}) as Record<string, unknown>;
    return { url: typeof payload?.url === "string" ? payload.url : null, message: typeof access.message === "string" ? access.message : null };
  },
  // ---------- security monitoring (the operator sees every workspace, a supervisor their own) ----------
  async securitySummary(window: SecurityWindow = "24h", workspace?: string): Promise<SecuritySummary> {
    return request<SecuritySummary>(`/security/summary?${securityQuery({ window, workspace })}`);
  },
  async securityTraffic(filter: SecurityTrafficFilter = {}): Promise<SecurityTrafficRow[]> {
    return (await request<{ traffic: SecurityTrafficRow[] }>(`/security/traffic?${securityQuery({ ...filter })}`)).traffic ?? [];
  },
  async securityAlerts(status: "open" | "acknowledged" | "all" = "open", workspace?: string): Promise<SecurityAlert[]> {
    return (await request<{ alerts: SecurityAlert[] }>(`/security/alerts?${securityQuery({ status, workspace })}`)).alerts ?? [];
  },
  async ackSecurityAlert(id: string): Promise<SecurityAlert> {
    return (await request<{ alert: SecurityAlert }>(`/security/alerts/${encodeURIComponent(id)}/ack`, "POST")).alert;
  },
  async refreshSecurity(): Promise<SecurityStatus> {
    return (await request<{ status: SecurityStatus }>("/security/refresh", "POST")).status;
  },
};

/** Fired on window when the live line delivers a new or repeated security alert. */
export const SECURITY_ALERT_EVENT = "ach:security-alert";
export type SecurityWindow = "1h" | "24h" | "7d" | "30d";
export type SecuritySeverity = "low" | "medium" | "high";
export interface SecurityStatus {
  enabled: boolean; monitoring: boolean; docker: boolean | null; last_scan_at: string | null; last_read_at: string | null; last_error: string | null; live_membership: boolean;
  gate: { container: string; network: string; running: boolean | null; network_ok: boolean | null; started_at: string | null };
}
export interface SecurityTotals { allowed: number; denied: number; bytes_up: number; bytes_down: number }
export interface SecuritySummary extends SecurityTotals {
  scope: { workspace_id: string | null; all_workspaces: boolean };
  by_profile: Array<SecurityTotals & { profile: string }>;
  top_destinations: Array<SecurityTotals & { host: string }>;
  top_sources: Array<SecurityTotals & { source_key: string; source_kind: string; container_name: string | null; room_id: string | null; room_name: string | null; sidekick_id: string | null; sidekick_name: string | null; workspace_id: string | null }>;
  alerts_open: Record<SecuritySeverity, number>;
  status: SecurityStatus;
}
export interface SecurityTrafficRow {
  id: number; first_at: string; last_at: string; profile: string; decision: "allow" | "deny"; kind: string; host: string; port: number | null; reason: string | null;
  source_key: string; source_kind: string; client_ip: string | null; container_name: string | null; workspace_id: string | null; workspace_name: string | null;
  room_id: string | null; room_name: string | null; sidekick_id: string | null; sidekick_name: string | null; count: number; bytes_up: number; bytes_down: number; duration_ms: number;
}
export interface SecurityTrafficFilter { workspace?: string; room?: string; sidekick?: string; profile?: string; decision?: string; source_kind?: string; window?: SecurityWindow; limit?: number }
export interface SecurityAlert {
  id: string; rule: string; subject: string; severity: SecuritySeverity; title: string; detail: string; count: number; first_seen: string; last_seen: string;
  workspace_id: string | null; workspace_name: string | null; room_id: string | null; room_name: string | null; actor_id: string | null; actor_name: string | null; sidekick_id: string | null;
  acknowledged_at: string | null; acknowledged_by: string | null;
}
function securityQuery(values: Record<string, string | number | undefined>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) if (value !== undefined && value !== "") params.set(key, String(value));
  return params.toString();
}
