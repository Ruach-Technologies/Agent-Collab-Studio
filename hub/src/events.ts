// Event spine: every meaningful action appends here and fans out to WS subscribers.
import { EventEmitter } from 'node:events';
import type BetterSqlite3 from 'better-sqlite3';
import type { EventRow, EventType } from './db.js';

export interface EventInput {
  type: EventType;
  workspace_id?: string | null;
  room_id?: string | null;
  actor_id?: string | null;
  target_id?: string | null;
  payload?: Record<string, unknown> | null;
}

export class EventBus {
  private readonly emitter = new EventEmitter();
  private readonly insertStmt: BetterSqlite3.Statement;
  private readonly tailStmt: BetterSqlite3.Statement;
  private readonly sinceStmt: BetterSqlite3.Statement;
  private readonly lastStmt: BetterSqlite3.Statement;

  constructor(private readonly db: BetterSqlite3.Database) {
    // A UI with many tabs should not be the reason the hub dies.
    this.emitter.setMaxListeners(200);
    this.insertStmt = db.prepare(
      `INSERT INTO events (type, workspace_id, room_id, actor_id, target_id, payload, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    );
    this.tailStmt = db.prepare(`SELECT * FROM events ORDER BY id DESC LIMIT @cap`);
    this.sinceStmt = db.prepare(`SELECT * FROM events WHERE id > @sinceId ORDER BY id ASC LIMIT @cap`);
    this.lastStmt = db.prepare(`SELECT id FROM events ORDER BY id DESC LIMIT 1`);
  }

  /** Append an event to the durable log and broadcast it to live subscribers. */
  append(input: EventInput): EventRow {
    const created_at = new Date().toISOString();
    const payload = JSON.stringify(input.payload ?? {});
    const room = input.room_id ? this.db.prepare('SELECT workspace_id FROM rooms WHERE id=?').get(input.room_id) as { workspace_id: string } | undefined : undefined;
    const actor = input.actor_id ? this.db.prepare('SELECT workspace_id FROM agents WHERE id=?').get(input.actor_id) as { workspace_id: string } | undefined : undefined;
    const workspace_id = input.workspace_id ?? room?.workspace_id ?? actor?.workspace_id ?? null;
    if ((room && room.workspace_id !== workspace_id) || (actor && actor.workspace_id !== workspace_id)) throw new Error('Event workspace mismatch');
    const info = this.insertStmt.run(
      input.type,
      workspace_id,
      input.room_id ?? null,
      input.actor_id ?? null,
      input.target_id ?? null,
      payload,
      created_at,
    );
    const row: EventRow = {
      id: Number(info.lastInsertRowid),
      workspace_id,
      type: input.type,
      room_id: input.room_id ?? null,
      actor_id: input.actor_id ?? null,
      target_id: input.target_id ?? null,
      payload,
      created_at,
    };
    this.emitter.emit('event', row);
    return row;
  }

  /** Replay: the tail when sinceId is null, otherwise everything after it. */
  since(sinceId: number | null, limit = 200): EventRow[] {
    const cap = Math.min(Math.max(1, limit), 5000);
    if (sinceId == null) {
      const rows = this.tailStmt.all({ cap }) as EventRow[];
      return rows.reverse();
    }
    return this.sinceStmt.all({ sinceId, cap }) as EventRow[];
  }

  /** Subscribe to live events. Returns an unsubscribe function. */
  on(fn: (event: EventRow) => void): () => void {
    this.emitter.on('event', fn);
    return () => this.emitter.off('event', fn);
  }

  /** Current highest event id (for WS welcome resumability). */
  lastId(workspaceId?: string): number {
    const row = (workspaceId ? this.db.prepare('SELECT id FROM events WHERE workspace_id=? ORDER BY id DESC LIMIT 1').get(workspaceId) : this.lastStmt.get()) as { id: number } | undefined;
    return row ? Number(row.id) : 0;
  }
}
