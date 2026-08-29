# OpenChamber Desktop

Electron desktop runtime for OpenChamber on macOS, Windows, and Linux.

This package owns the native shell: windows, menus, deep links, native notifications, auto-updates, host switching, SSH connections, tunnel helpers, and packaged desktop builds. The web UI and OpenChamber server logic still live in `packages/web` and shared React UI lives in `packages/ui`.

## How It Runs

Desktop starts the OpenChamber web server in the same Electron main process. There is no separate sidecar subprocess for the OpenChamber server.

`main.mjs` imports `@openchambery/web/server/index.js` and calls `startWebUiServer()`. The Electron window then loads the UI from the local server in development, or from packaged `resources/web-dist` assets in packaged builds.

The preload bridge exposes desktop-only APIs to the web UI through `window.__OPENCHAMBER_DESKTOP__`. Privileged commands are checked in `main.mjs`, not only in the UI. The binary-path probe samples at most 8 KiB before a non-image binary file opens through the system handler.

## Shutdown Lifecycle

Electron owns the in-process server handle. Normal quit, relaunch, vibrancy relaunch, update installation, and `SIGINT`/`SIGTERM`/`SIGHUP` share one shutdown promise and await `serverHandle.stop({ exitProcess: false, forceCloseConnections: true })` before Electron exits, relaunches, or applies an update. Desktop teardown closes remaining local HTTP connections after initiating server close, avoiding the 10-second shutdown wait. This closes the message queue service and SQLite resources; SSH sessions also stop during the same teardown. A failed graceful stop launches the existing detached managed-OpenCode killer using process information captured before `stop()`. On macOS, a second `Cmd+Q` while the quit-risk confirmation is open confirms the quit and follows the same shutdown path as the dialog's Quit button.

## Main Files

| File | Purpose |
|------|---------|
| `main.mjs` | Electron main process, app lifecycle, windows, menus, deep links, native IPC handlers, updates, local server startup |
| `preload.mjs` | Safe bridge from the rendered UI to Electron IPC |
| `virtual-asset-protocol.mjs` | Opaque virtual image asset registry + `openchamber-asset` streaming protocol helpers |
| `settings-store.mjs` | Process-local serialized `settings.json` read-modify-write shared by main, ssh-manager, and the in-process web settings runtime |
| `sync-run-store.mjs` | Append-only OpenCode config sync run records under `<dataDir>/sync-runs/` (not written into `settings.json`) |
| `direct-config-sync.mjs` | Direct OpenChamber host sync over HTTP `/api/openchamber/config-sync/*` (`host:<id>` targets) |
| `ssh-manager.mjs` | SSH host import, connection lifecycle, tunnel/port forwarding helpers; managed OpenCode config sync via shared `@openchambery/web/server/lib/config-sync` (plan/executor/generational backup) with per-target mutex and run records |

Relay config sync runs in the renderer (`packages/ui/src/lib/relay/relay-config-sync.ts`) because the E2EE tunnel client is UI-owned. Main process helpers pack/extract local tars (`desktop_relay_sync_pack_local` / `desktop_relay_sync_apply_local`) and append `relay:<serverId>` run records. Identity is pinned to `serverId`; a changed fingerprint fails with `relay_identity_changed`.
| `scripts/electron-dev.mjs` | Desktop dev launcher with Vite HMR support |
| `scripts/build-web-assets.mjs` | Builds `packages/web` and stages UI assets into `resources/web-dist` |
| `scripts/prepare-opencode-cli.mjs` | Downloads and stages the pinned OpenCode CLI into `resources/opencode-cli` |
| `scripts/bundle-main.mjs` | Bundles Electron main code into `dist-bundle/main.mjs` for packaging |
| `scripts/rebuild-native.mjs` | Rebuilds native modules against the Electron runtime |
| `scripts/package.mjs` | Runs `electron-builder`, with unsigned Windows builds when signing env is missing |
| `resources/` | Packaged web assets, icons, and macOS entitlements |

## Development

From the repo root:

