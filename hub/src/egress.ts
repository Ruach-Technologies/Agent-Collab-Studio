// The sealed network and its egress gate (see sandbox/egress-gate.mjs).
//
// Containers that need to reach the internet (dependency installs, GitHub clones and pushes,
// sidekicks talking to their AI provider) are attached only to an internal Docker network, which
// has no route to the internet or to this Mac. Their one way out is the gate container, which is
// also on Docker's normal network and forwards only what the container's profile allows. Each hub
// gets its own network and gate, named after its port, so two hubs on one machine never share.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export type EgressProfile = 'packages' | 'github' | 'sidekick';
const PORTS: Record<EgressProfile, number> = { packages: 3128, sidekick: 3129, github: 3130 };
const ALIAS = 'egress-gate';

export interface EgressOptions { hubPort: number; image: string; dockerBin?: string; scriptPath?: string }

export class EgressGate {
  readonly network: string;
  readonly container: string;
  private readonly script: string;
  private readonly version: string;
  private checkedAt = 0;
  private pending: Promise<void> | null = null;

  constructor(private readonly opts: EgressOptions) {
    this.network = `ach-sealed-${opts.hubPort}`;
    this.container = `ach-egress-gate-${opts.hubPort}`;
    this.script = opts.scriptPath ?? fileURLToPath(new URL('../../sandbox/egress-gate.mjs', import.meta.url));
    // A changed gate script, image or hub port replaces the running gate.
    this.version = createHash('sha256').update(readFileSync(this.script)).update(opts.image).update(String(opts.hubPort)).digest('hex').slice(0, 16);
  }

  /** Docker arguments that put a container on the sealed network with one profile. */
  args(profile: EgressProfile): string[] {
    const proxy = `http://${ALIAS}:${PORTS[profile]}`;
    return ['--network', this.network, '--label', `io.agent-collab-hub.egress=${profile}`,
      ...['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy'].flatMap((key) => ['--env', `${key}=${proxy}`]),
      '--env', 'NO_PROXY=', '--env', 'no_proxy='];
  }

  /** Creates the sealed network and starts the gate if needed. Cheap when both are already there. */
  ensure(): Promise<void> {
    if (Date.now() - this.checkedAt < 30_000) return Promise.resolve();
    this.pending ??= this.check().then(() => { this.checkedAt = Date.now(); }).finally(() => { this.pending = null; });
    return this.pending;
  }

  private async check(): Promise<void> {
    const net = await this.docker(['network', 'inspect', '--format', '{{.Internal}} {{index .Labels "io.agent-collab-hub.sealed"}}', this.network]);
    if (net.code !== 0) {
      const created = await this.docker(['network', 'create', '--internal', '--label', 'io.agent-collab-hub.sealed=1', this.network]);
      if (created.code !== 0) throw new Error('Could not create the sealed network');
    } else if (net.stdout.trim() !== 'true 1') throw new Error(`Network ${this.network} exists but is not the hub's sealed network`);

    const gate = await this.docker(['inspect', '--type', 'container', '--format', '{{.State.Running}} {{index .Config.Labels "io.agent-collab-hub.egress-gate"}}', this.container]);
    const [running, version] = gate.stdout.trim().split(' ');
    if (gate.code === 0 && running === 'true' && version === this.version) return;
    if (gate.code === 0) {
      if (!version) throw new Error(`Container ${this.container} exists but is not the hub's egress gate`);
      await this.docker(['rm', '-f', this.container]);
    }
    const run = await this.docker(['run', '-d', '--name', this.container, '--label', `io.agent-collab-hub.egress-gate=${this.version}`,
      '--restart', 'unless-stopped', '--network', 'bridge', '--add-host', 'host.docker.internal:host-gateway',
      '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--user', '1000:1000',
      '--memory', '256m', '--memory-swap', '256m', '--cpus', '0.5', '--pids-limit', '128',
      '--mount', `type=bind,src=${this.script},dst=/gate/egress-gate.mjs,readonly`, '--env', `GATE_HUB_PORT=${this.opts.hubPort}`,
      '--log-opt', 'max-size=5m', '--log-opt', 'max-file=2',
      this.opts.image, 'node', '/gate/egress-gate.mjs']);
    if (run.code !== 0) throw new Error(`Could not start the egress gate: ${run.stderr.trim().slice(0, 200)}`);
    const join = await this.docker(['network', 'connect', '--alias', ALIAS, this.network, this.container]);
    if (join.code !== 0) { await this.docker(['rm', '-f', this.container]); throw new Error('Could not attach the egress gate to the sealed network'); }
  }

  private docker(args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
    return new Promise((resolve) => {
      const proc = spawn(this.opts.dockerBin ?? 'docker', args, { stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = ''; let stderr = '';
      const timer = setTimeout(() => proc.kill('SIGKILL'), 60_000);
      proc.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); });
      proc.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
      proc.on('error', () => { clearTimeout(timer); resolve({ code: null, stdout, stderr }); });
      proc.on('close', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
    });
  }
}
