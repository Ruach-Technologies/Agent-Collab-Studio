// Room membership and messages share one wire shape for REST, replay and WS.
import { randomUUID } from 'node:crypto';
import type { DbHandle, RoomRow, MessageRow } from './db.js';
import type { EventBus } from './events.js';
import type { Agent, Message, RoomMember } from './types.js';
import { canObserveAll, canReadRoom } from './access.js';
import { LEGACY_WORKSPACE_ID } from './db.js';

export interface RoomServiceDeps { db: DbHandle; events: EventBus; }

export class RoomError extends Error {
  constructor(public code: 'ROOM_NOT_FOUND' | 'NOT_MEMBER' | 'RECIPIENT_NOT_MEMBER' | 'VALIDATION_ERROR' | 'FORBIDDEN', message: string) {
    super(message);
    this.name = 'RoomError';
  }
}

function wireMessage(row: MessageRow & { cursor?: number }): Message & { cursor?: number } {
  const { sender_id, recipient_id, ...rest } = row;
  return { ...rest, from_agent_id: sender_id, to_agent_id: recipient_id };
}

export class RoomService {
  constructor(private deps: RoomServiceDeps) {}

  create(input: { name: string; project?: string | null }, createdBy: string): RoomRow {
    const creator = this.deps.db.prepare('SELECT workspace_id,role FROM agents WHERE id=?').get(createdBy) as { workspace_id: string; role: string } | undefined;
    if (!creator || creator.role !== 'supervisor') throw new RoomError('FORBIDDEN','Supervisor required');
    const workspaceId = creator.workspace_id;
    const id = `room_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
    const stem = input.name.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 56) || 'room';
    let slug = stem;
    let suffix = 1;
    while (this.deps.db.prepare('SELECT 1 FROM rooms WHERE slug = ? AND workspace_id=?').get(slug,workspaceId)) slug = `${stem}-${++suffix}`;
    const now = new Date().toISOString();
    this.deps.db.transaction(() => {
      this.deps.db.prepare('INSERT INTO rooms (id, workspace_id, name, slug, project, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(id, workspaceId, input.name, slug, input.project ?? null, createdBy, now);
      this.deps.db.prepare('INSERT INTO members (room_id, agent_id, joined_at) VALUES (?, ?, ?)').run(id, createdBy, now);
    })();
    this.deps.events.append({ type: 'room.created', room_id: id, actor_id: createdBy, payload: { name: input.name, slug } });
    return this.get(id)!;
  }

  /** Archived rooms keep their history but are no longer listed, joined or used. */
  get(id: string, workspaceId?: string): RoomRow | null {
    return this.deps.db.prepare('SELECT * FROM rooms WHERE id = ? AND archived_at IS NULL AND (? IS NULL OR workspace_id=?)').get(id,workspaceId ?? null,workspaceId ?? null) as RoomRow | undefined ?? null;
  }

  list(workspaceId = LEGACY_WORKSPACE_ID): RoomRow[] {
    return this.deps.db.prepare('SELECT * FROM rooms WHERE workspace_id=? AND archived_at IS NULL ORDER BY created_at DESC, id').all(workspaceId) as RoomRow[];
  }

  isMember(roomId: string, agentId: string): boolean {
    return !!this.deps.db.prepare('SELECT 1 FROM members WHERE room_id = ? AND agent_id = ?').get(roomId, agentId);
  }

  join(roomId: string, agentId: string): boolean {
    const agent = this.deps.db.prepare('SELECT workspace_id,role FROM agents WHERE id=?').get(agentId) as Agent | undefined;
    if (!agent || agent.role === 'observer' || !this.get(roomId,agent.workspace_id)) return false;
    const result = this.deps.db.prepare('INSERT OR IGNORE INTO members (room_id, agent_id, joined_at) VALUES (?, ?, ?)')
      .run(roomId, agentId, new Date().toISOString());
    if (result.changes) this.deps.events.append({ type: 'room.joined', room_id: roomId, actor_id: agentId });
    return true;
  }

  listMembers(roomId: string): RoomMember[] {
    return this.deps.db.prepare(`SELECT m.agent_id, a.name, a.role, m.joined_at, a.avatar, a.guest, s.owner_id AS sidekick_of
      FROM members m JOIN agents a ON a.id = m.agent_id LEFT JOIN sidekicks s ON s.agent_id = a.id AND s.removed_at IS NULL WHERE m.room_id = ? ORDER BY m.joined_at, m.agent_id`)
      .all(roomId) as RoomMember[];
  }

  messages(roomId: string, viewer: Agent, since?: number, limit = 200): Message[] {
    if (!canReadRoom(this.deps.db,viewer,roomId)) throw new RoomError('ROOM_NOT_FOUND','Room not found');
    const visibility = canObserveAll(viewer) ? '' : ' AND (recipient_id IS NULL OR sender_id = @viewer OR recipient_id = @viewer)';
    const order = since === undefined ? 'DESC' : 'ASC';
    const rows = this.deps.db.prepare(`SELECT rowid AS cursor, * FROM messages WHERE room_id = @room
      ${since === undefined ? '' : 'AND rowid > @since'}${visibility} ORDER BY rowid ${order} LIMIT @limit`)
      .all({ room: roomId, viewer: viewer.id, since: since ?? 0, limit }) as (MessageRow & { cursor: number })[];
    return (since === undefined ? rows.reverse() : rows).map(wireMessage);
  }

  postMessage(roomId: string, fromAgentId: string, body: string, toAgentId?: string | null): Message {
    if (!body.trim() || body.length > 8000) throw new RoomError('VALIDATION_ERROR', 'body must be 1–8000 characters');
    const sender = this.deps.db.prepare('SELECT role,workspace_id FROM agents WHERE id = ?').get(fromAgentId) as Agent | undefined;
    if (!sender || !this.get(roomId,sender.workspace_id)) throw new RoomError('ROOM_NOT_FOUND', 'Room not found');
    if (!sender || sender.role === 'observer') throw new RoomError('FORBIDDEN', 'Observers cannot post');
    if (!this.isMember(roomId, fromAgentId)) throw new RoomError('NOT_MEMBER', 'Join the room before posting');
    if (toAgentId && !this.isMember(roomId, toAgentId)) throw new RoomError('RECIPIENT_NOT_MEMBER', 'DM recipient is not a room member');
    const id = `msg_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
    this.deps.db.prepare('INSERT INTO messages (id, room_id, sender_id, recipient_id, body, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, roomId, fromAgentId, toAgentId ?? null, body, new Date().toISOString());
    const message = wireMessage(this.deps.db.prepare('SELECT rowid AS cursor, * FROM messages WHERE id = ?').get(id) as MessageRow);
    this.deps.events.append({
      type: 'message.created', room_id: roomId, actor_id: fromAgentId, target_id: toAgentId ?? null,
      payload: { message_id: id, message },
    });
    return message;
  }
}
