// Frontend-only normalized types. The wire contract in hub/src/types.ts uses
// snake_case; normalizers convert all REST/WS payloads before views consume it.

export type Role = "supervisor" | "agent" | "observer";

export interface UiAgent {
  id: string;
  name: string;
  role: Role | string;
  workspaceId: string | null;
  workspaceName: string | null;
  createdAt: string | null;
  lastSeenAt: string | null;
  /** Chosen pixel character id, or null when none was picked. */
  avatar: string | null;
  /** True for someone who joined through an invite (a client). */
  guest: boolean;
  /** Metadata count/labels only. Token values and hashes are never exposed. */
  tokenMeta: Array<{ label: string; value: string }>;
}

export interface UiRoom {
  id: string;
  slug: string;
  name: string;
  project: string | null;
  createdBy: string | null;
  createdAt: string | null;
}

export interface UiMessage {
  id: string;
  roomId: string;
  from: string;
  to: string | null;
  body: string;
  createdAt: string;
}

export interface UiEvent {
  /** Stable local key; derives from wire id plus event content when needed. */
  id: string;
  /** Numeric wire event id used for replay ordering; zero if absent. */
  wireId: number;
  type: string;
  roomId: string | null;
  actorId: string | null;
  targetId: string | null;
  detail: Record<string, unknown> | null;
  createdAt: string;
}

export interface SandboxInfo {
  id: string;
  roomId: string;
  containerId: string | null;
  status: "unprovisioned" | "provisioning" | "running" | "stopped" | "error";
  image: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface UiExec {
  id: string;
  cmd: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
  actorId: string | null;
  createdAt: string;
}

export interface FileEntry {
  name: string;
  path: string;
  isDir: boolean;
  size: number | null;
}

export interface ExecResult {
  execId: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
}

export interface RepoResult extends ExecResult {
  action: "clone" | "update";
  dir: string;
  seeded: string[];
}

export interface GitCommit { sha: string; parents: string[]; author: string; date: string; subject: string; }
export interface GitOverview {
  dir: string; branch: string | null; head: string | null; repo: string | null;
  branches: Array<{ name: string; sha: string; remote: boolean; current: boolean }>;
  commits: GitCommit[]; changes: Array<{ code: string; path: string }>;
}
export interface GitCommitDetail extends GitCommit {
  email: string; message: string; files: Array<{ path: string; additions: number | null; deletions: number | null }>;
}

export interface WsClientFrame {
  t: "hello" | "subscribe" | "message.send" | "ping";
  token?: string;
  proof?: string;
  workspace?: string;
  rooms?: string[];
  room?: string;
  body?: string;
  to?: string;
}

export type WsServerFrame =
  | { t: "hello.ok"; agent: unknown; workspace?: { id: string; name: string }; rooms: string[] }
  | { t: "presence"; room_id: string; online: string[] }
  | { t: "event"; event: unknown }
  | { t: "message.created"; message: unknown }
  | { t: "security.alert"; alert: unknown; created: boolean }
  | { t: "pong" }
  | { t: "error"; code: string; message: string };

export type ConnState = "offline" | "connecting" | "live" | "reconnecting";
export type ViewId = "feed" | "rooms" | "sandbox" | "agents" | "audit" | "security";
export type Phase = "no-token" | "verifying" | "ready" | "bad-token";
