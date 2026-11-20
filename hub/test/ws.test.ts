import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { once } from 'node:events';
import { buildServer, type BuiltHub } from '../src/server.js';
import { TokenRegistry } from '../src/tokens.js';
import { initWsState, startHeartbeat } from '../src/ws.js';

let hub: BuiltHub;
let dir: string;
let url: string;
const sockets: WebSocket[] = [];
function inbox(socket: WebSocket) {
  const frames: Record<string, unknown>[] = [];
  socket.on('message', (data) => frames.push(JSON.parse(data.toString()) as Record<string, unknown>));
  return {
    frames,
    async next(type: string, text?: string) {
      const deadline = Date.now() + 3000;
      while (Date.now() < deadline) {
        const frame = frames.find((item) => item.t === type && (!text || JSON.stringify(item).includes(text)));
        if (frame) return frame;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw new Error(`No ${type} frame${text ? ` matching ${text}` : ''}`);
    },
  };
}
async function connect(token?: string) {
  const socket = new WebSocket(url);
  sockets.push(socket);
  const incoming = inbox(socket);
  await once(socket, 'open');
  if (token) { socket.send(JSON.stringify({ t: 'hello', token })); await incoming.next('hello.ok'); }
  return { socket, ...incoming };
}
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'collab-ws-'));
  hub = await buildServer({ HUB_DATA_DIR: join(dir, 'data'), HUB_WORKSPACES_DIR: join(dir, 'workspaces'), HUB_WEB_DIST: join(dir, 'missing'), HUB_LOG_LEVEL: 'silent' });
  await hub.app.listen({ port: 0, host: '127.0.0.1' });
  const address = hub.app.server.address();
  if (!address || typeof address === 'string') throw new Error('No port');
  url = `ws://127.0.0.1:${address.port}/v1/ws`;
});
afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.terminate();
  await hub.app.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('live agent line', () => {
  it('authenticates first-frame hello and delivers messages to other agents and the operator', async () => {
    const registry = new TokenRegistry(hub.services.db);
    const operator = registry.issue('operator', 'supervisor');
    const a = registry.issue('alice', 'agent'); const b = registry.issue('bob', 'agent'); const c = registry.issue('eve', 'agent');
    const room = hub.services.rooms.create({ name: 'Live workspace' }, operator.agent.id).id;
    for (const agent of [a, b, c]) hub.services.rooms.join(room, agent.agent.id);
    const [alice, bob, eve, supervisor] = await Promise.all([connect(a.token), connect(b.token), connect(c.token), connect(operator.token)]);
    alice.socket.send(JSON.stringify({ t: 'message.send', room, body: 'hello collaborators' }));
    await bob.next('message.created', 'hello collaborators');
    await supervisor.next('message.created', 'hello collaborators');
    alice.socket.send(JSON.stringify({ t: 'message.send', room, body: 'private coordination', to: b.agent.id }));
    await bob.next('message.created', 'private coordination');
    await supervisor.next('message.created', 'private coordination');
    alice.socket.send(JSON.stringify({ t: 'ping' }));
    await alice.next('pong');
    expect(JSON.stringify(eve.frames)).not.toContain('private coordination');
    expect(JSON.stringify(eve.frames)).toContain('hello collaborators');
  });
  it('rejects malformed/null/array frames without crashing the server', async () => {
    const registry = new TokenRegistry(hub.services.db); const agent = registry.issue('agent', 'agent');
    const client = await connect(agent.token);
    client.socket.send('null'); client.socket.send('[]'); client.socket.send('{');
    await client.next('error', 'BAD_FRAME');
    client.socket.send(JSON.stringify({ t: 'ping' }));
    await client.next('pong');
    expect((await hub.app.inject('/healthz')).statusCode).toBe(200);
  });
  it('denies revoked WebSocket identities on their next frame', async () => {
    const registry = new TokenRegistry(hub.services.db); const agent = registry.issue('agent', 'agent');
    const client = await connect(agent.token);
    registry.revoke(agent.agent.id);
    const closed = once(client.socket, 'close');
    client.socket.send(JSON.stringify({ t: 'ping' }));
    expect((await closed)[0]).toBe(4008);
  });
  it('checks authorization before pinging idle sockets on the heartbeat', () => {
    vi.useFakeTimers();
    const state = initWsState();
    const socket = { ping: vi.fn(), terminate: vi.fn() } as unknown as WebSocket;
    const agent = new TokenRegistry(hub.services.db).issue('idle-agent', 'agent');
    state.clients.set(socket, {
      socket, agent: { ...agent.agent, last_seen_at: null }, tokenHash: 'test-only', subscribedRooms: null, alive: true,
    });
    const authorization = vi.fn(() => false);
    const heartbeat = startHeartbeat(state, 30_000, authorization);
    try {
      vi.advanceTimersByTime(30_000);
      expect(authorization).toHaveBeenCalledOnce();
      expect(socket.ping).not.toHaveBeenCalled();
    } finally {
      clearInterval(heartbeat);
      vi.useRealTimers();
    }
  });
  it('rejects cross-origin browser sockets before hello authentication', async () => {
    const socket = new WebSocket(url, { origin: 'https://unrelated.example' });
    sockets.push(socket);
    const closed = once(socket, 'close');
    await once(socket, 'open');
    expect((await closed)[0]).toBe(4003);
  });
  it('requires authentication and refuses token-bearing URL queries', async () => {
    const client = await connect();
    const closed = once(client.socket, 'close'); client.socket.send(JSON.stringify({ t: 'ping' }));
    expect((await closed)[0]).toBe(4008);
    const socket = new WebSocket(`${url}?token=do-not-log`); sockets.push(socket);
    const queryClosed = once(socket, 'close'); await once(socket, 'open');
    expect((await queryClosed)[0]).toBe(4008);
  });
});
