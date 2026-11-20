import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { canReadRoom } from '../access.js';
import { isSandboxError } from '../sandbox.js';
import type { SandboxRow } from '../db.js';
import type { HubServices } from '../types.js';
import { securityEvent } from '../security.js';

const execSchema = z.object({ cmd: z.string().trim().min(1).max(512), timeoutMs: z.number().int().min(500).max(120_000).optional() }).strict();
const fileQuery = z.object({ path: z.string().max(500).default('.') }).strict();
const fileWrite = z.object({ path: z.string().min(1).max(500), content: z.string().max(256 * 1024) }).strict();
const repoSchema = z.object({ repo: z.string().trim().min(3).max(300), dir: z.string().min(1).max(100).optional(), ref: z.string().min(1).max(200).optional() }).strict();
const pullSchema = z.object({
  repo: z.string().trim().min(3).max(300), dir: z.string().min(1).max(100).optional(), branch: z.string().min(1).max(200),
  title: z.string().trim().min(1).max(200), body: z.string().max(20_000).optional(), base: z.string().min(1).max(200).optional(),
}).strict();
const gitQuery = z.object({ dir: z.string().min(1).max(100), limit: z.coerce.number().int().min(1).max(500).optional() }).strict();
const gitCommitQuery = z.object({ dir: z.string().min(1).max(100), sha: z.string().regex(/^[a-f0-9]{7,40}$/), path: z.string().min(1).max(500).optional() }).strict();
const gitCheckout = z.object({ dir: z.string().min(1).max(100), branch: z.string().min(1).max(200) }).strict();
const sandboxParams = z.object({ id: z.string().regex(/^sbx_[a-f0-9]{16}$/) });
const roomParams = z.object({ roomId: z.string().regex(/^room_[a-f0-9]{16}$/) });

const installSchema = z.object({ dir: z.string().max(400).optional(), scripts: z.boolean().optional() }).strict();