```bash
bun install
bun run electron:dev
```

`bun run electron:dev` starts the web dev server with HMR, then launches Electron against `packages/electron/main.mjs`.

Useful variants:

```bash
bun run electron:dev:bundled
bun run type-check:electron
bun run lint:electron
```

`electron:dev:bundled` builds and uses packaged web assets instead of the HMR server. Use it when testing behavior closer to a packaged app.

## Packaging

From the repo root:

```bash
bun run electron:build
```

That runs, in order:

1. `build:web-assets` to build the web UI and copy it into `packages/electron/resources/web-dist`.
2. `prepare:opencode-cli` to download/cache the pinned OpenCode CLI and copy it into `packages/electron/resources/opencode-cli`.
3. `bundle:main` to create `packages/electron/dist-bundle/main.mjs`.
4. `rebuild:native` to rebuild native modules for Electron.
5. `package.mjs` to run `electron-builder`.

Build output goes to `packages/electron/dist`.

macOS builds produce `dmg` and `zip` artifacts. Windows builds produce an NSIS installer. Linux builds produce an AppImage for the native x64 or arm64 host.

### Desktop profiles (release vs preview)

Packaging is profile-driven via `OPENCHAMBER_DESKTOP_PROFILE`. The default is **`release`**, which is what CI and `bun run electron:build` use. Nothing about preview is hardcoded into the production identity.

| Profile | How to build | Output | Identity |
|---|---|---|---|
| `release` (default) | `bun run electron:build` | `packages/electron/dist/` | `OpenChamber` / `dev.openchamber.desktop` |
| `preview` | `bun run electron:build:preview` | `packages/electron/dist-preview/` | `OpenChamber Preview` / `dev.openchamber.desktop.preview` |

#### Local builds should use Preview

When packaging Desktop **on a developer machine** (feature QA, assistant work, side-by-side with a store/installed app), use:

```bash
bun run electron:build:preview
```

Do **not** use plain `bun run electron:build` for routine local installs: that produces a release-identity app that collides with the production install (same `appId` / product name / single-instance lock) and can overwrite the same dock identity.

CI / GitHub Release workflows keep using the default release profile (`electron:build` / `electron-builder` without `OPENCHAMBER_DESKTOP_PROFILE`).

Preview builds:

- Use a **PREVIEW-badged dock/app icon** (`resources/icons/preview-icon.*`).
- Keep a **separate userData / single-instance lock**, so they can run next to the installed release app.
- Point **OpenChamber server data** at a profile-local directory (see isolation table below).
- Are safe to merge to main: release CI does not set the env var, so it still packages the normal product.

#### Runtime isolation (Preview vs installed release)

| Concern | Isolated in Preview? | Location |
|---|---|---|
| Electron app identity / dock icon | Yes | product name + PREVIEW icon + `dev.openchamber.desktop.preview` |
| Single-instance lock | Yes | separate `userData` |
| OpenChamber server data (`settings.json`, `assistants.sqlite`, relay host claim, managed OpenCode bookkeeping, etc.) | Yes | `$userData/openchamber-data` via `OPENCHAMBER_DATA_DIR` |
| Session index / message-queue SQLite | Yes | under Electron `userData` |
| Desktop local HTTP port | Effectively yes | stored in profile settings; binds a free port if the preferred one is taken |
| Managed OpenCode **process** | Yes (separate process + port) | spawned by that Desktop instance |
| **OpenCode session DB** (`opencode.db`) | **No** (shared with release / CLI) | default `~/.local/share/opencode` (or existing `XDG_DATA_HOME`) |
| OpenCode config / provider auth | **No** (shared with release / CLI) | default `~/.config/opencode` and auth under the shared data home |

Preview isolates **OpenChamber** app state so it can run beside the installed release app, but it reuses the machine’s normal OpenCode global config and session store. That means Preview and release/CLI see the same sessions, models, and auth. Avoid writing the same session from both apps at once if you run them together.

**Dev** (`electron:dev`) still isolates XDG under its own `userData` so HMR work does not write into the production OpenCode DB; it seeds auth/config once from the shared tree.

