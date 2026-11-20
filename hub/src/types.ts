/**
 * Wire contract — the single source of truth for the hub API surface.
 * Hub routes, the WS line, the web UI, and the SDK all follow these shapes.
 * Field naming is snake_case on the wire.
 */

export type Role = 'supervisor' | 'agent' | 'observer';

export interface Workspace { id: string; name: string; created_at: string; }

export interface Agent {
  id: string;
  workspace_id: string;
  name: string;
  role: Role;
  created_at: string;
  last_seen_at: string | null;
}

export interface Room {
  id: string;
  workspace_id: string;
  slug: string;
  name: string;
  project: string | null;
  created_by: string;
  created_at: string;
}

export interface RoomMember {
  agent_id: string;
  name: string;
  role: Role;
  joined_at: string;
  /** Chosen pixel character, or null when none was picked. */
  avatar: string | null;
  /** 1 for someone who joined through an invite and is confined to their invited rooms. */
  guest: number;
  /** For a sidekick, the agent id of the person it belongs to. */
  sidekick_of: string | null;
}

export interface Message {
  id: string;
  room_id: string;
  from_agent_id: string;
  to_agent_id: string | null; // null = room-wide post
  body: string;
  created_at: string;
}

export type SandboxStatus =
  | 'unprovisioned'
  | 'provisioning'
  | 'running'
  | 'stopped'
  | 'error';

export interface SandboxRecord {
  id: string;
  room_id: string;
  container_id: string | null;
  status: SandboxStatus;
  image: string;
  error: string | null;
  created_at: string;
  updated_at: string;
}

export interface SandboxFileEntry {
  name: string;
  type: 'file' | 'dir';
  size: number;
}

export type EventType = import('./db.js').EventType;

export interface HubEvent {
  id: number;
  workspace_id: string | null;
  type: EventType;
  room_id: string | null;
  actor_id: string | null;
  target_id: string | null;
  payload: string;
  created_at: string;
}

export type WsFrame = WsClientFrame | WsServerFrame;

/** Service bundle passed to routes and the WS line. */
export interface HubServices {
  config: import('./config.js').HubConfig;
  db: import('./db.js').DbHandle;
  events: import('./events.js').EventBus;
  rooms: import('./rooms.js').RoomService;
  sandbox: import('./sandbox.js').SandboxService;
  limiter: import('./ratelimit.js').TokenBucketLimiter;
  authGuard: import('fastify').preHandlerAsyncHookHandler;
  requireRole: (allowed: readonly Role[]) => import('fastify').preHandlerAsyncHookHandler;
  /** Set by the sidekick service: may refuse a message an agent posts itself (not the hub's own posts). */
  /** The sealed network's gate, when enabled. */
  egress?: import('./egress.js').EgressGate;
  postGuard?: (agentId: string, roomId: string) => { status: number; code: string; message: string } | null;
  /** Gate traffic and alerts for the operator and supervisors. */
  security?: import('./security.js').SecurityMonitor;
}

// ---- REST payloads (v1) ----

export interface CreateRoomRequest {
  name: string;
  project?: string;
}

export interface PostMessageRequest {
  body: string;
  to?: string; // target agent id for a DM within the room
}

export interface SandboxExecRequest {
  cmd: string;
  timeoutMs?: number;
}

export interface SandboxExecResult {
  exec_id: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  durationMs: number;
}

export interface ApiError {
  error: {
    code: string;
    message: string;
  };
}

// ---- WS protocol (/v1/ws) ----

export type WsClientFrame =
  | { t: 'hello'; token: string; workspace?: string }
  | { t: 'subscribe'; rooms?: string[] }
  | { t: 'message.send'; room: string; body: string; to?: string }
  | { t: 'ping' };

export type WsServerFrame =
  | { t: 'hello.ok'; agent: Agent; workspace: Workspace; instance_id: string; lastEventId: number }
  | { t: 'presence'; room_id: string; online: string[] }
  | { t: 'event'; event: HubEvent }
  | { t: 'message.created'; message: Message }
  | { t: 'security.alert'; alert: import('./security.js').AlertRow; created: boolean }
  | { t: 'pong' }
  | { t: 'error'; code: string; message: string };