export function registerSandboxRoutes(app: FastifyInstance, svc: HubServices): void {
  function accessible(request: FastifyRequest, reply: FastifyReply): SandboxRow | null {
    const parsed = sandboxParams.safeParse(request.params);
    if (!parsed.success) { void reply.code(400).send({ error: { code: 'VALIDATION_ERROR', message: 'Invalid sandbox id' } }); return null; }
    const row = svc.db.prepare('SELECT s.* FROM sandboxes s JOIN rooms r ON r.id=s.room_id WHERE s.id=? AND r.workspace_id=?').get(parsed.data.id,request.auth!.agent.workspace_id) as SandboxRow | undefined;
    if (!row) { void reply.code(404).send({ error: { code: 'SANDBOX_NOT_FOUND', message: 'Sandbox not found' } }); return null; }
    if (!canReadRoom(svc.db, request.auth!.agent, row.room_id)) { void reply.code(403).send({ error: { code: 'NOT_MEMBER', message: 'Not a room member' } }); return null; }
    return row;
  }
  function roomAccess(request: FastifyRequest, reply: FastifyReply): string | null {
    const parsed = roomParams.safeParse(request.params);
    if (!parsed.success) { void reply.code(400).send({ error: { code: 'VALIDATION_ERROR', message: 'Invalid room id' } }); return null; }
    const roomId = parsed.data.roomId;
    if (!svc.rooms.get(roomId,request.auth!.agent.workspace_id)) { void reply.code(404).send({ error: { code: 'ROOM_NOT_FOUND', message: 'Room not found' } }); return null; }
    if (!canReadRoom(svc.db, request.auth!.agent, roomId)) { void reply.code(403).send({ error: { code: 'NOT_MEMBER', message: 'Not a room member' } }); return null; }
    return roomId;
  }
  async function perform<T>(reply: FastifyReply, action: () => Promise<T>): Promise<T | void> {
    try { return await action(); }
    catch (error) {
      if (isSandboxError(error)) { void reply.code(error.status).send({ error: { code: error.code, message: error.message } }); return; }
      throw error;
    }
  }

  app.get('/v1/rooms/:roomId/sandbox', { preHandler: svc.authGuard }, async (request, reply) => {
    const roomId = roomAccess(request, reply);
    if (!roomId) return;
    return perform(reply, async () => {
      const sandbox = await svc.sandbox.liveStatus(roomId);
      return { sandbox: sandbox ? { ...sandbox, error: sandbox.error ? 'Provision failed; inspect local logs' : null } : null };
    });
  });

  app.post('/v1/rooms/:roomId/sandbox', { preHandler: svc.requireRole(['supervisor']) }, async (request, reply) => {
    const roomId = roomAccess(request, reply);
    if (!roomId) return;
    return perform(reply, async () => {
      const sandbox = await svc.sandbox.provision(roomId, request.auth!.agent.id);
      reply.code(201);
      return { sandbox };
    });
  });

  app.post('/v1/sandboxes/:id/exec', { preHandler: svc.requireRole(['agent', 'supervisor']) }, async (request, reply) => {
    const row = accessible(request, reply);
    if (!row) return;
    const input = execSchema.safeParse(request.body);
    if (!input.success) return reply.code(400).send({ error: { code: 'VALIDATION_ERROR', message: 'cmd (1–512 characters) and optional timeoutMs (500–120000) required' } });
    return perform(reply, () => svc.sandbox.exec(row.id, request.auth!.agent.id, input.data.cmd, input.data.timeoutMs));
  });

  // GitHub stays with people: a sidekick may work in the files but never fetch or publish code.
  const isSidekick = (agentId: string) => !!svc.db.prepare('SELECT 1 FROM sidekicks WHERE agent_id = ? AND removed_at IS NULL').get(agentId);
  const noSidekicks = (request: import('fastify').FastifyRequest, reply: import('fastify').FastifyReply) => {
    if (!isSidekick(request.auth!.agent.id)) return false;
    const sidekick = svc.db.prepare('SELECT id FROM sidekicks WHERE agent_id = ? AND removed_at IS NULL').get(request.auth!.agent.id) as { id: string } | undefined;
    const sandboxId = (request.params as { id?: unknown } | undefined)?.id;
    securityEvent(svc, { type: 'sidekick.people_only.denied', actor_id: request.auth!.agent.id, payload: {
      action: request.url.split('?')[0]!.endsWith('/pulls') ? 'pull_request' : 'clone', sidekick_id: sidekick?.id ?? null,
      sandbox_id: typeof sandboxId === 'string' && /^sbx_[a-f0-9]{16}$/.test(sandboxId) ? sandboxId : null } });
    void reply.code(403).send({ error: { code: 'PEOPLE_ONLY', message: 'Sidekicks cannot use GitHub; ask a person in the room' } });
    return true;
  };

  app.post('/v1/sandboxes/:id/repos', { preHandler: svc.requireRole(['agent', 'supervisor']) }, async (request, reply) => {
    if (noSidekicks(request, reply)) return;
    const row = accessible(request, reply);
    if (!row) return;
    const input = repoSchema.safeParse(request.body);
    if (!input.success) return reply.code(400).send({ error: { code: 'VALIDATION_ERROR', message: 'repo (owner/name or https://github.com URL) with optional dir and ref required' } });
    return perform(reply, () => svc.sandbox.cloneRepo(row.id, request.auth!.agent.id, input.data));
  });

  // Download a project's npm dependencies through the sealed network's gate (registries only).
  app.post('/v1/sandboxes/:id/install', { preHandler: svc.requireRole(['agent', 'supervisor']) }, async (request, reply) => {
    const row = accessible(request, reply);
    if (!row) return;
    const input = installSchema.safeParse(request.body ?? {});
    if (!input.success) return reply.code(400).send({ error: { code: 'VALIDATION_ERROR', message: 'dir must be a folder inside the workspace' } });
    return perform(reply, () => svc.sandbox.installDependencies(row.id, request.auth!.agent.id, input.data.dir ?? '.', input.data.scripts === undefined ? {} : { scripts: input.data.scripts }));
  });

  // Push a branch and open a pull request. There is deliberately no merge route.
  app.post('/v1/sandboxes/:id/pulls', { preHandler: svc.requireRole(['agent', 'supervisor']) }, async (request, reply) => {
    if (noSidekicks(request, reply)) return;
    const row = accessible(request, reply);
    if (!row) return;
    const input = pullSchema.safeParse(request.body);
    if (!input.success) return reply.code(400).send({ error: { code: 'VALIDATION_ERROR', message: 'repo, branch and title required; optional dir, base and body' } });
    return perform(reply, async () => {
      const result = await svc.sandbox.openPullRequest(row.id, request.auth!.agent.id, input.data);
      reply.code(201);
      return result;
    });
  });

  // Read-only repository views for the console: clones, branch graph, commit contents.
  app.get('/v1/sandboxes/:id/git/repos', { preHandler: svc.authGuard }, async (request, reply) => {
    const row = accessible(request, reply);
    if (!row) return;
    return perform(reply, async () => ({ repos: await svc.sandbox.gitRepos(row.id, request.auth!.agent.id) }));
  });
  app.get('/v1/sandboxes/:id/git/log', { preHandler: svc.authGuard }, async (request, reply) => {
    const row = accessible(request, reply);
    if (!row) return;
    const query = gitQuery.safeParse(request.query);
    if (!query.success) return reply.code(400).send({ error: { code: 'VALIDATION_ERROR', message: 'dir required; optional limit 1–500' } });
    return perform(reply, () => svc.sandbox.gitOverview(row.id, request.auth!.agent.id, query.data.dir, query.data.limit));
  });
  app.get('/v1/sandboxes/:id/git/commit', { preHandler: svc.authGuard }, async (request, reply) => {
    const row = accessible(request, reply);
    if (!row) return;
    const query = gitCommitQuery.safeParse(request.query);
    if (!query.success) return reply.code(400).send({ error: { code: 'VALIDATION_ERROR', message: 'dir and sha required; optional path' } });
    const { dir, sha, path: file } = query.data;
    return perform(reply, async () => file === undefined
      ? { commit: await svc.sandbox.gitCommit(row.id, request.auth!.agent.id, dir, sha) }
      : { sha, path: file, patch: await svc.sandbox.gitPatch(row.id, request.auth!.agent.id, dir, sha, file) });
  });
  app.post('/v1/sandboxes/:id/git/checkout', { preHandler: svc.requireRole(['agent', 'supervisor']) }, async (request, reply) => {
    const row = accessible(request, reply);
    if (!row) return;
    const input = gitCheckout.safeParse(request.body);
    if (!input.success) return reply.code(400).send({ error: { code: 'VALIDATION_ERROR', message: 'dir and branch required' } });
    return perform(reply, () => svc.sandbox.gitCheckout(row.id, request.auth!.agent.id, input.data.dir, input.data.branch));
  });

  app.get('/v1/sandboxes/:id/execs', { preHandler: svc.authGuard }, async (request, reply) => {
    const row = accessible(request, reply);
    if (!row) return;
    const execs = svc.sandbox.listExecs(row.id);
    return { execs };
  });

  app.get('/v1/sandboxes/:id/files', { preHandler: svc.authGuard }, async (request, reply) => {
    const row = accessible(request, reply);
    if (!row) return;
    const query = fileQuery.safeParse(request.query);
    if (!query.success) return reply.code(400).send({ error: { code: 'VALIDATION_ERROR', message: 'Invalid path query' } });
    return perform(reply, async () => ({ entries: await svc.sandbox.listFiles(row.id, query.data.path, request.auth!.agent.id) }));
  });

  app.get('/v1/sandboxes/:id/file', { preHandler: svc.authGuard }, async (request, reply) => {
    const row = accessible(request, reply);
    if (!row) return;
    const query = fileQuery.safeParse(request.query);
    if (!query.success || query.data.path === '.') return reply.code(400).send({ error: { code: 'VALIDATION_ERROR', message: 'File path required' } });
    return perform(reply, async () => ({ path: query.data.path, content: await svc.sandbox.readFile(row.id, query.data.path, request.auth!.agent.id) }));
  });

  app.put('/v1/sandboxes/:id/file', { preHandler: svc.requireRole(['agent', 'supervisor']) }, async (request, reply) => {
    const row = accessible(request, reply);
    if (!row) return;
    const input = fileWrite.safeParse(request.body);
    if (!input.success || Buffer.byteLength(input.data.content) > svc.config.sandbox.maxOutputBytes) return reply.code(400).send({ error: { code: 'VALIDATION_ERROR', message: 'path and content (at most 256 KiB) required' } });
    return perform(reply, async () => {
      const result = await svc.sandbox.writeFile(row.id, input.data.path, input.data.content, request.auth!.agent.id);
      reply.code(201);
      return result;
    });
  });
}