Regenerate preview icons after changing the production mark:

```bash
bun run --cwd packages/electron generate:preview-icons
```

Requires Pillow (`python3` + `PIL`) and, on macOS, `sips` + `iconutil`.

macOS packaged Dock icons prefer `resources/icons/Assets.car` (`CFBundleIconName=AppIcon`) over `icon.icns`. The Icon Composer source `resources/icons/AppIcon.icon` is forced to the dark mark for light, dark, and tinted appearances. After editing it, regenerate the catalog:

```bash
bun run --cwd packages/electron generate:macos-icon
```

## Platform Notes

macOS packaging needs Xcode/build tools, a Developer ID Application certificate, and App Store Connect API credentials. Release workflows sign and notarize the DMG; local preview builds use the same signing configuration.

Windows packaging needs NSIS support through `electron-builder`. If no Windows signing env is set, `package.mjs` disables code signing and builds an unsigned installer.

Linux AppImages must be built natively. Set `OPENCHAMBER_TARGET_ARCH=x64` or `OPENCHAMBER_TARGET_ARCH=arm64` when packaging; the build rejects a target that does not match the Linux host. The same target selects the bundled OpenCode CLI, native Electron rebuild, and Electron Builder architecture. Linux identity is stable across architectures: executable `openchamber`, desktop file `openchamber.desktop`, icon `openchamber`, and `StartupWMClass=openchamber`.

After packaging, run `bun run --cwd packages/electron verify:linux-appimage`. The verifier extracts the final AppImage and checks its ELF architecture, desktop identity, Electron executable, pinned OpenCode CLI version and architecture, and all packaged native `.node` modules.

Running a packaged Linux AppImage requires FUSE (`libfuse.so.2`, typically `libfuse2` / `libfuse2t64` on Debian/Ubuntu). Without FUSE, start with `APPIMAGE_EXTRACT_AND_RUN=1`. Keep the AppImage on a writable path so in-app updates can replace it.

Linux updates are supported only when the packaged app is running from a writable AppImage. Update checks, downloads, and installation report an actionable error when `APPIMAGE` is missing, invalid, or read-only; a missing release feed (`latest-linux.yml` 404 before the first Linux publish) is treated as “no update available”. macOS and Windows updater behavior is unchanged. Release builds keep `latest-linux.yml` (x64) and `latest-linux-arm64.yml` separate and validate each manifest against its AppImage before upload. Linux AppImages download full updates (no `.blockmap` differential channel yet).

### Updater End-to-End Fixture

A loopback-only updater fixture is available for contributor QA of N-to-N+1 AppImage replacement and restart behavior. It is test infrastructure, not a user-configurable update source. See [`scripts/updater-e2e-fixture.md`](./scripts/updater-e2e-fixture.md) for the controlled test procedure. Unit tests cover feed selection, check failures, no-update results, and fixture generation; actual AppImage replacement and restart remains a manual native N-to-N+1 release boundary because it requires executing two packaged versions on each supported architecture.

The package supports macOS, Windows, and Linux desktop features. Linux AppImage builds include in-app window controls and auto-update; system tray and launch-at-login remain macOS/Windows only. Some native discovery helpers are platform-specific. For example, app icon fetching and app filtering currently only work on macOS, while opening files in installed apps and installed-app discovery work on macOS and Windows (Linux returns an empty list without errors).

## Bundled OpenCode CLI

Packaged Desktop builds include the official OpenCode CLI that matches the pinned `@opencode-ai/sdk` version in the root `package.json`. `prepare:opencode-cli` downloads the platform-specific release artifact, caches it under `packages/electron/.cache/opencode-cli`, stages `opencode` or `opencode.exe` into `resources/opencode-cli`, and verifies `opencode --version` before packaging. Re-running the step is fast when the staged binary already matches the pinned version.

## Releases and automatic updates

