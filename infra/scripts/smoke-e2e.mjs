// Smoke check with a staff token: health, identity, rooms and the live socket. Prints no secrets.
const base = (process.env.HUB_URL ?? 'http://127.0.0.1:8791').replace(/\/$/, '');
const token = process.env.HUB_TOKEN;
async function get(path) {
  const response = await fetch(`${base}${path}`, { headers: { authorization: `Bearer ${token}`, 'ngrok-skip-browser-warning': '1' }, redirect: 'error', signal: AbortSignal.timeout(5_000) });
  if (!response.ok) throw new Error(`${path} failed with ${response.status}`);
  return response.json();
}

try {
  const health = await get('/healthz');
  if (health.status !== 'ok') throw new Error('unexpected health response');
  const { agent } = await get('/v1/whoami');
  if (!agent?.id) throw new Error('identity response is missing an agent');
  const { rooms } = await get('/v1/rooms');
  if (!Array.isArray(rooms)) throw new Error('unexpected rooms response');

  await new Promise((resolve, reject) => {
    let socket;
    const timer = setTimeout(() => finish(new Error('WebSocket hello timed out')), 5_000);
    let settled = false;
    function finish(error) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket?.close();
      if (error) reject(error);
      else resolve();
    }
    socket = new WebSocket(`${base.replace(/^http/, 'ws')}/v1/ws`);
    socket.addEventListener('open', () => socket.send(JSON.stringify({ t: 'hello', token })));
    socket.addEventListener('message', (event) => {
      let frame;
      try { frame = JSON.parse(String(event.data)); } catch { finish(new Error('WebSocket sent invalid JSON')); return; }
      if (frame.t === 'hello.ok') {
        if (frame.agent?.id !== agent.id) finish(new Error('WebSocket identity mismatch'));
        else finish();
      } else if (frame.t === 'error') finish(new Error('WebSocket authentication failed'));
    });
    socket.addEventListener('error', () => finish(new Error('WebSocket connection failed')));
    socket.addEventListener('close', () => finish(new Error('WebSocket closed before hello.ok')));
  });
  console.log('Smoke passed: health, bearer identity, rooms, and /v1/ws hello authentication.');
} catch {
  // Do not print server responses, URLs, frames, or tokens on failure.
  console.error('Smoke failed; check hub availability, HUB_URL, and HUB_TOKEN.');
  process.exitCode = 1;
}
