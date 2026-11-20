// Test stand-in for a browser: a device key pair, and request signing for session tokens.
import { generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { proofMessage, type DeviceKey } from '../src/sessions.js';

const keys = new Map<string, KeyObject>();

export function newDevice(): { key: DeviceKey; privateKey: KeyObject } {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = publicKey.export({ format: 'jwk' }) as { x: string; y: string };
  return { key: { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y }, privateKey };
}

/** Links a session token to the private key that started it. */
export function bindSession(token: string, privateKey: KeyObject): void { keys.set(token, privateKey); }

export function proofFor(token: string, method: string, url: string, key = keys.get(token)): string | null {
  if (!key) return null;
  const ts = Date.now();
  const signature = sign('sha256', Buffer.from(proofMessage(ts, method, url, token.slice(5, 25))), { key, dsaEncoding: 'ieee-p1363' });
  return `${ts}.${signature.toString('base64url')}`;
}

/** Adds the proof header when the request carries a known session token. */
export function signed<T extends { method?: string; url: string; headers?: Record<string, string> }>(options: T): T {
  const token = options.headers?.authorization?.replace(/^Bearer /, '') ?? '';
  const proof = proofFor(token, options.method ?? 'GET', options.url);
  return proof ? { ...options, headers: { ...options.headers, 'x-hub-proof': proof } } : options;
}
