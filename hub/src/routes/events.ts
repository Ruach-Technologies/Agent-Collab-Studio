import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { canObserveAll } from '../access.js';
import type { HubServices } from '../types.js';
import type { EventRow } from '../db.js';

const querySchema = z.object({
  since: z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
  limit: z.coerce.number().int().min(1).max(1000).default(200),
  room: z.string().regex(/^room_[a-f0-9]{16}$/).optional(),
  type: z.string().min(1).max(80).optional(),
}).strict();

export function registerEventRoutes(app: FastifyInstance, svc: HubServices): void {
  app.get('/v1/events', { preHandler: svc.authGuard }, async (request, reply) => {
    const query = querySchema.safeParse(request.query);
    if (!query.success) return reply.code(400).send({ error: { code: 'INVALID_QUERY', message: 'Invalid event query' } });
    const { since, limit, room, type } = query.data;
    const agent = request.auth!.agent;
    const visibility = canObserveAll(agent) ? '' : `AND (
      (e.room_id IS NULL AND e.actor_id = @viewer) OR
      (EXISTS (SELECT 1 FROM members m WHERE m.room_id = e.room_id AND m.agent_id = @viewer)
        AND (e.type != 'message.created' OR e.target_id IS NULL OR e.actor_id = @viewer OR e.target_id = @viewer))
    )`;
    const events = svc.db.prepare(`SELECT e.* FROM events e WHERE e.id > @since AND e.workspace_id=@workspace
      AND (@room IS NULL OR e.room_id = @room) AND (@type IS NULL OR e.type = @type)
      ${visibility} ORDER BY e.id ${since === undefined ? 'DESC' : 'ASC'} LIMIT @limit`)
      .all({ workspace: agent.workspace_id, since: since ?? 0, room: room ?? null, type: type ?? null, viewer: agent.id, limit }) as EventRow[];
    return { events: since === undefined ? events.reverse() : events };
  });
}
