// Works out how to run a workspace's app in the preview, the way a "just press Start" app builder
// would: find the cloned project, find the app inside it (following a root script such as
// `npm --prefix frontend run dev`), pick the command for its framework with the right host and
// port, and say whether its packages still need installing.
//
// Everything read here comes from cloned, untrusted repositories, so only folder names that pass a
// strict pattern are used, symlinks are never followed, package.json files are size-capped, and the
// command is built from fixed templates: no text from the repository ends up in it.
import fs from 'node:fs';
import path from 'node:path';

export interface LaunchPlan {
  /** Folder under /workspace the command runs in ('' is the workspace itself). */
  dir: string;
  /** Folder whose packages are installed (the repository root for npm workspaces). */
  install_dir: string;
  cmd: string;
  port: number;
  /** Plain-language name, such as "Vite" or "Next.js". */
  framework: string;
  needs_install: boolean;
  summary: string;
}

type Pkg = { scripts?: Record<string, unknown>; dependencies?: Record<string, unknown>; devDependencies?: Record<string, unknown>; workspaces?: unknown };

const NAME = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,99}$/;
const APP_HINT = /^(frontend|front-end|web|webapp|client|app|site|www|ui)$/i;

interface Framework { dep: string; name: string; script: RegExp; flags: ((port: number) => string) | null; direct?: (port: number) => string }
const vite = (port: number) => `--host 0.0.0.0 --port ${port} --strictPort`;
const hostPort = (port: number) => `--host 0.0.0.0 --port ${port}`;
// Most specific first: SvelteKit and Remix are also Vite projects.
const FRAMEWORKS: Framework[] = [
  { dep: 'next', name: 'Next.js', script: /^next\s+dev\b/, flags: (p) => `-H 0.0.0.0 -p ${p}`, direct: (p) => `npx --no-install next dev -H 0.0.0.0 -p ${p}` },
  { dep: 'nuxt', name: 'Nuxt', script: /^(nuxt|nuxi)\s+dev\b/, flags: hostPort },
  { dep: 'astro', name: 'Astro', script: /^astro\s+dev\b/, flags: hostPort, direct: (p) => `npx --no-install astro dev ${hostPort(p)}` },
  { dep: '@sveltejs/kit', name: 'SvelteKit', script: /^vite(\s+dev)?(\s|$)/, flags: vite, direct: (p) => `npx --no-install vite dev ${vite(p)}` },
  { dep: '@remix-run/dev', name: 'Remix', script: /^remix\s+vite:dev\b/, flags: hostPort },
  { dep: 'gatsby', name: 'Gatsby', script: /^gatsby\s+develop\b/, flags: (p) => `-H 0.0.0.0 -p ${p}` },
  { dep: '@angular/cli', name: 'Angular', script: /^ng\s+serve\b/, flags: hostPort },
  // Reads HOST and PORT from the environment, which the preview always sets.
  { dep: 'react-scripts', name: 'Create React App', script: /^react-scripts\s+start\b/, flags: null },
  { dep: 'vite', name: 'Vite', script: /^vite(\s+(dev|serve))?(\s|$)/, flags: vite, direct: (p) => `npx --no-install vite ${vite(p)}` },
];

function lstat(file: string): fs.Stats | null { try { return fs.lstatSync(file); } catch { return null; } }
const isFile = (file: string) => lstat(file)?.isFile() === true;
const isDir = (file: string) => lstat(file)?.isDirectory() === true;

function readPkg(dir: string): Pkg | null {
  const file = path.join(dir, 'package.json');
  const stat = lstat(file);
  if (!stat?.isFile() || stat.size > 512 * 1024) return null;
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Pkg : null;
  } catch { return null; }
}

function subdirs(dir: string): string[] {
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && NAME.test(entry.name) && entry.name !== 'node_modules')
      .map((entry) => entry.name).sort().slice(0, 200);
  } catch { return []; }
}

const join = (...parts: string[]) => parts.filter(Boolean).join('/');
const scriptText = (pkg: Pkg, name: string) => typeof pkg.scripts?.[name] === 'string' ? (pkg.scripts[name] as string).trim() : null;
const hasDeps = (pkg: Pkg) => Object.keys(pkg.dependencies ?? {}).length + Object.keys(pkg.devDependencies ?? {}).length > 0;
const frameworkOf = (pkg: Pkg) => FRAMEWORKS.find((fw) => Object.hasOwn(pkg.dependencies ?? {}, fw.dep) || Object.hasOwn(pkg.devDependencies ?? {}, fw.dep)) ?? null;

