import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { detectLaunchPlan } from '../src/launchplan.js';

let root: string;
const write = (rel: string, content: unknown) => {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content));
};
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-')); });
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe('launch plan', () => {
  it('has nothing to run in an empty workspace', () => {
    write('AGENTS.md', '# notes');
    expect(detectLaunchPlan(root, 5173)).toBeNull();
  });

  it('follows a root script into the frontend folder and runs Vite on all interfaces', () => {
    write('shop-app/package.json', { scripts: { dev: 'npm --prefix frontend run dev', test: 'npm --prefix backend test' } });
    write('shop-app/frontend/package.json', { scripts: { dev: 'vite' }, devDependencies: { vite: '^5' } });
    write('shop-app/backend/package.json', { scripts: { start: 'node index.js' }, dependencies: { express: '^4' } });
    write('shop-app/frontend/legacy/package.json', { scripts: { dev: 'vite' } });
    const plan = detectLaunchPlan(root, 5173)!;
    expect(plan).toMatchObject({ dir: 'shop-app/frontend', install_dir: 'shop-app/frontend', framework: 'Vite', needs_install: true,
      cmd: 'npm run dev -- --host 0.0.0.0 --port 5173 --strictPort' });
    fs.mkdirSync(path.join(root, 'shop-app/frontend/node_modules'));
    fs.writeFileSync(path.join(root, 'shop-app/frontend/node_modules/.package-lock.json'), '{}');
    expect(detectLaunchPlan(root, 5173)!.needs_install).toBe(false);
  });

  it('runs an app at the repository root, with the framework’s own host and port flags', () => {
    write('site/package.json', { scripts: { dev: 'next dev' }, dependencies: { next: '15', react: '19' } });
    expect(detectLaunchPlan(root, 3000)).toMatchObject({ dir: 'site', framework: 'Next.js', cmd: 'npm run dev -- -H 0.0.0.0 -p 3000' });
  });

  it('leaves a custom script alone and relies on HOST and PORT', () => {
    write('package.json', { scripts: { dev: 'concurrently "vite" "node api.js"' }, devDependencies: { vite: '5' } });
    expect(detectLaunchPlan(root, 5173)).toMatchObject({ dir: '', cmd: 'npm run dev' });
  });

  it('prefers an app folder in an npm-workspaces monorepo and installs from the root', () => {
    write('mono/package.json', { workspaces: ['apps/*'], devDependencies: { turbo: '2' } });
    write('mono/apps/web/package.json', { scripts: { dev: 'vite' }, dependencies: { vite: '5' } });
    write('mono/apps/docs/package.json', { scripts: { build: 'x' } });
    expect(detectLaunchPlan(root, 5173)).toMatchObject({ dir: 'mono/apps/web', install_dir: 'mono', needs_install: true });
  });

  it('serves a plain HTML site and ignores symlinked or oversized files', () => {
    write('page/index.html', '<h1>hi</h1>');
    expect(detectLaunchPlan(root, 8080)).toMatchObject({ dir: 'page', framework: 'Static site', cmd: 'python3 -m http.server 8080 --bind 0.0.0.0', needs_install: false });
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'outside-'));
    fs.writeFileSync(path.join(outside, 'package.json'), JSON.stringify({ scripts: { dev: 'vite' }, devDependencies: { vite: '5' } }));
    fs.symlinkSync(outside, path.join(root, 'linked'));
    write('big/package.json', `{"scripts":{"dev":"vite"},"x":"${'a'.repeat(600 * 1024)}"}`);
    expect(detectLaunchPlan(root, 8080)!.dir).toBe('page');
    fs.rmSync(outside, { recursive: true, force: true });
  });

  it('never puts repository text into the command', () => {
    write('evil/package.json', { scripts: { dev: 'cd "$(rm -rf ~)" && vite; curl x' }, devDependencies: { vite: '5' } });
    const plan = detectLaunchPlan(root, 5173)!;
    expect(plan.cmd).toBe('npm run dev');
    expect(plan.dir).toBe('evil');
  });
});
