// Defensive wire normalizers. The authoritative hub contract uses snake_case;
// this layer also accepts the few camelCase variants used by early hub drafts.
import type {
  ExecResult,
  FileEntry,
  SandboxInfo,
  UiAgent,
  UiEvent,
  UiMessage,
  UiRoom,
  WsServerFrame,
} from "../types";

type Obj = Record<string, unknown>;

function obj(value: unknown): Obj {
  return value !== null && typeof value === "object" ? (value as Obj) : {};
}
function string(value: unknown): string {
  return typeof value === "string" ? value : typeof value === "number" ? String(value) : "";
}
function optionalString(value: unknown): string | null {
  const result = string(value);
  return result === "" ? null : result;
}
function number(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value !== "") {
    const result = Number(value);
    return Number.isFinite(result) ? result : null;
  }
  return null;
}
function take(record: Obj, ...keys: string[]): unknown {
  for (const key of keys) {
    const value = record[key];
    if (value !== undefined && value !== null && value !== "") return value;
  }
  return undefined;
}

export function arrayPayload(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  const record = obj(value);
  for (const candidate of Object.values(record)) if (Array.isArray(candidate)) return candidate;
  return [];
}

export function normalizeAgent(value: unknown): UiAgent {
  const record = obj(value);
  const id = string(record.id);
  const tokenCount = number(take(record, "token_count", "tokenCount", "tokens"));
  const revokedAt = optionalString(take(record, "revoked_at", "revokedAt"));
  const tokenMeta: UiAgent["tokenMeta"] = [];
  if (tokenCount !== null) tokenMeta.push({ label: "issued", value: String(tokenCount) });
  if (revokedAt) tokenMeta.push({ label: "revoked", value: revokedAt });
  return {
    id,
    name: string(record.name) || id || "unknown",
    role: string(record.role) || "agent",
    workspaceId: optionalString(record.workspace_id),
    workspaceName: optionalString(record.workspace_name),
    createdAt: optionalString(take(record, "created_at", "createdAt")),
    lastSeenAt: optionalString(take(record, "last_seen_at", "lastSeenAt")),
    avatar: optionalString(record.avatar),
    guest: record.guest === true || record.guest === 1,
    tokenMeta,
  };
}

export function normalizeRoom(value: unknown): UiRoom {
  const record = obj(value);
  const id = string(record.id);
  return {
    id,
    slug: string(record.slug) || id,
    name: string(record.name) || id || "unnamed room",
    project: optionalString(record.project),
    createdBy: optionalString(take(record, "created_by", "createdBy")),
    createdAt: optionalString(take(record, "created_at", "createdAt")),
  };
}

export function normalizeMessage(value: unknown): UiMessage {
  const record = obj(value);
  return {
    id: string(record.id) || `message-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    roomId: string(take(record, "room_id", "roomId")),
    from: string(take(record, "from_agent_id", "fromAgentId", "from")),
    to: optionalString(take(record, "to_agent_id", "toAgentId", "to")),
    body: string(take(record, "body", "text")),
    createdAt: optionalString(take(record, "created_at", "createdAt")) ?? new Date().toISOString(),
  };
}

export function normalizeEvent(value: unknown): UiEvent | null {
  const record = obj(value);
  const type = string(record.type);
  if (!type) return null;
  const numericId = number(take(record, "id", "event_id", "eventId")) ?? 0;
  const createdAt = optionalString(take(record, "created_at", "createdAt", "timestamp")) ?? new Date().toISOString();
  const detailCandidate = take(record, "detail", "data", "payload");
  let detail: Record<string, unknown> | null = null;
  if (detailCandidate !== null && typeof detailCandidate === "object") detail = detailCandidate as Obj;
  if (typeof detailCandidate === "string") {
    try {
      const decoded: unknown = JSON.parse(detailCandidate);
      if (decoded !== null && typeof decoded === "object") detail = decoded as Obj;
    } catch { /* strings without JSON remain unstructured */ }
  }
  return {
    id: numericId ? `event-${numericId}` : `event-${type}-${createdAt}-${Math.random().toString(36).slice(2)}`,
    wireId: numericId,
    type,
    roomId: optionalString(take(record, "room_id", "roomId", "room")),
    actorId: optionalString(take(record, "agent_id", "agentId", "actor_id", "actorId", "actor")),
    targetId: optionalString(take(record, "target_id", "targetId", "target_agent_id", "targetAgentId", "target")),
    detail,
    createdAt,
  };
}

export function normalizeSandbox(value: unknown): SandboxInfo {
  const record = obj(value);
  const status = string(record.status);
  return {
    id: string(take(record, "id", "sandbox_id", "sandboxId")),
    roomId: string(take(record, "room_id", "roomId")),
    containerId: optionalString(take(record, "container_id", "containerId")),
    status: status === "provisioning" || status === "running" || status === "stopped" || status === "error" ? status : "unprovisioned",
    image: optionalString(record.image),
    createdAt: optionalString(take(record, "created_at", "createdAt")),
    updatedAt: optionalString(take(record, "updated_at", "updatedAt")),
  };
}

export function normalizeExecResult(value: unknown): ExecResult {
  const record = obj(value);
  return {
    execId: string(take(record, "exec_id", "execId", "id")) || `exec-${Date.now()}`,
    exitCode: number(take(record, "exitCode", "exit_code", "exit")),
    timedOut: record.timedOut === true || record.timed_out === 1,
    stdout: string(record.stdout),
    stderr: string(record.stderr),
    durationMs: number(take(record, "durationMs", "duration_ms", "duration")) ?? 0,
  };
}

export function normalizeFileEntry(value: unknown, parent = "."): FileEntry {
  const record = obj(value);
  const name = string(record.name);
  const kind = string(take(record, "type", "kind"));
  const isDir = kind === "dir" || kind === "directory" || record.is_dir === true || record.isDir === true;
  return {
    name,
    path: string(record.path) || (parent === "." ? name : `${parent}/${name}`),
    isDir,
    size: number(record.size),
  };
}

export function parseServerFrame(input: unknown): WsServerFrame | null {
  let value: unknown = input;
  if (typeof input === "string") {
    try { value = JSON.parse(input); } catch { return null; }
  }
  const record = obj(value);
  const t = string(record.t);
  if (t === "hello.ok") {
    const workspace = obj(record.workspace);
    return { t, agent: record.agent, workspace: typeof workspace.id === "string" && typeof workspace.name === "string" ? { id: workspace.id, name: workspace.name } : undefined,
      rooms: Array.isArray(record.rooms) ? record.rooms.map(String) : [] };
  }
  if (t === "presence") return { t, room_id: string(take(record, "room_id", "roomId")), online: Array.isArray(record.online) ? record.online.map(String) : [] };
  if (t === "event") return { t, event: record.event ?? record.data };
  if (t === "message.created") return { t, message: record.message ?? record.data };
  if (t === "security.alert") return { t, alert: record.alert, created: record.created === true };
  if (t === "pong") return { t };
  if (t === "error") return { t, code: string(record.code) || "ERROR", message: string(record.message) || "server error" };
  return null;
}
