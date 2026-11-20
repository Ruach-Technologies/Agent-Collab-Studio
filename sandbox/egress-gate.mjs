// The egress gate: the only way out of the hub's sealed Docker network.
//
// Containers on the sealed network (`docker network create --internal`) have no route to the
// internet or to the Mac running the hub. This gate sits on that network and on Docker's normal
// network, and forwards only what one profile allows. Each profile listens on its own port, so a
// container is given exactly one profile by the proxy address in its environment.
//
// - Only HTTPS tunnels (CONNECT host:443) to allowlisted host names.
// - Every address a name resolves to must be public; private, loopback, link-local, carrier-grade
//   NAT and similar ranges are refused, so a name pointing at the Mac or the LAN goes nowhere.
// - The one exception is the hub itself for sidekicks: plain HTTP to host.docker.internal:<hub
//   port>, path /mcp only.
//
// No dependencies. Configuration comes from the environment; every decision is logged as one JSON
// line on stdout (host names only, never paths, headers or bodies), with the client container's
// address and, where Docker's resolver knows it, its name. When a tunnel or hub request ends, a
// `close` line records the bytes each way and how long it lasted. The hub reads these lines for
// its security monitor.
import http from 'node:http';
import net from 'node:net';
import { lookup, Resolver } from 'node:dns/promises';

const HUB_PORT = Number(process.env.GATE_HUB_PORT || 0);
const HUB_HOST = 'host.docker.internal';

const ANTHROPIC = ['api.anthropic.com', 'claude.ai', 'claude.com', 'platform.claude.com', 'console.anthropic.com', 'statsig.anthropic.com', 'downloads.claude.ai'];
const OPENAI = ['auth.openai.com', 'chatgpt.com', 'api.openai.com', 'ab.chatgpt.com'];
const GITHUB = ['github.com', 'codeload.github.com'];
const PACKAGES = ['registry.npmjs.org', 'registry.yarnpkg.com', 'pypi.org', 'files.pythonhosted.org', ...GITHUB, 'objects.githubusercontent.com'];

export const PROFILES = {
  packages: { port: 3128, hosts: PACKAGES, hub: false },
  github: { port: 3130, hosts: GITHUB, hub: false },
  sidekick: { port: 3129, hosts: [...ANTHROPIC, ...OPENAI], hub: true },
};

const write = (entry) => { process.stdout.write(`${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`); };

/** The client's address without the IPv4-mapped prefix. */
export function clientAddress(socket) {
  const address = String(socket?.remoteAddress ?? '');
  return address.toLowerCase().startsWith('::ffff:') ? address.slice(7) : address;
}

// Docker's embedded resolver answers reverse lookups for containers on the sealed network, which
// names a short-lived container even after it is gone. Best effort, cached, never blocks a decision.
const resolver = new Resolver({ timeout: 300, tries: 1 });
try { resolver.setServers(['127.0.0.11']); } catch { /* no embedded resolver */ }
const names = new Map();
async function peerName(address) {
  if (!net.isIP(address)) return undefined;
  const cached = names.get(address);
  if (cached && Date.now() - cached.at < 30_000) return cached.name;
  let name;
  try { name = (await resolver.reverse(address))[0]?.split('.')[0]; } catch { name = undefined; }
  if (name && !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(name)) name = undefined;
  if (names.size > 1000) names.clear();
  names.set(address, { name, at: Date.now() });
  return name;
}

/** Logs one decision with who asked; the name lookup happens after the decision is made. */
function log(entry, client) {
  if (!client) { write(entry); return; }
  void peerName(client).then((peer) => write({ ...entry, client, ...(peer ? { peer } : {}) }), () => write({ ...entry, client }));
}

/** True for any address that is not on the public internet. */
export function isPrivate(address) {
  if (net.isIPv4(address)) {
    const [a, b] = address.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19)) || a >= 224;
  }
  const lower = address.toLowerCase();
  if (lower.startsWith('::ffff:')) return isPrivate(lower.slice(7));
  return lower === '::' || lower === '::1' || /^f[cd]/.test(lower) || /^fe[89ab]/.test(lower) || lower.startsWith('ff') || lower.startsWith('64:ff9b');
}

