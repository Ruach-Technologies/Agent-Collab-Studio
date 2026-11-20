import type { FastifyInstance } from 'fastify';
import type { HubServices } from '../types.js';
import { SCHEMA_VERSION } from '../db.js';

export function registerHealthRoutes(app: FastifyInstance, svc: HubServices): void {
  app.get('/healthz', async () => ({ status: 'ok', schema_version: SCHEMA_VERSION, workspace_protocol: 1 }));

  app.get('/readyz', async () => {
    // ready once the DB is open (schema applied at boot) — the event spine is queryable
    svc.db.prepare('SELECT 1 FROM hub_metadata LIMIT 1').get();
    return { status: 'ready', schema_version: SCHEMA_VERSION };
  });
}
