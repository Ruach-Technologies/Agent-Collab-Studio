import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { canReadRoom } from '../access.js';
import type { HubServices } from '../types.js';
import { securityEvent } from '../security.js';

const roomCreateSchema = z.object({ name: z.string().trim().min(1).max(80), project: z.string().max(120).optional() }).strict();
const messagePostSchema = z.object({ body: z.string().min(1).max(8000), to: z.string().min(1).max(80).optional() }).strict();
const idSchema = z.object({ id: z.string().regex(/^room_[a-f0-9]{16}$/) });
const pageSchema = z.object({ since: z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional() }).strict();

export function registerRoomRoutes(app: FastifyInstance, svc: HubServices): void {
  function readable(request: FastifyRequest, reply: FastifyReply): string | null {
    const params = idSchema.safeParse(request.params);
    if (!params.success) { void reply.code(400).send({ error: { code: 'VALIDATION_ERROR', message: 'Invalid room id' } }); return null; }
    const id = params.data.id;
    if (!svc.rooms.get(id, request.auth!.agent.workspace_id)) { void reply.code(404).send({ error: { code: 'ROOM_NOT_FOUND', message: 'Room not found' } }); return null; }
    if (!canReadRoom(svc.db, request.auth!.agent, id)) { void reply.code(403).send({ error: { code: 'NOT_MEMBER', message: 'Join the room before reading' } }); return null; }
    return id;
  }

  app.post('/v1/rooms', { preHandler: svc.requireRole(['supervisor']) }, async (request, reply) => {
    const input = roomCreateSchema.safeParse(request.body);
    if (!input.success) return reply.code(400).send({ error: { code: 'VALIDATION_ERROR', message: 'name (1–80 characters) required' } });
    if (svc.rooms.list(request.auth!.agent.workspace_id).length >= svc.config.limits.maxRooms) return reply.code(409).send({ error: { code: 'ROOM_LIMIT', message: 'Room limit reached' } });
    return reply.code(201).send({ room: svc.rooms.create({ name: input.data.name, project: input.data.project ?? null }, request.auth!.agent.id) });
  });

  /** Invited guests belong to the rooms they were invited to; everyone else sees the workspace catalogue. */
  const isGuest = (agentId: string) => !!(svc.db.prepare('SELECT guest FROM agents WHERE id = ?').get(agentId) as { guest: number } | undefined)?.guest;
  app.get('/v1/rooms', { preHandler: svc.authGuard }, async (request) => {
    const agent = request.auth!.agent;
    const rooms = svc.rooms.list(agent.workspace_id);
    return { rooms: isGuest(agent.id) ? rooms.filter((room) => svc.rooms.isMember(room.id, agent.id)) : rooms };
  });

  app.post('/v1/rooms/:id/join', { preHandler: svc.requireRole(['agent', 'supervisor']) }, async (request, reply) => {
    const params = idSchema.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: { code: 'VALIDATION_ERROR', message: 'Invalid room id' } });
    if (isGuest(request.auth!.agent.id) && !svc.rooms.isMember(params.data.id, request.auth!.agent.id)) {
      return reply.code(403).send({ error: { code: 'INVITE_REQUIRED', message: 'Guests join a room through an invite' } });
    }
    if (!svc.rooms.join(params.data.id, request.auth!.agent.id)) return reply.code(404).send({ error: { code: 'ROOM_NOT_FOUND', message: 'Room not found' } });
    return { joined: true, room: svc.rooms.get(params.data.id) };
  });

  app.get('/v1/rooms/:id/members', { preHandler: svc.authGuard }, async (request, reply) => {
    const id = readable(request, reply);
    if (!id) return;
    return { members: svc.rooms.listMembers(id) };
  });

  app.get('/v1/rooms/:id/messages', { preHandler: svc.authGuard }, async (request, reply) => {
    const id = readable(request, reply);
    if (!id) return;
    const query = pageSchema.safeParse(request.query);
    if (!query.success) return reply.code(400).send({ error: { code: 'VALIDATION_ERROR', message: 'since must be a non-negative integer' } });
    return { messages: svc.rooms.messages(id, request.auth!.agent, query.data.since) };
  });

  app.post('/v1/rooms/:id/messages', { preHandler: svc.requireRole(['agent', 'supervisor']) }, async (request, reply) => {
    const params = idSchema.safeParse(request.params);
    const input = messagePostSchema.safeParse(request.body);
    if (!params.success || !input.success || !input.data.body.trim()) return reply.code(400).send({ error: { code: 'VALIDATION_ERROR', message: 'Valid room id and body (1–8000 characters) required' } });
    const refused = svc.postGuard?.(request.auth!.agent.id, params.data.id);
    if (refused) {
      // Kept off the room's timeline (no room_id): the operator's security view reads it, not the chat.
      const sidekick = svc.db.prepare('SELECT id FROM sidekicks WHERE agent_id = ?').get(request.auth!.agent.id) as { id: string } | undefined;
      securityEvent(svc, { type: 'sidekick.post.denied', actor_id: request.auth!.agent.id, payload: { code: refused.code, room: params.data.id, sidekick_id: sidekick?.id ?? null } });
      return reply.code(refused.status).send({ error: { code: refused.code, message: refused.message } });
    }
    return reply.code(201).send({ message: svc.rooms.postMessage(params.data.id, request.auth!.agent.id, input.data.body, input.data.to) });
  });
}