Packaged desktop apps check updates through `openchamber-update.vercel.app` using Electron updater metadata proxied through `/desktop/`. Signed installers, macOS ZIP updates, and AppImages remain GitHub Release assets. Each cold startup checks once, then repeats hourly while the app is visible; users can also check from the app menu, sidebar, or Settings. After an update is found, Electron may download the package silently while the OS is idle/locked; the dialog progress bar appears only when the user clicks Download (joining any in-flight idle download). Electron applies a downloaded desktop update independently of the active OpenChamber host connection.

The `Release` GitHub Actions workflow runs for `v*` tags or by manual dispatch. Before starting a release:

1. Run `bun run version:bump -- <version>` and update the matching `CHANGELOG.md` section.
2. Set `CSC_LINK`, `CSC_KEY_PASSWORD`, `APP_STORE_CONNECT_PRIVATE_KEY_BASE64`, `APP_STORE_CONNECT_KEY_ID`, and `APP_STORE_CONNECT_ISSUER_ID` for signed and notarized macOS desktop builds.
3. Configure `NPM_TOKEN` so the release workflow can publish `@openchambery/web` and `@openchambery/relay-server` to npm. iOS signing secrets are required for the TestFlight upload that runs with the formal release workflow.
4. For a desktop-only release, manually dispatch the workflow with scope `desktop` (the default). Pushing tag `v<version>` retains the full-release behavior.

The workflow creates the GitHub Release and uploads the desktop artifacts. macOS, Windows, and writable Linux AppImage installs use in-app automatic updates. Formal releases also upload Android artifacts and send iOS builds to TestFlight. A dry run keeps the Release as a draft. The version validation step fails early if the requested version differs from the root or Electron package version.

Managed local Desktop startup prefers OpenCode binaries in this order:

1. Explicit overrides: `settings.opencodeBinary`, `OPENCODE_BINARY`, `OPENCODE_PATH`, `OPENCHAMBER_OPENCODE_PATH`, or `OPENCHAMBER_OPENCODE_BIN`.
2. The bundled Desktop CLI in `process.resourcesPath/opencode-cli`.
3. System installs discovered from PATH and known npm/Bun/Scoop/Chocolatey locations.

Use an explicit override when testing a different OpenCode CLI build or when a user needs to point Desktop at a custom binary. The configured path must point to the standalone CLI, not the OpenCode Desktop app executable.

## Common Env Vars

| Variable | Use |
|----------|-----|
| `OPENCHAMBER_ELECTRON_DEV=1` | Marks the runtime as desktop development mode |
| `OPENCHAMBER_ELECTRON_USE_BUNDLED_UI=1` | Uses staged web assets instead of the HMR dev server |
| `OPENCHAMBER_HMR_UI_PORT` | Preferred Vite UI port for desktop dev, default `5173` |
| `OPENCHAMBER_HMR_API_PORT` | Preferred API port for desktop dev, default `3901` |
| `OPENCHAMBER_RUNTIME=desktop` | Set by Electron before starting the web server |
| `OPENCHAMBER_OPENCODE_CLI_VERSION` | Optional packaging override for the bundled OpenCode CLI version; defaults to the pinned root `@opencode-ai/sdk` version |
| `OPENCHAMBER_TARGET_ARCH` | Explicit desktop package architecture (`x64` or `arm64`); Linux requires it to match the native host |
| `OPENCHAMBER_DESKTOP_PROFILE` | Packaging profile: unset/`release` (CI default) or `preview` (local side-by-side QA build; distinct identity, PREVIEW icon, isolated OpenChamber data dir). Prefer `bun run electron:build:preview` for local Desktop packages. |
| `OPENCHAMBER_DATA_DIR` | OpenChamber server data root. Preview/dev set this under Electron `userData` when unset so they do not share `~/.config/openchamber` with the release app. |
| `OPENCHAMBER_DESKTOP_NOTIFY=true` | Enables desktop notification flow in the web server |
| `OPENCHAMBER_SKIP_API_COMPRESSION=true` | Defaulted by Desktop to reduce local CPU overhead |
| `OPENCODE_HOST` / `OPENCODE_PORT` / `OPENCODE_SKIP_START` | Connect Desktop to an external OpenCode server instead of starting one locally |

