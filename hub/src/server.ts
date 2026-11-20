import { SessionClock, registerSessionRoutes } from './sessions.js';
import { EgressGate } from './egress.js';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest, type preHandlerAsyncHookHandler } from 'fastify';
import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

import { workspaceGithubToken, loadConfig } from './config.js';
import { openDb, type DbHandle } from './db.js';
import { EventBus } from './events.js';
import { bearerGuard, requireRole } from './auth.js';
import { TokenBucketLimiter, makeRateLimitHook } from './ratelimit.js';
import { RoomService, RoomError } from './rooms.js';
import { SandboxService } from './sandbox.js';
import { registerRoutes } from './routes/index.js';
import { SidekickService, registerSidekickRoutes } from './sidekicks.js';
import { registerBoardRoutes } from './board.js';
import { initWsState, registerWsRoutes } from './ws.js';
import { registerMcpRoutes } from './mcp.js';
import { DevServerService, registerDevServerRoutes } from './devserver.js';
import { SecurityMonitor, registerSecurityRoutes, requestSource } from './security.js';
import type { HubServices, Role } from './types.js';

export interface BuiltHub {
  app: FastifyInstance;
  services: HubServices;
  sidekicks: SidekickService;
  devServers: DevServerService;
  security: SecurityMonitor;
}

function roleGuard(allowed: readonly Role[], authGuard: preHandlerAsyncHookHandler, events: EventBus): preHandlerAsyncHookHandler {
  return async function (this: FastifyInstance, request: FastifyRequest, reply: FastifyReply) {
    await authGuard.call(this, request, reply);
    if (reply.sent || !request.auth) return;
    if (!requireRole(allowed, reply, request.auth)) {
      events.append({ type: 'auth.denied', actor_id: request.auth.agent.id, payload: { path: request.url.split('?')[0], reason: 'role', source: requestSource(request) } });
    }
  };
}

