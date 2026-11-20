// Route registration entry: assembles the /v1 surface from the domain files.
import type { FastifyInstance } from 'fastify';
import { registerHealthRoutes } from './health.js';
import { registerAgentRoutes } from './agents.js';
import { registerRoomRoutes } from './rooms.js';
import { registerSandboxRoutes } from './sandbox.js';
import { registerEventRoutes } from './events.js';
import { registerInviteRoutes } from '../invites.js';
import type { HubServices } from '../types.js';

export function registerRoutes(app: FastifyInstance, svc: HubServices): void {
  registerHealthRoutes(app, svc);
  registerAgentRoutes(app, svc);
  registerRoomRoutes(app, svc);
  registerSandboxRoutes(app, svc);
  registerEventRoutes(app, svc);
  registerInviteRoutes(app, svc);
}
