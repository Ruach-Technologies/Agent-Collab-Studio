import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Repository root = parent of the hub/ workspace package. */
export const REPO_ROOT = path.resolve(__dirname, "..", "..");

function resolvePort(v: string | undefined, fallback: number): number {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : fallback;
}

export interface HubConfig {
  port: number;
  host: string;
  logLevel: string;
  dataDir: string;
  dbPath: string;
  workspacesDir: string;
  runtimeDir: string;
  webDistDir: string;
  tunnelUrlFile: string;
  /** Public HTTPS origin override for sign-in metadata; otherwise the recorded tunnel address is used. */
  publicUrl: string | null;
  /** Extra exact redirect addresses allowed for connector sign-in, beyond the built-in Claude and ChatGPT ones. */
  /** Sandbox policy knobs. */
  sandbox: {
    image: string;
    memLimitMB: number;
    cpus: number;
    pidsLimit: number;
    containerUser: string;
    execTimeoutMs: number;
    maxOutputBytes: number;
    /** Host instruction files copied into each workspace root and cloned repository. */
    seedFiles: { name: string; source: string }[];
    /** Agents may only push pull-request branches under this prefix. */
    prBranchPrefix: string;
    cloneTimeoutMs: number;
  };
  /**
   * Live dev-server previews. Sandbox pages are untrusted, so they are served from their own
   * listener (a different origin from the hub, which keeps tokens in browser storage).
   * `port` null disables previews. `publicUrl` is a separately tunnelled address for remote clients.
   */
  /** The sealed network's gate: the only way out for installs, GitHub steps and sidekicks. */
  egress: { enabled: boolean; image: string };
  preview: { port: number | null; publicUrl: string | null };
  /** Client sidekicks: each runs the Claude Code CLI in its own container. */
  sidekick: {
    image: string;
    /** How a sidekick container reaches this hub's /mcp endpoint. */
    hubUrl: string;
    /** Empty working directory for turns, so no project files are read. */
    workdir: string;
    memLimitMB: number;
    turnTimeoutMs: number;
    maxTurns: number;
  };
  /** Security monitor: gate traffic, alerts and the optional outbound alert hook. */
  security: {
    /** False stops the periodic collector; the API and on-demand refresh still work. */
    monitor: boolean;
    intervalMs: number;
    retentionDays: number;
    maxRows: number;
    /** Bytes sent out by one container in an hour above which an alert is raised. */
    egressUpBytesPerHour: number;
    /** https only; high-severity alerts are posted here (title, severity, counts). */
    webhookUrl: string | null;
  };
  /** Rate limiting: max requests per token per window (ms). */
  rate: { windowMs: number; max: number };
  /** Message and room limits. */
  limits: {
    messageMaxChars: number;
    roomNameMaxChars: number;
    maxRooms: number;
    pageSize: number;
  };
}

/**
 * `HUB_SANDBOX_SEED_FILES` is a comma-separated list of absolute host paths;
 * unset selects the operator's global agent instructions, empty disables.
 */
function resolveSeedFiles(value: string | undefined): { name: string; source: string }[] {
  const sources = value === undefined
    ? [path.join(os.homedir(), ".codex", "AGENTS.md"), path.join(os.homedir(), ".claude", "CLAUDE.md")]
    : value.split(",").map((entry) => entry.trim()).filter(Boolean);
  const seen = new Set<string>();
  return sources.filter((source) => path.isAbsolute(source)).map((source) => ({ name: path.basename(source), source }))
    .filter((file) => !seen.has(file.name) && Boolean(seen.add(file.name)));
}

/**
 * Git-ignored `sandbox/.env` holds the operator's GitHub settings. It is read
 * for the real process environment (or an explicit `HUB_SANDBOX_ENV_FILE`), so
 * tests that pass their own environment never pick up a local credential.
 * Variables already set in the environment win.
 */
function sandboxEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const file = env.HUB_SANDBOX_ENV_FILE ?? (env === process.env ? path.join(REPO_ROOT, "sandbox", ".env") : "");
  if (!file) return env;
  let text: string;
  try { text = fs.readFileSync(file, "utf8"); } catch { return env; }
  const values: NodeJS.ProcessEnv = {};
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?(HUB_SANDBOX_GITHUB_[A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (match) values[match[1]!] = match[2]!.replace(/^(['"])(.*)\1$/, "$2");
  }
  return { ...values, ...env };
}

/**
 * The operator's GitHub tokens, saved per workspace and per GitHub organization by the desktop app
 * in the private data folder (`github-tokens.json`, mode 600). Read on every clone and pull request,
 * so adding or removing a token applies at once. Kept out of HubConfig so a credential is never
 * serialized with it. A workspace only ever gets its own tokens.
 */
export function workspaceGithubToken(dataDir: string, workspaceId: string | null | undefined, owner: string): string | undefined {
  if (!workspaceId || !/^wks_[a-f0-9]{16}$/.test(workspaceId) || !/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/.test(owner)) return undefined;
  const file = path.join(dataDir, "github-tokens.json");
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()) return undefined;
    const all = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, Record<string, { token?: unknown }>>;
    const mine = all && Object.hasOwn(all, workspaceId) ? all[workspaceId] : undefined;
    const key = owner.toLowerCase();
    const token = mine && Object.hasOwn(mine, key) ? mine[key]?.token : undefined;
    return typeof token === "string" && /^[A-Za-z0-9_]{20,255}$/.test(token) ? token : undefined;
  } catch { return undefined; }
}

/** An https address without credentials, or null. */
function securityWebhookUrl(value: string | undefined): string | null {
  if (!value?.trim()) return null;
  try {
    const url = new URL(value.trim());
    return url.protocol === "https:" && !url.username && !url.password && url.hostname ? url.href : null;
  } catch { return null; }
}

function boundedInt(value: string | undefined, fallback: number, min: number, max: number): number {
  const n = Number(value);
  return Number.isInteger(n) && n >= min && n <= max ? n : fallback;
}

/** An http(s) origin only; a path, query or credentials would be ambiguous for cookies and framing. */
function previewPublicUrl(value: string | undefined): string | null {
  if (!value?.trim()) return null;
  try {
    const url = new URL(value.trim());
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== "/") return null;
    return url.origin;
  } catch { return null; }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): HubConfig {
  const dataDir =
    env.HUB_DATA_DIR && env.HUB_DATA_DIR.trim()
      ? path.resolve(env.HUB_DATA_DIR)
      : path.join(REPO_ROOT, "data");
  const workspacesDir =
    env.HUB_WORKSPACES_DIR && env.HUB_WORKSPACES_DIR.trim()
      ? path.resolve(env.HUB_WORKSPACES_DIR)
      : path.join(REPO_ROOT, "workspaces");
  const runtimeDir = path.join(REPO_ROOT, ".runtime");

  for (const dir of [dataDir, workspacesDir, runtimeDir]) {
    fs.mkdirSync(dir, { recursive: true });
  }

  return {
    port: resolvePort(env.HUB_PORT, 8791),
    host: "127.0.0.1",
    logLevel: env.HUB_LOG_LEVEL ?? "info",
    dataDir,
    dbPath: path.join(dataDir, "hub.sqlite"),
    workspacesDir,
    runtimeDir,
    webDistDir: env.HUB_WEB_DIST ?? path.join(REPO_ROOT, "web", "dist"),
    tunnelUrlFile: path.join(runtimeDir, "tunnel-url"),
    publicUrl: env.HUB_PUBLIC_URL?.trim() || null,
    sandbox: {
      // Node 22, npm, Python 3 and Git (built from sandbox/Dockerfile). Rooms keep the image they were set up with.
      image: env.HUB_SANDBOX_IMAGE ?? "agent-collab-sandbox:local",
      memLimitMB: 1024,
      cpus: 1.0,
      pidsLimit: 256,
      containerUser: env.HUB_SANDBOX_USER ?? "1000:1000",
      execTimeoutMs: 60_000,
      maxOutputBytes: 256 * 1024,
      seedFiles: resolveSeedFiles(env.HUB_SANDBOX_SEED_FILES),
      prBranchPrefix: /^[A-Za-z0-9][A-Za-z0-9._/-]{0,40}$/.test(sandboxEnv(env).HUB_SANDBOX_GITHUB_PR_PREFIX ?? "") ? sandboxEnv(env).HUB_SANDBOX_GITHUB_PR_PREFIX! : "ai/",
      cloneTimeoutMs: 300_000,
    },
    egress: {
      enabled: !/^(0|off|false)$/i.test(env.HUB_EGRESS_GATE?.trim() ?? ""),
      image: env.HUB_EGRESS_IMAGE ?? env.HUB_SANDBOX_IMAGE ?? "agent-collab-sandbox:local",
    },
    preview: {
      port: /^(0|off|false)$/i.test(env.HUB_PREVIEW_PORT?.trim() ?? "") ? null : resolvePort(env.HUB_PREVIEW_PORT, resolvePort(env.HUB_PORT, 8791) + 100),
      publicUrl: previewPublicUrl(env.HUB_PREVIEW_PUBLIC_URL),
    },
    sidekick: {
      image: env.HUB_SIDEKICK_IMAGE ?? "ach-sidekick:dev",
      hubUrl: (env.HUB_SIDEKICK_HUB_URL ?? `http://host.docker.internal:${resolvePort(env.HUB_PORT, 8791)}`).replace(/\/+$/, ""),
      workdir: env.HUB_SIDEKICK_WORKDIR ?? "/opt/sidekick/work",
      memLimitMB: 1536,
      turnTimeoutMs: 10 * 60_000,
      maxTurns: 40,
    },
    security: {
      monitor: !/^(0|off|false)$/i.test(env.HUB_SECURITY_MONITOR?.trim() ?? ""),
      intervalMs: boundedInt(env.HUB_SECURITY_INTERVAL_MS, 15_000, 5_000, 600_000),
      retentionDays: boundedInt(env.HUB_SECURITY_RETENTION_DAYS, 30, 1, 365),
      maxRows: boundedInt(env.HUB_SECURITY_MAX_ROWS, 200_000, 1_000, 5_000_000),
      egressUpBytesPerHour: boundedInt(env.HUB_SECURITY_EGRESS_UP_MB, 50, 1, 100_000) * 1024 * 1024,
      webhookUrl: securityWebhookUrl(env.HUB_SECURITY_WEBHOOK_URL),
    },
    rate: { windowMs: 10_000, max: 120 },
    limits: {
      messageMaxChars: 8000,
      roomNameMaxChars: 80,
      maxRooms: 200,
      pageSize: 200,
    },
  };
}
