import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const exec = promisify(execFile);
const scriptsDir = dirname(fileURLToPath(import.meta.url));
const sourceRoot = resolve(scriptsDir, '../..');

async function fixture(t, explicitExecutables = false) {
  const runtimeRoot = join(sourceRoot, '.runtime');
  await mkdir(runtimeRoot, { recursive: true });
  const root = await mkdtemp(join(runtimeRoot, 'operations-test-'));
  t.after(async () => {
    try { await exec('bash', [join(root, 'infra/scripts/stop-hub.sh')], { timeout: 15_000 }); } catch {}
    await rm(root, { recursive: true, force: true });
  });
  const bin = join(root, 'bin');
  const home = join(root, 'home');
  for (const dir of ['infra/scripts', 'infra/ngrok', 'hub/src', 'hub/dist', '.runtime', 'bin', 'home/Library/Application Support/ngrok']) {
    await mkdir(join(root, dir), { recursive: true });
  }
  for (const script of ['start-hub.sh', 'start-tunnel.sh', 'stop-hub.sh', 'stop.sh', 'status.sh']) {
    await cp(join(scriptsDir, script), join(root, 'infra/scripts', script));
  }
  for (const file of ['hub/tsconfig.json', 'hub/tsconfig.build.json', 'hub/package.json', 'package-lock.json', 'infra/ngrok/agent-collab-hub.yml']) {
    await writeFile(join(root, file), '{}\n');
  }
  await writeFile(join(root, 'hub/dist/server.js'), 'setInterval(() => {}, 1000);\n');
  await writeFile(join(home, 'Library/Application Support/ngrok/ngrok.yml'), 'version: "3"\n');
  const executable = (name, body) => writeFile(join(bin, name), body, { mode: 0o755 });
  await executable('node', `#!/bin/bash\nif [[ "$1" == --version ]]; then printf 'v22.0.0\\n'; exit; fi\nif [[ "$1" == --input-type=module ]]; then exit; fi\nexec '${process.execPath.replaceAll("'", "'\\''")}' "$@"\n`);
  await executable('ngrok', `#!${process.execPath}\nimport fs from 'node:fs';\nfs.writeFileSync(process.env.MOCK_ROOT + '/ngrok-args.json', JSON.stringify(process.argv.slice(2)));\nsetInterval(() => {}, 1000);\n`);
  await executable('curl', '#!/bin/bash\nif [[ "$*" == *"4045/api/tunnels"* ]]; then [[ -f "$MOCK_ROOT/ngrok-args.json" ]] || exit 1; printf \'{"tunnels":[{"name":"agent-collab-hub","public_url":"https://example.test"}]}\\n\'; else printf \'{"status":"ok"}\\n\'; fi\n');
  await executable('npm', '#!/bin/bash\nprintf "build called\\n" >> "$MOCK_ROOT/build-calls"\n');
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, HOME: home, MOCK_ROOT: root };
  if (explicitExecutables) {
    const tools = join(root, 'explicit tool paths');
    await mkdir(tools);
    for (const name of ['node', 'npm', 'ngrok']) await cp(join(bin, name), join(tools, name));
    env.HUB_NODE_BIN = join(tools, 'node');
    env.HUB_NPM_BIN = join(tools, 'npm');
    env.HUB_NGROK_BIN = join(tools, 'ngrok');
    for (const name of ['node', 'npm', 'ngrok']) await executable(name, '#!/bin/bash\nexit 98\n');
  }
  const run = (script) => exec('bash', [join(root, 'infra/scripts', script)], { env, timeout: 15_000 });
  return { root, home, run, env };
}

test('local operation scripts keep PID ownership and merge ngrok configs without a real tunnel', async (t) => {
  const { root, home, run } = await fixture(t);
  await writeFile(join(root, 'hub/src/new.ts'), '// newer input\n');
  const started = await run('start-hub.sh');
  assert.match(started.stdout, /Hub is healthy/);
  const pid = Number(await readFile(join(root, '.runtime/hub.pid'), 'utf8'));
  process.kill(pid, 0);
  const builds = await readFile(join(root, 'build-calls'), 'utf8');
  assert.equal(builds.match(/build called/g)?.length, 2, 'builds missing/stale hub and UI');
  await assert.rejects(run('start-hub.sh'), (error) => /running process/.test(error.stderr));

  const tunnel = await run('start-tunnel.sh');
  assert.match(tunnel.stdout, /public URL written/);
  assert.equal((await readFile(join(root, '.runtime/tunnel-url'), 'utf8')).trim(), 'https://example.test/');
  const ngrokArgs = JSON.parse(await readFile(join(root, 'ngrok-args.json'), 'utf8'));
  assert.deepEqual(ngrokArgs, ['start', '--config', join(home, 'Library/Application Support/ngrok/ngrok.yml'), '--config', join(root, 'infra/ngrok/agent-collab-hub.yml'), 'agent-collab-hub']);
  const status = await run('status.sh');
  assert.match(status.stdout, /hub: running/);
  assert.match(status.stdout, /tunnel: running/);
  await run('stop.sh');
  await assert.rejects(readFile(join(root, '.runtime/hub.pid')), { code: 'ENOENT' });
  await assert.rejects(readFile(join(root, '.runtime/tunnel.pid')), { code: 'ENOENT' });
});

test('launcher executable overrides work with spaces and do not use conflicting PATH tools', async (t) => {
  const { root, run } = await fixture(t, true);
  await run('start-hub.sh');
  await run('start-tunnel.sh');
  assert.equal((await readFile(join(root, '.runtime/tunnel-url'), 'utf8')).trim(), 'https://example.test/');
  assert.match(await readFile(join(root, 'build-calls'), 'utf8'), /build called/);
  await run('stop.sh');
});

test('stop refuses an unrelated PID recorded as this hub', async (t) => {
  const { root, run } = await fixture(t);
  const unrelated = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  t.after(() => unrelated.kill());
  await writeFile(join(root, '.runtime/hub.pid'), String(unrelated.pid));
  await assert.rejects(run('stop-hub.sh'), (error) => /refusing to stop PID/.test(error.stderr));
  process.kill(unrelated.pid, 0);
});
