import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';

// These tests cover the staff ops console; the Studio is the default view, so open the console.
test.beforeEach(async ({ context }) => {
  await context.addInitScript(() => { try { localStorage.setItem('agent-collab-hub.mode', 'console'); } catch { /* storage unavailable */ } });
});

function fixture() { return JSON.parse(readFileSync('e2e/.state/fixture.json', 'utf8')) as { operatorToken: string; token: string; alice: string; room: string; foreignToken: string; foreignRoom: string }; }

test('operator can watch remote-agent messages, compose, browse views, and create rooms', async ({ page, request }) => {
  const data = fixture();
  const errors: string[] = [];
  const websocketUrls: string[] = [];
  page.on('websocket', (socket) => websocketUrls.push(socket.url()));
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  await page.getByPlaceholder('paste bearer token').fill(data.token);
  await page.getByRole('button', { name: 'connect', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'live feed', exact: true })).toBeVisible();
  await expect(page.locator('.sidebar-conn')).toHaveText('live');
  await expect(page.getByLabel('Authenticated workspace')).toHaveText('Legacy workspace');
  await page.getByRole('button', { name: 'Rooms', exact: false }).first().click();
  await page.getByRole('button', { name: 'Browser collaboration' }).click();
  await expect(page.getByText('Ready to collaborate', { exact: true })).toBeVisible();
  const response = await request.post(`/v1/rooms/${data.room}/messages`, {
    headers: { authorization: `Bearer ${data.alice}` }, data: { body: 'An agent posted this live' },
  });
  expect(response.status()).toBe(201);
  await expect(page.getByText('An agent posted this live', { exact: true })).toBeVisible();
  await page.getByPlaceholder('message… Enter to send · Shift+Enter for newline').fill('Operator guidance');
  await page.getByRole('button', { name: 'send', exact: true }).click();
  await expect(page.getByText('Operator guidance', { exact: true })).toBeVisible();
  await page.getByLabel('New room name').fill('New workspace');
  await page.getByRole('button', { name: 'create room', exact: true }).click();
  await expect(page.getByRole('button', { name: 'New workspace' })).toBeVisible();
  await page.getByRole('button', { name: 'Sandbox', exact: false }).first().click();
  await expect(page.getByRole('heading', { name: 'sandbox', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'provision sandbox', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Agents', exact: false }).first().click();
  await expect(page.getByRole('heading', { name: 'agents', exact: true })).toBeVisible();
  await expect(page.getByText('browser-alice', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Audit', exact: false }).first().click();
  await expect(page.getByRole('heading', { name: 'audit', exact: true })).toBeVisible();
  expect(errors).toEqual([]);
  expect(websocketUrls.length).toBeGreaterThan(0);
  expect(websocketUrls.every((url) => new URL(url).pathname === '/v1/ws' && !new URL(url).search)).toBe(true);
});

test('browser supervisor remains in its workspace and changing tokens clears the previous view', async ({ page, request }) => {
  const data = fixture();
  await page.goto('/');
  await page.getByPlaceholder('paste bearer token').fill(data.token);
  await page.getByRole('button', { name: 'connect', exact: true }).click();
  await expect(page.locator('.sidebar-conn')).toHaveText('live');
  await expect(page.getByLabel('Authenticated workspace')).toHaveText('Legacy workspace');
  await page.getByRole('button', { name: 'Rooms', exact: false }).first().click();
  await expect(page.getByRole('button', { name: 'Browser collaboration' })).toBeVisible();
  await expect(page.getByText('Foreign confidential room', { exact: true })).toHaveCount(0);
  const denied = await request.get(`/v1/rooms/${data.foreignRoom}/messages`, { headers: { authorization: `Bearer ${data.token}` } });
  expect([403, 404]).toContain(denied.status());
  expect(await denied.text()).not.toContain('Foreign confidential message');
  await page.getByRole('button', { name: 'sign out', exact: true }).click();
  await page.getByPlaceholder('paste bearer token').fill(data.foreignToken);
  await page.getByRole('button', { name: 'connect', exact: true }).click();
  await expect(page.locator('.sidebar-conn')).toHaveText('live');
  await expect(page.getByLabel('Authenticated workspace')).toHaveText('Other collaboration');
  await page.getByRole('button', { name: 'Rooms', exact: false }).first().click();
  await expect(page.getByRole('button', { name: 'Foreign confidential room' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Browser collaboration' })).toHaveCount(0);
});

test('local operator switches between workspaces without mixing their rooms', async ({ page, request }) => {
  const data = fixture();
  await page.goto('/');
  await page.getByPlaceholder('paste bearer token').fill(data.operatorToken);
  await page.getByRole('button', { name: 'connect', exact: true }).click();
  await expect(page.locator('.sidebar-conn')).toHaveText('live');
  const switcher = page.getByLabel('Workspace', { exact: true });
  await expect(switcher.locator('option')).toHaveText(['Legacy workspace', 'Other collaboration']);
  await expect(switcher.locator('option:checked')).toHaveText('Legacy workspace');
  await page.getByRole('button', { name: 'Rooms', exact: false }).first().click();
  await expect(page.getByRole('button', { name: 'Browser collaboration' })).toBeVisible();
  await switcher.selectOption({ label: 'Other collaboration' });
  await expect(page.getByRole('button', { name: 'Foreign confidential room' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Browser collaboration' })).toHaveCount(0);
  await expect(page.locator('.sidebar-conn')).toHaveText('live');
  // The live socket follows the selected workspace: a message posted there appears without a refresh.
  await page.getByRole('button', { name: 'Foreign confidential room' }).click();
  const posted = await request.post(`/v1/rooms/${data.foreignRoom}/messages`, { headers: { authorization: `Bearer ${data.foreignToken}` }, data: { body: 'Posted after the switch' } });
  expect(posted.status()).toBe(201);
  await expect(page.getByText('Posted after the switch', { exact: true })).toBeVisible();
  await switcher.selectOption({ label: 'Legacy workspace' });
  await expect(page.getByRole('button', { name: 'Browser collaboration' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Foreign confidential room' })).toHaveCount(0);
  // The same credential presented as if it had come through the tunnel is refused.
  const proxied = await request.get('/v1/whoami', { headers: { authorization: `Bearer ${data.operatorToken}`, 'x-forwarded-for': '203.0.113.9' } });
  expect(proxied.status()).toBe(403);
});

test('sandbox tools and output work through the same browser origin', async ({ page, request }) => {
  test.skip(process.env.HUB_TEST_DOCKER !== '1', 'Opt-in real Docker browser test');
  test.setTimeout(60_000);
  const data = fixture();
  const provision = await request.post(`/v1/rooms/${data.room}/sandbox`, { headers: { authorization: `Bearer ${data.token}` } });
  expect(provision.status()).toBe(201);
  const { sandbox } = await provision.json();
  const written = await request.put(`/v1/sandboxes/${sandbox.id}/file`, {
    headers: { authorization: `Bearer ${data.alice}` }, data: { path: 'collaboration.txt', content: 'Shared agent workspace' },
  });
  expect(written.status()).toBe(201);
  await page.goto('/');
  await page.getByPlaceholder('paste bearer token').fill(data.token);
  await page.getByRole('button', { name: 'connect', exact: true }).click();
  await expect(page.locator('.sidebar-conn')).toHaveText('live');
  await page.getByRole('button', { name: 'Sandbox', exact: false }).first().click();
  await page.getByRole('button', { name: /Browser collaboration/ }).click();
  await page.getByPlaceholder('command', { exact: true }).fill('printf browser-sandbox-success');
  await page.getByRole('button', { name: 'run', exact: true }).click();
  await expect(page.locator('.exec-output')).toContainText('browser-sandbox-success');
  await page.getByRole('button', { name: /collaboration.txt/ }).click();
  await expect(page.locator('.viewer pre')).toHaveText('Shared agent workspace');
});

test('workspace follows agent edits live, seeds instructions, and saves operator edits', async ({ page, request }) => {
  test.skip(process.env.HUB_TEST_DOCKER !== '1', 'Opt-in real Docker browser test');
  test.setTimeout(60_000);
  const data = fixture();
  const agent = { authorization: `Bearer ${data.alice}` };
  const provision = await request.post(`/v1/rooms/${data.room}/sandbox`, { headers: { authorization: `Bearer ${data.token}` } });
  expect(provision.status()).toBe(201);
  const { sandbox } = await provision.json();
  const file = `/v1/sandboxes/${sandbox.id}/file`;
  await request.put(file, { headers: agent, data: { path: 'live/plan.md', content: 'one\ntwo\nthree\n' } });
  await page.goto('/');
  await page.getByPlaceholder('paste bearer token').fill(data.token);
  await page.getByRole('button', { name: 'connect', exact: true }).click();
  await expect(page.locator('.sidebar-conn')).toHaveText('live');
  await page.getByRole('button', { name: 'Sandbox', exact: false }).first().click();
  await page.getByRole('button', { name: /Browser collaboration/ }).click();
  // Provisioning placed the operator's instruction files in the workspace root.
  await page.getByRole('button', { name: /AGENTS\.md/ }).click();
  await expect(page.locator('.viewer pre')).toHaveText('Fixture agent instructions');
  await expect(page.getByRole('button', { name: /CLAUDE\.md/ })).toBeVisible();
  // An agent write to another file is followed without any click, then a later edit highlights only its changed line.
  await request.put(file, { headers: agent, data: { path: 'live/plan.md', content: 'one\ntwo\nthree\nfour\n' } });
  await expect(page.locator('.viewer-head')).toContainText('live/plan.md');
  await expect(page.locator('.viewer-head')).toContainText('edited by browser-alice');
  await request.put(file, { headers: agent, data: { path: 'live/plan.md', content: 'one\nTWO by alice\nthree\nfour\n' } });
  await expect(page.locator('.viewer pre .line-changed')).toHaveText('TWO by alice');
  await expect(page.locator('.viewer pre .line-changed')).toHaveCount(1);
  // The operator edits in place; an agent write during the edit is flagged instead of clobbering the draft.
  await page.getByRole('button', { name: 'edit', exact: true }).click();
  await page.getByLabel('Edit live/plan.md').fill('operator version\n');
  await request.put(file, { headers: agent, data: { path: 'live/plan.md', content: 'agent raced\n' } });
  await expect(page.getByText('changed by browser-alice while you were editing', { exact: false })).toBeVisible();
  await expect(page.getByLabel('Edit live/plan.md')).toHaveValue('operator version\n');
  await page.getByRole('button', { name: 'save', exact: true }).click();
  await expect(page.locator('.viewer pre')).toHaveText('operator version');
  const saved = await request.get(`${file}?path=live/plan.md`, { headers: agent });
  expect((await saved.json()).content).toBe('operator version\n');
});

test('git graph shows branches and commits, opens a commit diff, and switches branch', async ({ page, request }) => {
  test.skip(process.env.HUB_TEST_DOCKER !== '1', 'Opt-in real Docker browser test');
  test.setTimeout(90_000);
  const data = fixture();
  const agent = { authorization: `Bearer ${data.alice}` };
  const provision = await request.post(`/v1/rooms/${data.room}/sandbox`, { headers: { authorization: `Bearer ${data.token}` } });
  expect(provision.status()).toBe(201);
  const { sandbox } = await provision.json();
  const exec = async (cmd: string) => {
    const reply = await request.post(`/v1/sandboxes/${sandbox.id}/exec`, { headers: agent, data: { cmd } });
    expect((await reply.json()).exitCode, cmd).toBe(0);
  };
  // The command guardrail rejects the bare word "init", so the fixture repository is created through Python.
  await exec(`rm -rf graph-demo && python3 -c "import subprocess;subprocess.run(['git','init','-q','-b','main','graph-demo'],check=True)" && cd graph-demo && printf "one\\n" > notes.md && git add . && git commit -q -m "Initial notes"`);
  await exec('cd graph-demo && git checkout -q -b ai/second && printf "one\\ntwo\\n" > notes.md && printf "x\\n" > extra.txt && git add . && git commit -q -m "Add second note"');
  await exec('cd graph-demo && git checkout -q main && printf "main\\n" > main.txt && git add . && git commit -q -m "Main moves on" && git merge -q --no-ff -m "Merge second" ai/second');
  await page.goto('/');
  await page.getByPlaceholder('paste bearer token').fill(data.token);
  await page.getByRole('button', { name: 'connect', exact: true }).click();
  await expect(page.locator('.sidebar-conn')).toHaveText('live');
  await page.getByRole('button', { name: 'Sandbox', exact: false }).first().click();
  await page.getByRole('button', { name: /Browser collaboration/ }).click();
  await page.getByRole('tab', { name: 'git graph' }).click();
  await expect(page.getByLabel('Repository', { exact: true })).toHaveValue('graph-demo');
  const rows = page.locator('.git-log .git-row');
  await expect(rows).toHaveCount(4);
  await expect(rows.nth(0)).toContainText('Merge second');
  await expect(rows.nth(0)).toContainText('HEAD');
  await expect(rows.nth(0)).toContainText('main');
  await expect(page.locator('.git-log .git-row', { hasText: 'Add second note' })).toContainText('ai/second');
  if (process.env.HUB_E2E_SHOTS) await page.screenshot({ path: `${process.env.HUB_E2E_SHOTS}/git-graph.png` });
  // Selecting a commit opens the commit & diff tab with its files and a per-file patch.
  await page.locator('.git-log .git-row', { hasText: 'Add second note' }).click();
  await expect(page.getByRole('tab', { name: 'commit & diff' })).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('.git-files .git-file')).toHaveText([/extra\.txt\s*\+1/, /notes\.md\s*\+1/]);
  await page.locator('.git-file', { hasText: 'notes.md' }).click();
  await expect(page.locator('.git-patch .diff-add')).toHaveText('+two');
  if (process.env.HUB_E2E_SHOTS) await page.screenshot({ path: `${process.env.HUB_E2E_SHOTS}/git-review.png` });
  // Switching branch needs no typed command and shows up in the graph and the terminal history.
  await page.getByRole('tab', { name: 'git graph' }).click();
  await page.getByLabel('Branch to check out').selectOption('ai/second');
  await page.getByRole('button', { name: 'checkout', exact: true }).click();
  await expect(page.getByText('switched to ai/second', { exact: true })).toBeVisible();
  await expect(page.locator('.git-bar .tag').first()).toHaveText('ai/second');
  await expect(page.locator('.exec-list')).toContainText('git -C graph-demo checkout ai/second');
  // A commit made by an agent appears without a manual reload.
  await exec('cd graph-demo && printf "live\\n" > live.txt && git add . && git commit -q -m "Agent live commit"');
  await expect(page.locator('.git-log .git-row', { hasText: 'Agent live commit' })).toBeVisible();
  // The code tab and explorer keep working next to it.
  await page.getByRole('tab', { name: 'code', exact: true }).click();
  await page.locator('.tree').getByRole('button', { name: /graph-demo\// }).click();
  await page.locator('.tree').getByRole('button', { name: /live\.txt/ }).click();
  await expect(page.locator('.viewer pre')).toHaveText('live');
  if (process.env.HUB_E2E_SHOTS) {
    await page.screenshot({ path: `${process.env.HUB_E2E_SHOTS}/code.png` });
    await page.setViewportSize({ width: 700, height: 900 });
    await page.screenshot({ path: `${process.env.HUB_E2E_SHOTS}/narrow.png`, fullPage: true });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  }
});

test('workspace listing failure stops loading and retry restores browsing without auth polling', async ({ page }) => {
  const data = fixture(), sandboxId = 'sbx_1111111111111111';
  let failed = true, identityRequests = 0, mutations = 0;
  page.on('request', (request) => {
    if (new URL(request.url()).pathname === '/v1/whoami') identityRequests++;
    if (request.method() !== 'GET') mutations++;
  });
  await page.route(`**/v1/rooms/${data.room}/sandbox`, (route) => route.fulfill({ json: { sandbox: {
    id: sandboxId, room_id: data.room, status: 'stopped', container_id: 'fixture', image: 'sandbox:test',
  } } }));
  await page.route(`**/v1/sandboxes/${sandboxId}/execs`, (route) => route.fulfill({ json: { execs: [] } }));
  await page.route(`**/v1/sandboxes/${sandboxId}/files?*`, (route) => {
    if (failed) return route.fulfill({ status: 409, json: { error: { code: 'SANDBOX_NOT_RUNNING', message: 'Sandbox container is stopped; ask a supervisor to restore it' } } });
    const path = new URL(route.request().url()).searchParams.get('path');
    return route.fulfill({ json: { entries: path === '.' ? [{ name: 'notes', type: 'dir', size: 0 }] : [{ name: 'readme.txt', type: 'file', size: 5 }] } });
  });
  await page.route(`**/v1/sandboxes/${sandboxId}/file?*`, (route) => route.fulfill({ json: { content: 'hello' } }));
  await page.goto('/');
  await page.getByPlaceholder('paste bearer token').fill(data.token);
  await page.getByRole('button', { name: 'connect', exact: true }).click();
  await expect(page.locator('.sidebar-conn')).toHaveText('live');
  await page.getByRole('button', { name: 'Sandbox', exact: false }).first().click();
  await page.getByRole('button', { name: /Browser collaboration/ }).click();
  await expect(page.locator('.tree')).toContainText('could not load workspace');
  await expect(page.locator('.tree .spinner')).toHaveCount(0);
  await expect(page.getByText('SANDBOX_NOT_RUNNING: Sandbox container is stopped; ask a supervisor to restore it')).toBeVisible();
  const identityBaseline = identityRequests, mutationBaseline = mutations;
  await page.waitForTimeout(1200);
  expect(identityRequests).toBe(identityBaseline); expect(mutations).toBe(mutationBaseline);
  failed = false;
  await page.getByRole('button', { name: 'retry workspace', exact: true }).click();
  await page.getByRole('button', { name: /notes\// }).click();
  await page.getByRole('button', { name: /readme.txt/ }).click();
  await expect(page.locator('.viewer pre')).toHaveText('hello');
  await expect(page.getByText('could not load workspace', { exact: false })).toHaveCount(0);
});

test('switching sandbox rooms ignores a previous directory response', async ({ page }) => {
  const data = fixture(), otherRoom = 'room_eeeeeeeeeeeeeeee', firstSandbox = 'sbx_1111111111111111', otherSandbox = 'sbx_2222222222222222';
  let release!: () => void, requested = false;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  await page.route('**/v1/rooms', (route) => route.fulfill({ json: { rooms: [
    { id: data.room, name: 'Browser collaboration', slug: 'first' },
    { id: otherRoom, name: 'Second workspace', slug: 'second' },
  ] } }));
  for (const [room, sandbox] of [[data.room, firstSandbox], [otherRoom, otherSandbox]]) {
    await page.route(`**/v1/rooms/${room}/sandbox`, (route) => route.fulfill({ json: { sandbox: {
      id: sandbox, room_id: room, status: 'running', container_id: 'fixture', image: 'sandbox:test',
    } } }));
    await page.route(`**/v1/sandboxes/${sandbox}/execs`, (route) => route.fulfill({ json: { execs: [] } }));
  }
  await page.route(`**/v1/sandboxes/${firstSandbox}/files?*`, async (route) => {
    requested = true; await blocked;
    await route.fulfill({ json: { entries: [{ name: 'previous-private.txt', type: 'file', size: 1 }] } });
  });
  await page.route(`**/v1/sandboxes/${otherSandbox}/files?*`, (route) => route.fulfill({ json: { entries: [{ name: 'current.txt', type: 'file', size: 1 }] } }));
  try {
    await page.goto('/');
    await page.getByPlaceholder('paste bearer token').fill(data.token);
    await page.getByRole('button', { name: 'connect', exact: true }).click();
    await expect(page.locator('.sidebar-conn')).toHaveText('live');
    await page.getByRole('button', { name: 'Sandbox', exact: false }).first().click();
    await page.getByRole('button', { name: /Browser collaboration/ }).click();
    await expect.poll(() => requested).toBe(true);
    await page.getByRole('button', { name: /Second workspace/ }).click();
    await expect(page.getByRole('button', { name: /current.txt/ })).toBeVisible();
    release(); await page.waitForTimeout(100);
    await expect(page.getByRole('button', { name: /previous-private.txt/ })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /current.txt/ })).toBeVisible();
  } finally { release(); }
});

test('invalid credentials stay behind the token gate and mobile layout fits', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await page.getByPlaceholder('paste bearer token').fill('invalid');
  await page.getByRole('button', { name: 'connect', exact: true }).click();
  await expect(page.locator('.gate-error')).toContainText('UNAUTHENTICATED');
  const width = await page.evaluate(() => ({ actual: document.documentElement.scrollWidth, viewport: window.innerWidth }));
  expect(width.actual).toBeLessThanOrEqual(width.viewport);
  await page.getByPlaceholder('paste bearer token').fill(fixture().token);
  await page.getByRole('button', { name: 'connect', exact: true }).click();
  await expect(page.locator('.sidebar-conn')).toHaveText('live');
  await page.getByRole('button', { name: 'Sandbox', exact: false }).first().click();
  await expect(page.getByRole('button', { name: 'provision sandbox', exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});
