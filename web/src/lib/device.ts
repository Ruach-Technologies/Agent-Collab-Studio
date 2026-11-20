// The browser's device key. A client session only works with requests signed by the key that
// started it, and the private half is created non-extractable: page scripts can ask the browser to
// sign with it, but nothing (including this code) can read it out. A session token copied from
// storage, a log or another machine is therefore useless on its own.
//
// Each sign-in makes a fresh key pair, kept in IndexedDB (which stores CryptoKey objects without
// exposing them). Signatures are ECDSA P-256 with SHA-256 in raw r||s form, base64url encoded.
const DB_NAME = "agent-collab-hub.device";
const STORE = "keys";
const ID = "session";

let cached: CryptoKeyPair | null = null;

function openStore(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => { request.result.createObjectStore(STORE); };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Could not open device storage"));
  });
}
async function withStore<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openStore();
  try {
    return await new Promise<T>((resolve, reject) => {
      const request = run(db.transaction(STORE, mode).objectStore(STORE));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error("Device storage failed"));
    });
  } finally { db.close(); }
}

const base64url = (bytes: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

export interface DeviceKey { kty: "EC"; crv: "P-256"; x: string; y: string }

/** Makes and keeps a new key pair for the next session; returns the public half for the hub. */
export async function freshDeviceKey(): Promise<DeviceKey> {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
  try { await withStore("readwrite", (store) => store.put(pair, ID)); } catch { /* memory only: the session ends with this tab */ }
  cached = pair;
  const jwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  return { kty: "EC", crv: "P-256", x: String(jwk.x), y: String(jwk.y) };
}

async function currentKey(): Promise<CryptoKeyPair | null> {
  if (cached) return cached;
  try { cached = (await withStore<CryptoKeyPair | undefined>("readonly", (store) => store.get(ID))) ?? null; } catch { cached = null; }
  return cached;
}

/** Forgets the key, so the session it signed for can never be used again from here. */
export async function forgetDeviceKey(): Promise<void> {
  cached = null;
  try { await withStore("readwrite", (store) => store.delete(ID)); } catch { /* nothing stored */ }
}

export const SESSION_TOKEN = /^achs_(ses_[a-f0-9]{16})\.[A-Za-z0-9_-]{43}$/;

/** The proof header value for one request: `<ms timestamp>.<signature>` over what the hub checks. */
export async function proof(token: string, method: string, path: string): Promise<string | null> {
  const match = SESSION_TOKEN.exec(token);
  const key = match ? await currentKey() : null;
  if (!match || !key) return null;
  const ts = String(Date.now());
  const message = new TextEncoder().encode(`${ts}\n${method.toUpperCase()}\n${path}\n${match[1]}`);
  const signature = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key.privateKey, message);
  return `${ts}.${base64url(signature)}`;
}