export async function buildServer(env: NodeJS.ProcessEnv = process.env): Promise<BuiltHub> {
  process.umask(0o077);
  const config = loadConfig(env);
  const db = openDb(config.dbPath, { allowLegacyMigration: env.HUB_ALLOW_WORKSPACE_MIGRATION === '1' });
  const events = new EventBus(db);
  const limiter = new TokenBucketLimiter({
    capacity: config.rate.max,
    refillPerSecond: config.rate.max / (config.rate.windowMs / 1_000),
  });
  const rooms = new RoomService({ db, events });
  const egress = config.egress.enabled ? new EgressGate({ hubPort: config.port, image: config.egress.image }) : undefined;
  const sandbox = new SandboxService({
    db,
    events,
    ...(egress ? { egress } : {}),
    config: {
      image: config.sandbox.image,
      workspacesDir: config.workspacesDir,
      execTimeoutMs: config.sandbox.execTimeoutMs,
      maxExecTimeoutMs: 120_000,
      outputCapBytes: config.sandbox.maxOutputBytes,
      memLimitMB: config.sandbox.memLimitMB,
      cpus: config.sandbox.cpus,
      pidsLimit: config.sandbox.pidsLimit,
      containerUser: config.sandbox.containerUser,
      denylist: [],
      seedFiles: config.sandbox.seedFiles,
      cloneTimeoutMs: config.sandbox.cloneTimeoutMs,
      github: { token: (owner: string, workspaceId: string | null) => workspaceGithubToken(config.dataDir, workspaceId, owner), prBranchPrefix: config.sandbox.prBranchPrefix },
    },
  });

  const devServers = new DevServerService({ db, events, sandbox, dataDir: config.dataDir, preview: { ...config.preview, host: config.host } });
  // Previews may only be framed from their own listener, never served on this origin.
  const previewOrigins = config.preview.port === null ? '' : [`http://127.0.0.1:${config.preview.port}`, `http://localhost:${config.preview.port}`, config.preview.publicUrl]
    .filter(Boolean).join(' ');
  const frameSrc = previewOrigins ? ` frame-src ${previewOrigins};` : '';

  const internalSecret = randomBytes(32).toString('base64url');
  const authGuard = bearerGuard(db, events, limiter, config.dataDir, internalSecret);
  const rateLimitGuard = makeRateLimitHook(limiter, events);
  const authenticatedGuard: preHandlerAsyncHookHandler = async function (this: FastifyInstance, request, reply) {
    await authGuard.call(this, request, reply);
    if (!reply.sent && request.auth) await rateLimitGuard.call(this, request, reply);
  };
  const services: HubServices = {
    config,
    db,
    events,
    rooms,
    sandbox,
    limiter,
    ...(egress ? { egress } : {}),
    authGuard: authenticatedGuard,
    requireRole: (allowed) => roleGuard(allowed, authenticatedGuard, events),
  };

  const app = Fastify({
    logger: {
      level: config.logLevel,
      serializers: { req: (request) => ({ method: request.method, url: request.url.split('?')[0] ?? '/' }) },
      redact: {
        paths: ['req.headers.authorization', 'req.headers.Authorization', 'req.query.token', 'req.headers["x-hub-internal"]'],
        censor: '[REDACTED]',
      },
    },
    bodyLimit: 2 * 1024 * 1024,
    requestTimeout: 120_000,
  });

  app.decorateRequest('auth', null);
  app.addHook('onRequest', async (request, reply) => {
    if (request.url.startsWith('/v1/') && !request.headers.authorization && !limiter.check(`ip:${request.ip}`).allowed) {
      void reply.code(429).send({ error: { code: 'RATE_LIMITED', message: 'Rate limit exceeded' } });
      return;
    }
    reply
      .header('x-content-type-options', 'nosniff')
      .header('x-frame-options', 'DENY')
      .header('referrer-policy', 'no-referrer')
      .header('content-security-policy', `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:;${frameSrc} frame-ancestors 'none'; base-uri 'none'`)
      .header('cache-control', 'no-store')
      .header('permissions-policy', 'camera=(), microphone=(), geolocation=()');
  });

  // Installed before any route so that every route, in every plugin scope, inherits it.
  const sidekicks = new SidekickService(services);
  // The leftover sweep talks to Docker, so test servers skip it.
  sidekicks.start({ sweep: process.env.NODE_ENV !== 'test' });
  // Collects only once the hub is listening (startServer); built-only hubs (tests) never call Docker.
  const security = new SecurityMonitor(services);
  services.security = security;
  // Ends client sessions that ran out, which also puts their sidekicks to sleep.
  const sessionClock = new SessionClock(db, events);
  sessionClock.start();
  app.addHook('onClose', async () => { sessionClock.stop(); security.stop(); sidekicks.stop(); await devServers.close(); db.close(); });
  app.setErrorHandler((error: Error & { statusCode?: number; code?: string }, request, reply) => {
    if (error instanceof RoomError) {
      const status = error.code === 'ROOM_NOT_FOUND' ? 404 : error.code === 'FORBIDDEN' || error.code === 'NOT_MEMBER' ? 403 : 400;
      void reply.code(status).send({ error: { code: error.code, message: error.message } });
      return;
    }
    const status = error.statusCode && error.statusCode >= 400 && error.statusCode < 600 ? error.statusCode : 500;
    if (status >= 500) {
      request.log.error({ err: { name: error.name, message: error.message } }, 'request failed');
    }
    void reply.code(status).send({
      error: {
        code: status >= 500 ? 'INTERNAL_ERROR' : (error.code ?? 'REQUEST_ERROR'),
        message: status >= 500 ? 'Internal error' : error.message,
      },
    });
  });

  await app.register(fastifyWebsocket, { options: { maxPayload: 64 * 1024 } });
  registerRoutes(app, services);
  registerSidekickRoutes(app, services, sidekicks);
  registerSessionRoutes(app, services);
  registerBoardRoutes(app, services);
  registerDevServerRoutes(app, services, devServers);
  registerSecurityRoutes(app, services, security);
  registerWsRoutes(app, services, initWsState());
  await registerMcpRoutes(app, services, internalSecret);

  if (existsSync(config.webDistDir)) {
    await app.register(fastifyStatic, { root: config.webDistDir, prefix: '/' });
    app.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith('/v1/') || request.url === '/v1' || request.url === '/ws' || /^\/mcp(\/|\?|$)/.test(request.url)) {
        return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Not found' } });
      }
      return reply.sendFile('index.html');
    });
  }

  return { app, services, sidekicks, devServers, security };
}

export async function startServer(env: NodeJS.ProcessEnv = process.env): Promise<BuiltHub> {
  const hub = await buildServer(env);
  try {
    await hub.app.listen({ port: hub.services.config.port, host: hub.services.config.host });
  } catch (error) {
    await hub.app.close();
    throw error;
  }
  const preview = await hub.devServers.listen();
  hub.security.start();
  if (preview.listening) hub.app.log.info(`dev-server previews on http://${hub.services.config.host}:${preview.port}`);
  hub.services.events.append({
    type: 'server.started',
    payload: { port: hub.services.config.port, host: hub.services.config.host },
  });
  return hub;
}

const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun && process.env.NODE_ENV !== 'test') {
  startServer()
    .then(({ app, services }) => {
      console.log(`[hub] listening on http://${services.config.host}:${services.config.port}`);
      let closing = false;
      const stop = async () => {
        if (closing) return;
        closing = true;
        await app.close();
      };
      process.once('SIGINT', () => { void stop(); });
      process.once('SIGTERM', () => { void stop(); });
    })
    .catch((error: unknown) => {
      console.error('[hub] failed to start:', error);
      process.exit(1);
    });
}

export type { DbHandle };