const allowed = (profile, host) => profile.hosts.includes(host.toLowerCase());

/** A refused plain-HTTP target, reduced to a loggable host name (never a path or query). */
export function logHost(value) {
  const host = String(value ?? '').toLowerCase();
  return /^[a-z0-9.:[\]-]{1,260}$/.test(host) ? host : 'invalid';
}

/** Resolves a name and returns one public address, or null if any address is not public. */
async function publicAddress(host) {
  try {
    const addresses = await lookup(host, { all: true });
    if (!addresses.length || addresses.some((entry) => isPrivate(entry.address))) return null;
    return addresses[0].address;
  } catch { return null; }
}

function serve(name, profile) {
  const server = http.createServer(async (req, res) => {
    // Plain HTTP is only for the hub's MCP endpoint, and only for sidekicks.
    let target;
    try { target = new URL(req.url); } catch { target = null; }
    const hubOk = profile.hub && HUB_PORT > 0 && target && target.protocol === 'http:' && target.hostname === HUB_HOST
      && Number(target.port || 80) === HUB_PORT && (target.pathname === '/mcp' || target.pathname.startsWith('/mcp/'));
    const client = clientAddress(req.socket);
    if (!hubOk) { log({ profile: name, decision: 'deny', kind: 'http', host: logHost(target?.host) }, client); res.writeHead(403).end('Blocked by the hub\'s egress gate\n'); return; }
    const headers = { ...req.headers };
    delete headers['proxy-authorization']; delete headers['proxy-connection'];
    const host = `${HUB_HOST}:${HUB_PORT}`;
    const started = Date.now();
    let up = 0; let down = 0; let done = false;
    const finish = () => { if (done) return; done = true; log({ profile: name, decision: 'close', kind: 'hub', host, bytes_up: up, bytes_down: down, duration_ms: Date.now() - started }, client); };
    req.on('data', (chunk) => { up += chunk.length; });
    const upstream = http.request({ host: HUB_HOST, port: HUB_PORT, method: req.method, path: target.pathname + target.search, headers }, (reply) => {
      res.writeHead(reply.statusCode ?? 502, reply.headers);
      reply.on('data', (chunk) => { down += chunk.length; });
      reply.pipe(res);
    });
    upstream.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); });
    res.on('close', finish);
    req.pipe(upstream);
    log({ profile: name, decision: 'allow', kind: 'hub', host }, client);
  });
  server.on('connect', async (req, client, head) => {
    const match = /^([A-Za-z0-9.-]{1,253}):(\d{1,5})$/.exec(req.url ?? '');
    const host = match?.[1]?.toLowerCase() ?? 'invalid';
    const port = Number(match?.[2] ?? 0);
    const source = clientAddress(client);
    const refuse = (reason) => { log({ profile: name, decision: 'deny', kind: 'connect', host, port, reason }, source); client.end('HTTP/1.1 403 Forbidden\r\n\r\n'); };
    client.on('error', () => client.destroy());
    if (!match || port !== 443) return refuse('port');
    if (!allowed(profile, host)) return refuse('host');
    const address = await publicAddress(host);
    if (!address) return refuse('address');
    let opened = 0; let done = false;
    const upstream = net.connect(port, address, () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head?.length) upstream.write(head);
      upstream.pipe(client); client.pipe(upstream);
      opened = Date.now();
      log({ profile: name, decision: 'allow', kind: 'connect', host, port }, source);
    });
    // Bytes the container sent out (up) and received (down) through this tunnel.
    const finish = () => {
      if (done || !opened) return; done = true;
      log({ profile: name, decision: 'close', kind: 'connect', host, port, bytes_up: upstream.bytesWritten, bytes_down: upstream.bytesRead, duration_ms: Date.now() - opened }, source);
    };
    upstream.setTimeout(10 * 60_000, () => upstream.destroy());
    upstream.on('error', () => client.destroy());
    upstream.on('close', finish);
    client.on('close', () => { upstream.destroy(); });
  });
  server.listen(profile.port, '0.0.0.0', () => log({ profile: name, decision: 'listening', port: profile.port }));
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) {
  for (const [name, profile] of Object.entries(PROFILES)) serve(name, profile);
}
