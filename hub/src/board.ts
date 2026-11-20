// The project board on the Studio's Overview: the room's rules, who is who (and whose sidekick is
// whose), each person's recent actions, and the numbers behind the leaderboard. Everything is read
// from the room's own event log, so it only reflects what happened in this room.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { canReadRoom } from './access.js';
import type { EventRow } from './db.js';
import type { HubServices } from './types.js';

export const DEFAULT_RULES = `# How we work here
- Be kind and specific. Say what you want built and why.
- Everything in this room is visible to everyone in it.
- Sidekicks follow only their owner. Ask a person if you need someone else's sidekick.
- Nothing goes to GitHub without the reviewer's approval.

# In the shared workspace
- Work in small steps and run the tests before calling something done.
- Don't paste passwords, keys or private data into files, commands or chat.
- Leave a short note in the chat when you change something others rely on.

# Getting help
- Ask in the chat, or message the reviewer directly with "To".`;

/** Commands that check code rather than change it: their pass rate is the "cleanest code" measure. */
const CHECK = /(^|[\s;&|(])(npm (run )?(test|lint|typecheck|check)|pnpm (run )?(test|lint)|yarn (test|lint)|npx (tsc|eslint|vitest|jest|prettier --check)|tsc\b|eslint\b|vitest\b|jest\b|pytest\b|ruff\b|flake8\b|mypy\b|go (test|vet)\b|cargo (test|clippy)\b|make (test|check|lint)\b)/;

interface Totals {
  agent_id: string; lines_added: number; lines_removed: number; saves: number;
  commands: number; failed: number; checks: number; checks_passed: number;
  recent: Array<{ type: string; created_at: string; payload: Record<string, unknown> }>;
}

/** One plain line for a workspace event, for a sidekick's briefing and the room feed. Chat is left out. */
export function describeEvent(event: Pick<EventRow, 'type' | 'actor_id' | 'payload' | 'created_at'>, nameOf: (id: string | null) => string): string | null {
  let p: Record<string, unknown> = {};
  try { p = JSON.parse(event.payload) as Record<string, unknown>; } catch { return null; }
  const who = nameOf(event.actor_id);
  const at = event.created_at.slice(11, 16);
  const str = (key: string) => (typeof p[key] === 'string' ? (p[key] as string).slice(0, 160) : '');
  switch (event.type) {
    case 'file.write': {
      if (p.operation === 'seed' || p.outcome !== 'success') return null;
      const delta = typeof p.lines_added === 'number' ? ` (+${p.lines_added} −${typeof p.lines_removed === 'number' ? p.lines_removed : 0})` : '';
      return `${at} ${who} saved ${str('path') || 'a file'}${delta}`;
    }
    case 'sandbox.exec.result': {
      const ok = p.exit_code === 0 && p.timed_out !== true && p.timed_out !== 1;
      if (p.kind === 'git') return `${at} ${who} ${ok ? 'brought in' : 'could not fetch'} ${str('repo') || 'a repository'}`;
      if (p.kind === 'pull_request') return `${at} ${who} ${ok ? 'opened a pull request' : 'tried to open a pull request'} on ${str('repo')}`;
      return `${at} ${who} ran \`${str('cmd')}\` → ${p.timed_out === true || p.timed_out === 1 ? 'timed out' : `exit ${String(p.exit_code ?? '?')}`}`;
    }
    case 'sidekick.turn.started': return `${at} ${who} started working${str('request') ? ` on: "${str('request')}"` : ''}`;
    case 'sidekick.turn.finished': return p.outcome === 'quiet' ? null : `${at} ${who} ${p.outcome === 'done' ? 'finished' : `stopped (${str('outcome')})`}`;
    case 'sidekick.stopped': return `${at} ${who} stopped a sidekick`;
    case 'room.joined': return `${at} ${who} joined`;
    case 'room.left': return `${at} ${who} left`;
    case 'room.rules_updated': return `${at} ${who} changed the workspace rules`;
    default: return event.type.startsWith('devserver.') ? `${at} ${who}: preview ${event.type.slice('devserver.'.length)}` : null;
  }
}

const feedQuery = z.object({ since: z.coerce.number().int().min(0).optional(), limit: z.coerce.number().int().min(1).max(100).optional() });

const params = z.object({ id: z.string().regex(/^room_[a-f0-9]{16}$/) });
const rulesSchema = z.object({ rules: z.string().max(8000).nullable() }).strict();

export function registerBoardRoutes(app: FastifyInstance, svc: HubServices): void {
  const { db, events } = svc;

  app.get('/v1/rooms/:id/board', { preHandler: svc.authGuard }, async (request, reply) => {
    const input = params.safeParse(request.params);
    const viewer = request.auth!.agent;
    if (!input.success || !canReadRoom(db, viewer, input.data.id)) return reply.code(404).send({ error: { code: 'ROOM_NOT_FOUND', message: 'Room not found' } });
    const roomId = input.data.id;
    const room = db.prepare('SELECT rules FROM rooms WHERE id = ?').get(roomId) as { rules: string | null };
    const totals = new Map<string, Totals>();
    const of = (id: string) => {
      let entry = totals.get(id);
      if (!entry) { entry = { agent_id: id, lines_added: 0, lines_removed: 0, saves: 0, commands: 0, failed: 0, checks: 0, checks_passed: 0, recent: [] }; totals.set(id, entry); }
      return entry;
    };
    const rows = db.prepare(`SELECT type, actor_id, target_id, payload, created_at FROM events
      WHERE room_id = ? AND actor_id IS NOT NULL AND type IN ('file.write', 'sandbox.exec.result', 'message.created', 'sidekick.activity')
      ORDER BY id DESC LIMIT 20000`).all(roomId) as Array<{ type: string; actor_id: string; target_id: string | null; payload: string; created_at: string }>;
    for (const row of rows) {
      let payload: Record<string, unknown> = {};
      try { payload = JSON.parse(row.payload) as Record<string, unknown>; } catch { /* counted without detail */ }
      const entry = of(row.actor_id);
      if (row.type === 'file.write') {
        if (payload.operation === 'seed' || payload.outcome !== 'success') continue;
        entry.saves += 1;
        entry.lines_added += typeof payload.lines_added === 'number' ? payload.lines_added : 0;
        entry.lines_removed += typeof payload.lines_removed === 'number' ? payload.lines_removed : 0;
      } else if (row.type === 'sandbox.exec.result') {
        if (payload.kind === 'git' || payload.kind === 'pull_request') { /* GitHub actions are not code quality signals */ }
        else {
          const ok = payload.exit_code === 0 && payload.timed_out !== true && payload.timed_out !== 1;
          entry.commands += 1; if (!ok) entry.failed += 1;
          if (typeof payload.cmd === 'string' && CHECK.test(payload.cmd)) { entry.checks += 1; if (ok) entry.checks_passed += 1; }
        }
      } else if (row.type === 'message.created' && row.target_id !== null) {
        continue; // direct messages stay between the two people
      }
      if (entry.recent.length < 3) {
        // Keep only what the activity line needs; command output stays in the activity feed.
        const { stdout: _o, stderr: _e, message, ...rest } = payload;
        const body = (message as { body?: unknown } | undefined)?.body;
        entry.recent.push({ type: row.type, created_at: row.created_at, payload: { ...rest, ...(typeof body === 'string' ? { body: body.slice(0, 160) } : {}) } });
      }
    }
    return { rules: room.rules ?? DEFAULT_RULES, custom_rules: room.rules !== null, people: [...totals.values()] };
  });

  // What happened in the workspace since a cursor, as plain lines: the live side-stream agents read while they work.
  app.get('/v1/rooms/:id/feed', { preHandler: svc.authGuard }, async (request, reply) => {
    const input = params.safeParse(request.params);
    const query = feedQuery.safeParse(request.query);
    if (!query.success) return reply.code(400).send({ error: { code: 'VALIDATION_ERROR', message: 'since and limit must be whole numbers' } });
    if (!input.success || !canReadRoom(db, request.auth!.agent, input.data.id)) return reply.code(404).send({ error: { code: 'ROOM_NOT_FOUND', message: 'Room not found' } });
    const limit = query.data.limit ?? 40;
    const since = query.data.since ?? Math.max(0, ((db.prepare('SELECT MAX(id) AS id FROM events WHERE room_id = ?').get(input.data.id) as { id: number | null }).id ?? 0) - 200);
    const rows = db.prepare(`SELECT id, type, actor_id, payload, created_at FROM events WHERE room_id = ? AND id > ? AND type != 'message.created' ORDER BY id ASC LIMIT 500`)
      .all(input.data.id, since) as Array<Pick<EventRow, 'id' | 'type' | 'actor_id' | 'payload' | 'created_at'>>;
    const names = new Map<string, string>();
    const nameOf = (id: string | null) => {
      if (!id) return 'someone';
      if (!names.has(id)) names.set(id, (db.prepare('SELECT name FROM agents WHERE id = ?').get(id) as { name: string } | undefined)?.name ?? 'someone');
      return names.get(id)!;
    };
    const lines = rows.map((row) => ({ id: row.id, text: describeEvent(row, nameOf) })).filter((row): row is { id: number; text: string } => row.text !== null).slice(-limit);
    return { events: lines, next_since: rows.at(-1)?.id ?? since };
  });

  app.put('/v1/rooms/:id/rules', { preHandler: svc.requireRole(['supervisor']) }, async (request, reply) => {
    const input = params.safeParse(request.params);
    const body = rulesSchema.safeParse(request.body);
    if (!input.success || !body.success) return reply.code(400).send({ error: { code: 'VALIDATION_ERROR', message: 'Rules must be text of up to 8000 characters, or null for the defaults' } });
    if (!canReadRoom(db, request.auth!.agent, input.data.id)) return reply.code(404).send({ error: { code: 'ROOM_NOT_FOUND', message: 'Room not found' } });
    const rules = body.data.rules?.trim() ? body.data.rules.trim() : null;
    db.prepare('UPDATE rooms SET rules = ? WHERE id = ?').run(rules, input.data.id);
    events.append({ type: 'room.rules_updated', room_id: input.data.id, actor_id: request.auth!.agent.id, payload: { custom: rules !== null } });
    return { rules: rules ?? DEFAULT_RULES, custom_rules: rules !== null };
  });
}
