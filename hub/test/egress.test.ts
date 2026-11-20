import { describe, expect, it } from 'vitest';
// The gate is plain JavaScript that runs in its own container; its rules are tested here.
// @ts-expect-error -- untyped .mjs module outside the hub's sources
import { PROFILES, clientAddress, isPrivate, logHost } from '../../sandbox/egress-gate.mjs';

describe('egress gate rules', () => {
  it('refuses every address that is not on the public internet', () => {
    for (const address of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.65.254', '169.254.169.254', '100.64.0.1', '0.0.0.0', '224.0.0.1',
      '::1', '::', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1', '::ffff:192.168.1.1']) expect(isPrivate(address), address).toBe(true);
    for (const address of ['104.16.1.1', '140.82.112.3', '172.32.0.1', '2606:4700::6810:1', '::ffff:8.8.8.8']) expect(isPrivate(address), address).toBe(false);
  });

  it('gives each profile only what it needs', () => {
    const p = PROFILES as Record<string, { hosts: string[]; hub: boolean; port: number }>;
    expect(p.packages!.hosts).toContain('registry.npmjs.org');
    expect(p.packages!.hosts).not.toContain('api.anthropic.com');
    expect(p.github!.hosts).toEqual(['github.com', 'codeload.github.com']);
    expect(p.sidekick!.hosts).toEqual(expect.arrayContaining(['api.anthropic.com', 'auth.openai.com', 'chatgpt.com']));
    expect(p.sidekick!.hosts).not.toContain('registry.npmjs.org');
    expect(p.sidekick!.hub).toBe(true);
    expect(p.packages!.hub || p.github!.hub).toBe(false);
    expect(new Set(Object.values(p).map((profile) => profile.port)).size).toBe(3);
  });

  it('logs host names only, and the client container\'s address', () => {
    expect(logHost('Registry.NPMjs.org:443')).toBe('registry.npmjs.org:443');
    expect(logHost('host.docker.internal:4000')).toBe('host.docker.internal:4000');
    for (const value of ['evil.test/path?token=1', 'a b', '', undefined, 'x'.repeat(300)]) expect(logHost(value)).toBe('invalid');
    expect(clientAddress({ remoteAddress: '::ffff:172.30.0.5' })).toBe('172.30.0.5');
    expect(clientAddress({ remoteAddress: 'fd00::5' })).toBe('fd00::5');
    expect(clientAddress(undefined)).toBe('');
  });
});
