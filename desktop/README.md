# Desktop app

**Agent Collab Hub.app** is the local control room for the hub in this checkout. It starts and stops the hub and tunnel, and manages workspaces, people, rooms, invites and GitHub tokens. It talks to the hub through a local command run with your Mac account's authority (`hub/scripts/manage.mjs`); there is no administration endpoint on the network.

## Build and install

Needs macOS 14+, Xcode Command Line Tools and Node.js 22+ with this repository's dependencies installed (`npm install`).

```bash
npm run launcher:build     # builds into dist/launcher-builds/<build-id>/
npm run launcher:install   # copies the app to ~/Desktop/Agent Collab Hub.app
```

Install refuses to replace an existing app: move the old one to the Trash first. The app is ad-hoc signed for this Mac, not notarized. The icon is drawn from `desktop/icon.svg` by `DrawIcon.swift`.

## First run

1. Open the app and go to **Settings**. Set the checkout folder and the absolute paths of `node`, `npm` and (optionally) `ngrok`, plus your name (it names your staff identity in new workspaces). **Save & Validate**.
2. **Launch** starts the hub on `http://127.0.0.1:8791`, building it if needed. It adopts a healthy hub that is already running from this checkout.
3. **Open Studio** opens the web app. **Start Tunnel** / **Stop Tunnel** control the optional ngrok tunnel and ask for confirmation first. **Stop** stops the tunnel and the hub.

Closing the window leaves the hub running. Stopping never deletes room files, history or containers.

## Workspaces

**New workspace** creates a workspace and shows your staff token for it once. A workspace is a security boundary: people, rooms, messages, sandboxes and GitHub tokens never cross into another workspace. Each workspace has four tabs:

- **People.** **Add staff** (full access, or observer for read-only) and give them their token. For clients: **Sign-in link** (one-time, 15 minutes), **Sign out everywhere…** and **Remove access…**. Staff tokens can be reissued (**New token**) or revoked.
- **Rooms.** **New room**, **Invite client…** (a one-time link valid for 7 days) and **Archive…**.
- **Links.** Every invite link and its state.
- **GitHub.** **Add token** saves one GitHub token per organization or account. Paste a fine-grained token whose resource owner is that organization, with Contents: read to clone, plus Contents and Pull requests: read and write to open pull requests. Clones and pull requests in this workspace's rooms use the token for the repository's owner. Tokens are stored in `data/github-tokens.json` (mode 600), are never shown again, and are deleted with the workspace. **Replace…** and **Remove…** manage them.

Also on the workspace: **Rename…** and **Delete…** (type the name to confirm; a backup is taken first).

Tokens appear once in a reveal sheet with a **Copy** button; copied tokens are cleared from the clipboard after 60 seconds if it hasn't changed. Only hashes are stored.

## Upgrades and starting over

When the hub's data comes from an older version, **Upgrade (keep data)…** stops the hub, takes a private backup and migrates it. **Start fresh…** moves all current data and room files into a dated backup folder and starts an empty hub; everyone's access ends.

## Storage and troubleshooting

- Preferences: `~/Library/Application Support/Agent Collab Hub/launcher.json` (mode 600, no secrets).
- **Docker not running:** the hub starts, but sandboxes, previews and sidekicks need Docker Desktop and the images from the main README.
- **Port busy or a process the app didn't start:** nothing is killed; check what owns the port.
- **After pulling updates:** rebuild and reinstall the app; don't edit the installed bundle. `codesign --verify --strict "$HOME/Desktop/Agent Collab Hub.app"` checks it.

## Development checks

```bash
npm run test:launcher
node --test infra/scripts/operations.test.mjs
npm run launcher:build
```