## Native Features Owned Here

- Floating Mini Chat windows.
- Multiple native windows.
- Native notifications.
- One-click open/reveal/open-in-app actions.
- Desktop host switcher and deep-link imports.
- Local and remote instance handling.
- SSH host import, connections, logs, and port forwarding. Managed SSH remotes default to `relayHost: true`: they start with a UI password (configured or a one-time in-memory secret) and `--relay-host` so the remote hosts its own private relay. A leftover `web` serve on the preferred port is restarted as `ssh-remote`. After connect, desktop persists the remote's public relay descriptor next to the local-forward `apiUrl` so this machine can fall back to relay when the SSH tunnel is down; pairing a phone or another desktop still uses the remote's ordinary Add Device flow. Each managed command scopes its own PATH, discovers a Node.js 22+ runtime from common remote locations (preferring even LTS majors 22/24 and a sibling `npm` over odd majors such as 23), installs missing OpenChamber or OpenCode CLIs with the selected package manager, and repairs the OpenChamber `better-sqlite3` binding when the selected Node ABI requires it (probe first, then clean `node_gyp_bins`, rebuild, retry, and npm reinstall). Bootstrap failures emit a classified `errorCode` plus a short `detail`; the full remote log stays in SSH logs so the desktop client can show user-actionable guidance. This bootstrap never edits remote shell startup files. Managed SSH remotes can mirror the local `~/.config/opencode` allowlist (config json/jsonc winner + agents/commands/skills/plugins dirs, symlinks dereferenced), the `~/.agents` agent skills root, and provider `~/.local/share/opencode/auth.json` (that file only — never session DBs under the same share dir) to the remote after connect, with remote-side backups under `.openchamber.sync-backup` / `.openchamber.sync-backup-agents` / `.openchamber.sync-backup-auth` and stale counterpart deletion. Preview/apply sync for a given `ssh:<instanceId>` target is process-local exclusive (`sync_in_progress` when already running); each run gets a `syncRunId` and an append-only record under `<OPENCHAMBER_DATA_DIR>/sync-runs/` (newest 20 kept per target, never stored in `settings.json`; records include plan `direction`; readable via `desktop_ssh_sync_runs_list`). Sync planning, selections, POSIX prepare/probe/inventory/finalize scripts, and apply orchestration live in `packages/web/server/lib/config-sync/`. **Push** uses an SSH `TargetExecutor`; **pull** inventories the remote, downloads tar streams over ControlMaster, and applies generational backups locally. Direction changes re-run preview IPC (no cached plan flip). Whitelist selections (`fileGroups` / `singleFiles` / `directories` / `agentsRoot` / `authFile`) are shared by preview and apply. Prepare keeps generational backups under `<backupRoot>/<syncRunId>/` (retention 5). `auth.json` is synced like other allowlist items when the user selects it (`authFile`); it stays unchecked by default. Desktop `settings.json` writes from main, ssh-manager, and the in-process web server share one mutation chain via `settings-store.mjs` / `startWebUiServer({ settingsPersistLock })`.
- Auto-update checks, downloads, and restart/apply flow.

## IPC Pattern

Renderer code should call the desktop bridge exposed by `preload.mjs`. Do not import Electron from shared UI code.

Add new native capabilities in this order:

1. Add or update the `preload.mjs` bridge only if a new renderer-facing shape is needed.
2. Add the real command handling in `main.mjs` under `openchamber:invoke`.
3. Gate privileged commands in main process logic so remote pages cannot access local filesystem or shell capabilities.
4. Keep shared UI runtime contracts in `packages/ui` and server/runtime APIs in `packages/web` when the behavior is not inherently native.

## Virtual Image Asset Protocol

Relay/host-backed images need a browser-consumable URL that Chromium can load as `<img src>` / CSS without giving main-process code tunnel credentials or host filesystem paths. Desktop uses a dedicated secure custom scheme and a local-only push bridge:

| Piece | Role |
|-------|------|
| Scheme | `openchamber-asset` (privileged: `standard`, `secure`, `supportFetchAPI`, `corsEnabled`, **`stream`**) |
| URL form | `openchamber-asset://stream/<assetId>` — opaque id in the path only; no userinfo, query, fragment, or host paths |
| Registry | `virtual-asset-protocol.mjs` maps `assetId` → `protocol.handle` `ReadableStream` |
| Static UI | Unchanged: packaged pages stay on `openchamber-ui://` |

### Renderer bridge (local page only)

Exposed only when the page is the packaged UI (`openchamber-ui://app`) or the exact local loopback origin. Remote host pages do **not** get `virtualAsset`. Main re-checks `isLocalSender` on every channel.

```ts
// window.__OPENCHAMBER_DESKTOP__.virtualAsset

type VirtualAssetCreateResult = {
  assetId: string;
  url: string;       // openchamber-asset://stream/<assetId>
  mimeType: string;  // normalized image/* 
};

virtualAsset.create({ mimeType: string }): Promise<VirtualAssetCreateResult>
virtualAsset.push(assetId: string, chunk: ArrayBuffer | Uint8Array): Promise<{
  ok: true;
  queuedBytes: number;
  totalBytes: number;
}>
virtualAsset.finish(assetId: string): Promise<{ ok: true }>
virtualAsset.cancel(assetId: string): Promise<{ ok: true }>
```

IPC channels (not via `openchamber:invoke`):

- `openchamber:asset:create` — `{ mimeType }`
- `openchamber:asset:push` — `{ assetId, chunk }`
- `openchamber:asset:finish` / `openchamber:asset:cancel` — `{ assetId }`

### Lifecycle and limits

1. Local UI creates an asset with an image MIME (`image/png`, `image/jpeg`, …).
2. UI pulls bytes from the relay tunnel (or any renderer-owned source) and `push`es bounded chunks.
3. UI or layout assigns `url` to an image element; Chromium requests the scheme; main returns a streaming `Response`.
4. UI calls `finish` when the body is complete, or `cancel` on error/unmount. Protocol abort / stream cancel also destroy the asset.

Default bounds (see `DEFAULT_VIRTUAL_ASSET_LIMITS`): max concurrent assets, max queued bytes (backpressure), max chunk size, max total bytes, and TTL for idle assets. One consumer per `assetId` (second request → 409). `push` never buffers past `maxQueuedBytes`; when the queue is full it waits for the protocol consumer to drain (or for cancel / finish / dispose / TTL). A missing consumer therefore cannot hang the renderer pump forever or grow memory without bound.

Security invariants:

- Main never sees host paths, bearer tokens, or relay keys — only opaque ids + binary chunks + image MIME.
- Remote renderer pages cannot create or feed assets.
- Does not share the `openchamber-ui` protocol handler.

## Logs And Data

Electron uses `electron-log`. In development, console logs are also visible in the terminal. Packaged apps route `console.warn` and `console.error`, plus explicit `electron-log` events, through the platform log path for the `OpenChamber` app name; ordinary `console.debug`, `console.info`, and `console.log` calls are no-ops.

Development builds use a separate user data directory named `OpenChamber Dev`, so dev state does not overwrite normal packaged app state.

## Things To Be Careful With

- Keep desktop-specific code in this package. Do not move OpenCode feature backend logic into Electron.
- Use hidden Windows process launches for background helpers. Avoid visible console flashes.
- Keep `@openchambery/web`, `bun-pty`, `node-pty`, and native modules external in `bundle-main.mjs`; bundling them can break Electron startup.
- Rebuild native modules after dependency or Electron version changes.
- Test both HMR dev mode and bundled UI mode when changing startup, preload, routing, or packaged asset behavior.

## Quick Checks

```bash
bun run type-check:electron
bun run lint:electron
bun run electron:dev:bundled
```

For full repo validation before shipping:

```bash
bun run type-check
bun run lint
```
