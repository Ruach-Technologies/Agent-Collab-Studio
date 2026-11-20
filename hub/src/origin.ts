// The addresses people use to reach this hub.
import fs from 'node:fs';
import type { IncomingHttpHeaders } from 'node:http';
import { isLocalRequest } from './operator.js';
import type { HubServices } from './types.js';

/**
 * The origin clients must use. Loopback requests keep their own address; everything else uses the
 * operator-configured address or the recorded tunnel address, never the request's Host header.
 */
export function publicOrigin(svc: HubServices, headers: IncomingHttpHeaders): string | null {
  if (isLocalRequest(headers)) return `http://${String(headers.host)}`;
  return sharedOrigin(svc);
}

/** The address people outside this machine use, or null when none is configured or recorded. */
export function sharedOrigin(svc: HubServices): string | null {
  let candidate = svc.config.publicUrl;
  if (!candidate) { try { candidate = fs.readFileSync(svc.config.tunnelUrlFile, 'utf8').trim(); } catch { return null; } }
  try {
    const url = new URL(candidate);
    return url.protocol === 'https:' && url.pathname === '/' && !url.search && !url.hash && !url.username && !url.password ? url.origin : null;
  } catch { return null; }
}