/** A root script that runs another folder's app: `npm --prefix web run dev`, `cd web && …`, `pnpm -C web dev`. */
function delegatedFolder(pkg: Pkg): string | null {
  const body = scriptText(pkg, 'dev') ?? scriptText(pkg, 'start');
  if (!body) return null;
  const match = /(?:--prefix|--dir|--cwd|-C)[=\s]+["']?([A-Za-z0-9_][A-Za-z0-9._/-]*)/.exec(body) ?? /^cd\s+["']?([A-Za-z0-9_][A-Za-z0-9._/-]*)["']?\s*&&/.exec(body);
  if (!match) return null;
  const parts = match[1]!.replace(/^\.\//, '').replace(/\/+$/, '').split('/');
  return parts.length <= 3 && parts.every((part) => NAME.test(part) && part !== '..') ? parts.join('/') : null;
}

function needsInstall(dir: string, pkg: Pkg): boolean {
  if (!hasDeps(pkg)) return false;
  const modules = path.join(dir, 'node_modules');
  if (!isDir(modules)) return true;
  // npm records what it installed; a package.json edited afterwards means new packages may be missing.
  const marker = lstat(path.join(modules, '.package-lock.json')) ?? lstat(modules);
  const manifest = lstat(path.join(dir, 'package.json'));
  return !!marker && !!manifest && manifest.mtimeMs > marker.mtimeMs + 1000;
}

/** The project folder in the workspace: the workspace itself, or the cloned repository (newest first). */
function chooseRepo(root: string): string | null {
  if (readPkg(root) !== null || isFile(path.join(root, 'index.html'))) return '';
  const repos = subdirs(root).filter((name) => {
    const dir = path.join(root, name);
    return readPkg(dir) !== null || isFile(path.join(dir, 'index.html'))
      || subdirs(dir).some((sub) => readPkg(path.join(dir, sub)) !== null);
  });
  if (!repos.length) return null;
  return repos.map((name) => ({ name, at: lstat(path.join(root, name, '.git'))?.mtimeMs ?? lstat(path.join(root, name))?.mtimeMs ?? 0 }))
    .sort((a, b) => b.at - a.at || a.name.localeCompare(b.name))[0]!.name;
}

export function detectLaunchPlan(root: string, port: number): LaunchPlan | null {
  const repo = chooseRepo(root);
  if (repo === null) return null;
  const repoDir = path.join(root, repo);
  const repoPkg = readPkg(repoDir);

  // Candidate app folders: the repository, its direct subfolders, apps/* and packages/*, and any folder its root script runs.
  const delegated = repoPkg ? delegatedFolder(repoPkg) : null;
  const relative = new Set<string>(['']);
  for (const sub of subdirs(repoDir)) {
    relative.add(sub);
    if (sub === 'apps' || sub === 'packages') for (const inner of subdirs(path.join(repoDir, sub))) relative.add(join(sub, inner));
  }
  if (delegated && isFile(path.join(repoDir, delegated, 'package.json'))) relative.add(delegated);

  let best: { rel: string; pkg: Pkg; score: number } | null = null;
  for (const rel of relative) {
    const pkg = readPkg(path.join(repoDir, rel));
    if (!pkg) continue;
    const depth = rel ? rel.split('/').length : 0;
    let score = -2 * depth;
    if (rel && rel === delegated) score += 100;
    if (frameworkOf(pkg)) score += 20;
    if (scriptText(pkg, 'dev')) score += 6; else if (scriptText(pkg, 'start')) score += 3;
    if (rel && APP_HINT.test(rel.split('/').pop()!)) score += 3;
    // A root that only hands off to another folder is not itself the app.
    if (!rel && delegated && !frameworkOf(pkg)) score -= 50;
    if (!best || score > best.score) best = { rel, pkg, score };
  }

  if (!best) {
    // No package.json anywhere: a plain HTML site, served as files.
    const site = isFile(path.join(repoDir, 'index.html')) ? '' : isFile(path.join(repoDir, 'public', 'index.html')) ? 'public' : null;
    if (site === null) return null;
    const dir = join(repo, site);
    return { dir, install_dir: dir, cmd: `python3 -m http.server ${port} --bind 0.0.0.0`, port, framework: 'Static site', needs_install: false,
      summary: `Static site in ${dir || 'the workspace'}` };
  }

  const dir = join(repo, best.rel);
  const fw = frameworkOf(best.pkg);
  const script = scriptText(best.pkg, 'dev') !== null ? 'dev' : scriptText(best.pkg, 'start') !== null ? 'start' : null;
  let cmd: string;
  if (script) {
    const body = scriptText(best.pkg, script)!;
    cmd = fw?.flags && fw.script.test(body) ? `npm run ${script} -- ${fw.flags(port)}` : `npm run ${script}`;
  } else {
    cmd = fw?.direct ? fw.direct(port) : 'npm start';
  }
  // npm workspaces install from the repository root.
  const workspaceRoot = best.rel && repoPkg?.workspaces !== undefined;
  const installRel = workspaceRoot ? repo : dir;
  const installPkg = workspaceRoot ? repoPkg! : best.pkg;
  const framework = fw?.name ?? 'Node app';
  return { dir, install_dir: installRel, cmd, port, framework,
    needs_install: needsInstall(path.join(root, installRel), installPkg),
    summary: `${framework} app in ${dir || 'the workspace'}` };
}
