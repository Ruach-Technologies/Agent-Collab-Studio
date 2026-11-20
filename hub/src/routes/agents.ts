// Agent routes: identity includes immutable scope; rosters never expose hashes.
import type { FastifyInstance } from 'fastify';
import type { HubServices } from '../types.js';
import { hubIdentity } from '../db.js';

export function registerAgentRoutes(app: FastifyInstance, svc: HubServices): void {
  const profile = (id: string) => {
    const row = svc.db.prepare('SELECT avatar, guest FROM agents WHERE id = ?').get(id) as { avatar: string | null; guest: number } | undefined;
    return { avatar: row?.avatar ?? null, guest: row?.guest === 1 };
  };
  app.get('/v1/whoami', { preHandler: svc.authGuard }, async (request) => ({
    agent: { ...request.auth!.agent, ...profile(request.auth!.agent.id) },
    workspace: svc.db.prepare('SELECT * FROM workspaces WHERE id=?').get(request.auth!.agent.workspace_id),
    ...hubIdentity(svc.db),
    operator: request.auth!.operator === true,
  }));
  // Only the local operator may enumerate workspaces; ordinary tokens stay confined to their own.
  app.get('/v1/operator/workspaces', { preHandler: svc.authGuard }, async (request, reply) => {
    if (!request.auth!.operator) return reply.code(403).send({ error: { code: 'FORBIDDEN', message: 'Operator access required' } });
    return { workspaces: svc.db.prepare('SELECT id, name, created_at FROM workspaces ORDER BY created_at, id').all() };
  });
  // A guest's roster is the people they share a room with, not the whole workspace.
  app.get('/v1/agents', { preHandler: svc.authGuard }, async (request) => ({
    agents: svc.db.prepare(`SELECT a.id,a.workspace_id,a.name,a.role,a.created_at,a.last_seen_at,a.avatar,a.guest,
      (SELECT COUNT(*) FROM tokens t WHERE t.agent_id=a.id) AS token_count,
      CASE WHEN EXISTS (SELECT 1 FROM tokens t WHERE t.agent_id=a.id AND t.revoked_at IS NULL) THEN NULL
        ELSE (SELECT MAX(t.revoked_at) FROM tokens t WHERE t.agent_id=a.id) END AS revoked_at
      FROM agents a WHERE a.workspace_id=@workspace AND (@guest = 0 OR a.id = @viewer OR EXISTS (
        SELECT 1 FROM members mine JOIN members theirs ON theirs.room_id = mine.room_id WHERE mine.agent_id = @viewer AND theirs.agent_id = a.id))
      ORDER BY a.name COLLATE NOCASE`).all({ workspace: request.auth!.agent.workspace_id, viewer: request.auth!.agent.id, guest: profile(request.auth!.agent.id).guest ? 1 : 0 }),
  }));
}
