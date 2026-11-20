#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { access, cp, lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { homedir, userInfo } from 'node:os';
import { fileURLToPath } from 'node:url';

const exec = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const command = process.argv[2] ?? 'build';
async function executable(candidates) {
  for (const path of candidates) {
    try { await access(path, constants.X_OK); return path; } catch {}
  }
  return '';
}
/** The first word of this Mac account's full name, as the default staff name for new workspaces. */
async function ownerName() {
  try {
    const { stdout } = await exec('/usr/bin/id', ['-F'], { timeout: 2000 });
    const first = stdout.trim().split(/\s+/)[0] ?? '';
    return /^[^\x00-\x1f\x7f]{1,80}$/.test(first) ? first : userInfo().username;
  } catch { return userInfo().username; }
}
async function main() {
  if (process.platform !== 'darwin') throw new Error('Build this launcher on macOS with the Xcode command-line tools.');
  if (!['build', 'install'].includes(command)) throw new Error('Usage: node desktop/package.mjs build|install');
  const target = join(homedir(), 'Desktop', 'Agent Collab Hub.app');
  if (command === 'install') {
    try { await lstat(target); throw new Error('The Desktop application already exists. Move it aside before installing; it was not replaced.'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  const build = join(root, 'dist', 'launcher-builds', `${Date.now()}-${process.pid}`);
  const app = join(build, 'Agent Collab Hub.app');
  const contents = join(app, 'Contents');
  const resources = join(contents, 'Resources');
  const macos = join(contents, 'MacOS');
  const iconset = join(build, 'AppIcon.iconset');
  await mkdir(resources, { recursive: true }); await mkdir(macos);
  const options = { cwd: root, timeout: 120_000, maxBuffer: 1024 * 1024,
    env: { HOME: homedir(), PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LANG: 'en_US.UTF-8' } };
  await exec('/usr/bin/xcrun', ['swiftc', '-swift-version', '5', '-parse-as-library', '-framework', 'SwiftUI', '-framework', 'AppKit',
    '-o', join(macos, 'AgentCollabHub'), join(root, 'desktop/Launcher.swift')], options);
  await exec('/usr/bin/xcrun', ['swiftc', '-swift-version', '5', '-framework', 'AppKit',
    '-o', join(build, 'DrawIcon'), join(root, 'desktop/DrawIcon.swift')], options);
  await exec(join(build, 'DrawIcon'), [iconset], options);
  await exec('/usr/bin/iconutil', ['--convert', 'icns', '--output', join(resources, 'AppIcon.icns'), iconset], options);
  await cp(join(root, 'desktop/controller.mjs'), join(resources, 'controller.mjs'));
  await cp(join(root, 'desktop/workspaces.mjs'), join(resources, 'workspaces.mjs'));
  const nodePath = process.execPath;
  const npmPath = await executable([join(dirname(nodePath), 'npm'), '/opt/homebrew/bin/npm', '/usr/local/bin/npm']);
  const ngrokPath = await executable([join(homedir(), '.local/bin/ngrok'), '/opt/homebrew/bin/ngrok', '/usr/local/bin/ngrok']);
  await writeFile(join(resources, 'bootstrap.json'), JSON.stringify({ repository: root, nodePath, npmPath, ngrokPath,
    sandboxImage: 'agent-collab-sandbox:local', openConsole: true, tunnelOnLaunch: false, ownerName: await ownerName() }, null, 2) + '\n');
  const { version } = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  await writeFile(join(contents, 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleName</key><string>Agent Collab Hub</string>
<key>CFBundleDisplayName</key><string>Agent Collab Hub</string>
<key>CFBundleIdentifier</key><string>local.agentcollabhub.launcher</string>
<key>CFBundleExecutable</key><string>AgentCollabHub</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleVersion</key><string>${version}</string>
<key>CFBundleShortVersionString</key><string>${version}</string>
<key>CFBundleIconFile</key><string>AppIcon</string>
<key>LSMinimumSystemVersion</key><string>13.0</string>
<key>NSHighResolutionCapable</key><true/>
<key>NSPrincipalClass</key><string>NSApplication</string>
</dict></plist>\n`);
  await exec('/usr/bin/plutil', ['-lint', join(contents, 'Info.plist')], options);
  await exec('/usr/bin/codesign', ['--force', '--sign', '-', app], options);
  await exec('/usr/bin/codesign', ['--verify', '--strict', '--verbose=2', app], options);
  if (command === 'install') {
    // Recheck before copying; never remove or merge into a pre-existing target.
    try { await lstat(target); throw new Error('Desktop install target appeared during the build; it was not replaced.'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    await cp(app, target, { recursive: true, errorOnExist: true, force: false });
    await exec('/usr/bin/codesign', ['--verify', '--strict', '--verbose=2', target], options);
    console.log(`Installed: ${target}`);
  }
  console.log(`Built: ${app}`);
  console.log('No services were started, stopped, or exposed. Double-click the app to review its startup controls.');
}
main().catch((error) => { console.error(error.message); process.exitCode = 1; });
