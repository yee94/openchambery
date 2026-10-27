# Yuri Desktop

Electron desktop runtime for Yuri on macOS, Windows, and Linux.

This package owns the native shell: windows, menus, deep links, native notifications, auto-updates, host switching, SSH connections, tunnel helpers, and packaged desktop builds. The web UI and Yuri server logic still live in `packages/web` and shared React UI lives in `packages/ui`.

## How It Runs

Desktop starts the Yuri web server in the same Electron main process. There is no separate sidecar subprocess for the Yuri server.

`main.mjs` uses `desktop-backend.mjs` to load the selected OTA backend or the installed `@yuriai/web/server/index.js`, then calls `startWebUiServer()`. The Electron window loads the UI from the local server in development, or from the selected OTA/builtin assets in packaged builds.

Opaque main/Mini Chat windows and the dark native title-bar overlay use Cursor's
`#1a1a1a` backdrop, matching the shared UI's default dark surface. Vibrancy keeps
its transparent native backdrop; saved renderer theme choices remain authoritative.

The preload bridge exposes desktop-only APIs to the web UI through `window.__YURI_DESKTOP__`. Privileged commands are checked in `main.mjs`, not only in the UI. The binary-path probe samples at most 8 KiB before a non-image binary file opens through the system handler.

Startup uses the transparent `icons/source/yuri-mark-black.svg` silhouette, matching the web startup SVG at 120 × 120 CSS pixels centered in the viewport. The web progress indicator is positioned below the logo without participating in centering, so showing progress does not move the mark. Keep the native and web splash geometry and default theme colors aligned.

Packaged UI and local backend resources may be replaced by a verified desktop OTA directory under `userData/ota`. `desktop-ota.mjs` owns download, channel selection, atomic staging and next-launch activation. New backend-bearing bundles are activated without an automatic rollback: invalid active resources fail startup and require reinstall. Packaged pages use `yuri-ui://app`; the startup migration below imports the previous origin before the UI loads. Main, preload and dependencies remain installer-owned. `desktop-backend.mjs` loads the selected backend in-process and resolves its dependencies from the installed web package using synchronous Node module hooks; file grants use that same backend module instance. Config-sync modules shared with the shell and local dictation workers remain installer-owned and fingerprinted. `packages/web/server/lib/zip-assets.js` owns the bounded archive codec using the existing web-package ZIP dependency. The first migration requires a new installer with this backend loader; subsequent compatible UI/backend releases can use OTA.

Desktop instance switches revalidate the target's authentication before committing the runtime endpoint. Direct probes verify service compatibility and `/auth/session` with the saved client credential; Relay probes verify `/auth/session` over the pinned E2EE tunnel and hand that authenticated tunnel to the runtime. Cached connected badges remain display snapshots. A direct authentication failure triggers Relay fallback when available; failed authentication on every candidate preserves the current instance and reports authentication required.

Saved SSH targets must complete the SSH manager's full connect/bootstrap pipeline before an instance switch or a new window (default host, saved host ID, or saved URL) proceeds, even when their badge is Ready or a Relay leg is available. Managed bootstrap includes installation/version alignment and runtime checks; external SSH mode retains its probe-only policy. Main owns this preparation gate and returns the newly persisted endpoint and credentials. Preparation failure blocks navigation/window creation, concurrent connects share one attempt, and remote pages cannot trigger SSH preparation through window commands. The `desktop_host_prepare` IPC requires an updated installer; UI OTA alone cannot supply it.

For Relay-paired hosts, direct probes must first obtain an exact `/health.serverId` match without sending credentials. Missing identity, malformed JSON, redirects, failed health requests and mismatched computers cannot qualify as a usable direct transport; startup restore and background candidate refresh retain Relay instead. Explicit direct-only hosts keep their compatibility/authentication probe. This gate is installer-owned Electron main code, so a UI/backend OTA alone cannot update it.

Renderer local-instance checks use the active Host/Relay identity before URL comparisons. A Relay virtual loopback origin never qualifies as the local machine. Remote windows do not inherit unscoped local storage through immutable preload URLs, and their transcript cache uses IndexedDB rather than the local-only HTTP/SQLite backend. Yuri filesystem and session-wrapper requests resolve route paths through the current runtime, alongside SDK calls, rather than retaining the startup HTTP origin.

## Leased image disk cache

`image-disk-cache.mjs` owns the optional `imageCache` preload capability. Shared UI authorizes the file and requests its SHA-256 through the active runtime's stat API, then keys bytes by stable runtime/credential scope and content fingerprint (no session/path partition). Downloaded content is hash-verified before commit; only an opaque key and bounded chunks cross IPC. Old Hosts retain the previous path/size/mtime compatibility key. Completed files live in `userData/image-cache-v1`, not IndexedDB. The existing `yuri-asset://cache/<opaque-id>` handler supports repeated/concurrent reads, while the older `stream` host remains a one-use progressive stream. The local-sender-gated `image-cache:clear` IPC purges cached bodies and leases on credential invalidation/logout; normal endpoint switches keep durable bytes. That clear capability requires the updated installer.

Cache limits are 256 MiB / 128 entries, 32 MiB per image and 512 KiB per IPC write. Reservations include incomplete uploads. Native leases are owner-window checked; UI unmount releases the lease but retains the completed file. LRU evicts only entries with neither leases nor active protocol readers, and capacity exhaustion fails rather than deleting pinned resources. Window navigation/destruction releases its leases and deletes partial uploads. Complete entries survive restart; startup removes incomplete/orphan files and validates metadata. A failed stat or a file changed during transfer never commits a reusable entry. Native cache capability changes require an installer. Without disk caching, the shared image owner persists verified bodies to IndexedDB and materializes independent native streams or browser Blob URLs for both inline and preview consumers. HTTP/data/blob sources already supplied by callers remain direct.

`scripts/image-cache-evidence.test.mjs` builds the production shared image Hook and runs it in real Electron with the native protocol/IPC/disk implementation. It compares one-use native streaming with cached loads for four 5 MiB PNGs, simultaneous previews and ten remounts, counting downloads/bytes and measuring decode-ready latency. Set `YURI_TEST_EVIDENCE_DIR` to retain `result.json`. This is a controlled-network image lifecycle benchmark, not whole-transcript navigation or phone performance evidence.

## Shutdown Lifecycle

When the shared OTA decision requires a new shell, `desktop-installer.mjs` uses `electron-updater` to download the complete installer in-app and calls `quitAndInstall` after the normal server shutdown. The generic feed is pinned to that exact GitHub release's `full*.yml`, never to a mutable latest feed. Beta eligibility and explicit stable downgrade permission come from the shared decision. Downloads do not install automatically on ordinary quit, and changing the selected update invalidates the install action.

OTA recovery is manual: clear `userData/ota` or install a newer shell version. Reinstalling the same shell version alone preserves the OTA selection and does not clear a failed bundle.

The default local OpenCode connection uses the official shared background service. Desktop shutdown stops the Yuri host, watchers and connections but leaves that OpenCode service running, so the next launch and official Desktop/TUI clients can reuse it. Shared startup failure is surfaced for retry without a private-process fallback. Automatic macOS/Linux CLI discovery follows the interactive login-shell PATH unless explicitly overridden. In-app upgrades run the selected global CLI's own `upgrade` command and restart the service through that same entry path; owned-cache installations continue using the cache installer. The managed-child shutdown behavior below applies only to explicitly selected private runtimes.

Electron owns the in-process server handle. Normal quit, relaunch, vibrancy relaunch, update installation, and `SIGINT`/`SIGTERM`/`SIGHUP` share one shutdown promise and await `serverHandle.stop({ exitProcess: false, forceCloseConnections: true })` before Electron exits, relaunches, or applies an update. Desktop teardown stops accepting connections, runs `closeAllConnections`, then destroys remaining **server-owned** sockets (including upgraded WS/SSE that Node leaves open) so the HTTP `close` callback fires without the 10-second `SHUTDOWN_TIMEOUT` stall. Managed OpenCode stop is owned entirely by the in-process child handle `close()` (SIGTERM then SIGKILL on that handle). There is no post-stop detached killer of a pre-captured numeric pid; orphan recovery stays with the managed-process reaper. Port release is probed and reported only — never mass-killed by listener. This closes the message queue service and SQLite resources; SSH sessions also stop during the same teardown. On macOS, a second `Cmd+Q` while the quit-risk confirmation is open confirms the quit and follows the same shutdown path as the dialog's Quit button.

## Deep-link compatibility

New links use `yuri://`. Packaged OS registration and runtime handlers also accept `openchamber://` and `openchambery://` as receive-only aliases, including cold-start arguments, second-instance arguments and macOS `open-url`. They share the same route handling and pairing-v2 validation; payloads are not rewritten, expired pairing secrets stay invalid, and retired v1 credential links remain rejected. An updated installer is required to register schemes; UI OTA alone cannot do this. When old and new applications coexist, the OS/default-app selection determines the recipient of a legacy scheme.

## Main Files

| File | Purpose |
|------|---------|
| `main.mjs` | Electron main process, app lifecycle, windows, menus, deep links, native IPC handlers, updates, local server startup |
| `preload.mjs` | Safe bridge from the rendered UI to Electron IPC |
| `virtual-asset-protocol.mjs` | Opaque virtual image asset registry + `yuri-asset` streaming protocol helpers |
| `preview-loopback-gateway.mjs` | Relay Preview loopback HTTP gateway (`127.0.0.1` + ephemeral port) — dumb byte pipe to the owner renderer |
| `settings-store.mjs` | Process-local serialized `settings.json` read-modify-write shared by main, ssh-manager, and the in-process web settings runtime |
| `sync-run-store.mjs` | Append-only OpenCode config sync run records under `<dataDir>/sync-runs/` (not written into `settings.json`) |
| `direct-config-sync.mjs` | Direct Yuri host sync over HTTP `/api/yuri/config-sync/*` (`host:<id>` targets) |
| Magpie config sync | Source discovery and native CLI provisioning/backup/restore are host-owned in `packages/web/server/lib/config-sync/magpie.js`; main/SSH/direct/Relay transfer the selected opaque payload. Missing target CLIs install on apply, never during preview. See the config-sync module documentation for discovery, native backup scope and partial-failure behavior. |
| `ssh-manager.mjs` | SSH host import, connection lifecycle, tunnel/port forwarding helpers; managed OpenCode config sync via shared `@yuriai/web/server/lib/config-sync` (plan/executor/generational backup) with per-target mutex and run records |

Relay config sync runs in the renderer (`packages/ui/src/lib/relay/relay-config-sync.ts`) because the E2EE tunnel client is UI-owned. Main process helpers pack/extract local tars (`desktop_relay_sync_pack_local` / `desktop_relay_sync_apply_local`) and append `relay:<serverId>` run records. `credentialPayload` carries versioned V2 credential bytes; `providerCredentials` carries metadata. Only the current credential API protocol is supported. Local credential operations use authenticated local-host HTTP so OTA backends resolve their own OpenCode service client. Identity is pinned to `serverId`; a changed fingerprint fails with `relay_identity_changed`.
| `scripts/electron-dev.mjs` | Desktop dev launcher with Vite HMR support |
| `scripts/build-web-assets.mjs` | Builds `packages/web` and stages UI assets into `resources/web-dist` |
| `scripts/prepare-opencode-cli.mjs` | Downloads the pinned OpenCode CLI from npm platform packages (`@opencode/cli-<os>-<arch>`) and stages it into `resources/opencode-cli` |
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
2. `prepare:opencode-cli` to download/cache the pinned OpenCode CLI from npm platform packages and copy it into `packages/electron/resources/opencode-cli`.
3. `bundle:main` to create `packages/electron/dist-bundle/main.mjs`.
4. `rebuild:native` to rebuild native modules for Electron.
5. `package.mjs` to run `electron-builder`.

Build output goes to `packages/electron/dist`.

Release CI injects `YURI_UPDATE_ORIGIN` from the verified `YURI_OTA_MIRROR_URL` repository variable before `bundle:main`. This origin is baked into the native main process; changing the hosted service alone cannot repair installers built with an empty origin. Release preflight validates both the Vercel authority and EdgeOne mirror before packaging. See `docs/RELEASING.md` for the shared endpoint variables.

macOS builds produce `dmg` and `zip` artifacts. Windows builds produce an NSIS installer. Linux builds produce an AppImage for the native x64 or arm64 host.

### Desktop profiles (release vs preview)

Packaging is profile-driven via `YURI_DESKTOP_PROFILE`. The default is **`release`**, which is what CI and `bun run electron:build` use. Nothing about preview is hardcoded into the production identity.

| Profile | How to build | Output | Identity |
|---|---|---|---|
| `release` (default) | `bun run electron:build` | `packages/electron/dist/` | `Yuri` / `dev.yuri.desktop` |
| `preview` | `bun run electron:build:preview` | `packages/electron/dist-preview/` | `Yuri Preview` / `dev.yuri.desktop.preview` |

#### Local builds should use Preview

When packaging Desktop **on a developer machine** (feature QA, assistant work, side-by-side with a store/installed app), use:

```bash
bun run electron:build:preview
```

Do **not** use plain `bun run electron:build` for routine local installs: that produces a release-identity app that collides with the production install (same `appId` / product name / single-instance lock) and can overwrite the same dock identity.

CI / GitHub Release workflows keep using the default release profile (`electron:build` / `electron-builder` without `YURI_DESKTOP_PROFILE`).

Preview builds:

- Use a **PREVIEW-badged dock/app icon** (`resources/icons/preview-icon.*`).
- Keep a **separate userData / single-instance lock**, so they can run next to the installed release app.
- Point **Yuri server data** at a profile-local directory (see isolation table below).
- Are safe to merge to main: release CI does not set the env var, so it still packages the normal product.

#### Runtime isolation (Preview vs installed release)

| Concern | Isolated in Preview? | Location |
|---|---|---|
| Electron app identity / dock icon | Yes | product name + PREVIEW icon + `dev.yuri.desktop.preview` |
| Single-instance lock | Yes | separate `userData` |
| Yuri server data (`settings.json`, `assistants.sqlite`, relay host claim, managed OpenCode bookkeeping, etc.) | Yes | `$userData/yuri-data` via `YURI_DATA_DIR` |
| Session index / message-queue SQLite | Yes | under Electron `userData` |
| Desktop local HTTP port | Effectively yes | stored in profile settings; binds a free port if the preferred one is taken |
| Shared OpenCode **process** | No by default | official service registration under the effective `XDG_STATE_HOME`; private mode is an explicit opt-out |
| **OpenCode session DB** (`opencode.db`) | **No** (shared with release / CLI) | default `~/.local/share/opencode` (or existing `XDG_DATA_HOME`) |
| OpenCode config / provider auth | **No** (shared with release / CLI) | default `~/.config/opencode` and auth under the shared data home |

Preview isolates **Yuri** app state so it can run beside the installed release app, but it reuses the machine’s normal OpenCode global config and session store. That means Preview and release/CLI see the same sessions, models, and auth. Avoid writing the same session from both apps at once if you run them together.

**Dev** (`electron:dev`) still isolates XDG under its own `userData` so HMR work does not write into the production OpenCode DB; it seeds auth/config once from the shared tree.

Regenerate preview icons after changing the production mark:

```bash
bun run --cwd packages/electron generate:preview-icons
```

Requires Pillow (`python3` + `PIL`) and, on macOS, `sips` + `iconutil`.

macOS packaged Dock icons prefer `resources/icons/Assets.car` (`CFBundleIconName=AppIcon`) over `icon.icns`. The Icon Composer source `resources/icons/AppIcon.icon` uses full-bleed light/dark neutral-gradient artwork; the system owns the outer shape, avoiding a second dark frame around an inset tile. Windows/Linux use a single light rounded tile without baked-in shadow or outer padding; legacy macOS ICNS retains transparent Dock spacing. `resources/icons/source` holds the canonical vectors and PNG exports. Run `generate:brand-icons`, `generate:preview-icons`, then regenerate the catalog:

```bash
bun run --cwd packages/electron generate:macos-icon
```

## Platform Notes

On macOS, two or more live app windows (including Mini Chat and hidden/minimized windows, excluding DevTools) disable native vibrancy. Main sends `yuri:vibrancy-ready` with `suppressed: true`; preload sets `data-yuri-vibrancy-suppressed`, and shared CSS paints each window with its own opaque theme tokens, even after theme changes or reloads. Closing back to one window restores vibrancy if enabled in settings. This is transient and does not change the saved preference.

Native macOS fullscreen also suppresses vibrancy for that window, using the default opaque theme background. Leaving fullscreen restores vibrancy only when enabled in settings and there is a single app window.

macOS packaging needs Xcode/build tools, a Developer ID Application certificate, and App Store Connect API credentials. Release workflows sign and notarize the DMG; local preview builds use the same signing configuration.

Windows packaging needs NSIS support through `electron-builder`. If no Windows signing env is set, `package.mjs` disables code signing and builds an unsigned installer.

Linux AppImages must be built natively. Set `YURI_TARGET_ARCH=x64` or `YURI_TARGET_ARCH=arm64` when packaging; the build rejects a target that does not match the Linux host. The same target selects the bundled OpenCode CLI, native Electron rebuild, and Electron Builder architecture. Linux identity is stable across architectures: executable `yuri`, desktop file `yuri.desktop`, icon `yuri`, and `StartupWMClass=yuri`.

After packaging, run `bun run --cwd packages/electron verify:linux-appimage`. The verifier extracts the final AppImage and checks its ELF architecture, desktop identity, Electron executable, pinned OpenCode CLI version and architecture, and all packaged native `.node` modules.

Running a packaged Linux AppImage requires FUSE (`libfuse.so.2`, typically `libfuse2` / `libfuse2t64` on Debian/Ubuntu). Without FUSE, start with `APPIMAGE_EXTRACT_AND_RUN=1`. Keep the AppImage on a writable path so in-app updates can replace it.

Desktop OTA writes only to userData on macOS, Windows and Linux. It does not replace the AppImage or signed application bundle. A shell/backend change requires downloading a full installer through the shared update decision's native target.

### Updater End-to-End Fixture

`bun run test:updater` covers OTA state transitions and runs a real Electron relaunch fixture (`scripts/desktop-ota-evidence.test.mjs`): verified assets are queued, the process PID changes, and the new window loads the new resources through `yuri-ui://`. Full signed installer, Windows and Linux runtime validation still requires those platform builds.

The package supports macOS, Windows, and Linux desktop features. Linux AppImage builds include in-app window controls and auto-update; system tray and launch-at-login remain macOS/Windows only. Some native discovery helpers are platform-specific. For example, app icon fetching and app filtering currently only work on macOS, while opening files in installed apps and installed-app discovery work on macOS and Windows (Linux returns an empty list without errors).

## Open SSH projects in editors

The header's Open in App toolbar supports local instances and saved SSH instances.
`ssh-editor.mjs` owns the editor allowlist and remote URL construction; main reads
the saved SSH command by host ID, reparses it, and opens the URL through Electron.
Both `desktop_ssh_editor_apps` and `desktop_open_ssh_in_app` remain local-page-only
IPC. No renderer-supplied command, URL scheme, app executable, or SSH credential is
used. This shell capability requires a new desktop installer.

The renderer queries capabilities by runtime/host identity and filters the locally
installed app catalog. SSH never falls back to opening a remote path as a local
folder. Copy Path copies the unmodified remote filesystem path, and remains
available even if no supported editor is installed (including Linux, where app
discovery is not implemented). Ordinary direct/Relay hosts without a saved SSH
instance have no toolbar. An SSH instance using Relay fallback retains its SSH
identity and can still hand off to an editor independently of the API transport.
Web, VS Code and mobile surfaces do not expose this native toolbar.

Supported handoffs (research: 2026-10-23):

| Apps in the existing catalog | SSH opening |
| --- | --- |
| VS Code / Insiders | `vscode[\-insiders]://vscode-remote/ssh-remote+authority/path`; Remote-SSH extension required |
| Cursor | `cursor://vscode-remote/ssh-remote+authority/path`; Cursor's Remote-SSH extension required |
| Windsurf | `windsurf://vscode-remote/ssh-remote+authority/path`; its own Remote-SSH implementation |
| Zed | Native `zed://ssh/[user@]host[:port]/path` |
| IntelliJ / PyCharm / WebStorm / Rider / PhpStorm / RustRover | Gateway supports remote development, but its connection link requires a remote IDE backend path/version as well as the project; not included in this host-and-path-only handoff |
| VSCodium / Kiro / Antigravity / Trae | Remote SSH exists through product-specific or community extensions; their external launch compatibility is not validated here, so they are not enabled |
| Finder / Terminal / iTerm2 / Ghostty / Visual Studio / Android Studio / Xcode / Sublime / Eclipse | No validated equivalent remote-folder editor link in this integration; omitted from the SSH menu |

SSH config aliases are preserved so editor-side OpenSSH can apply identity files,
jump hosts and other config. Explicit `-l` and `-p` (including `user@host:port`)
are carried into the link; VS Code-family explicit ports use the Remote-SSH
hex-encoded `{ hostName, user?, port }` authority. Other command-line SSH flags
are rejected with a translated instruction to put them in SSH config and connect
via the alias, rather than silently dropping them. Editor authentication is
independent; Yuri passwords are never transferred.

References: [VS Code URLs](https://code.visualstudio.com/docs/configure/command-line#_opening-vs-code-with-urls),
[Cursor handler confirmation](https://forum.cursor.com/t/cursor-url-handling-issue-with-remote-ssh/73480),
[Windsurf SSH](https://docs.windsurf.com/windsurf/advanced),
[VS Code/Cursor/Windsurf link integration](https://vibekanban.com/docs/settings/general),
[Zed remote development](https://zed.dev/docs/remote-development),
[JetBrains Gateway](https://www.jetbrains.com/help/idea/remote-development-a.html),
[Kiro remote extension policy](https://kiro.dev/docs/privacy-and-security),
[Trae SSH](https://docs.trae.ai/ide/ssh-remote).

## OpenCode CLI (detect, then install)

Managed Desktop / `yuri serve` / HMR discovery still does **not** prefer a packaged extraResource binary. Discovery order: settings/env → PATH `opencode` / known install locations → newest installed stable 2.x under `~/.config/yuri/opencode-cli/<version>/opencode`. Automatic discovery uses only the official `opencode` name and accepts 2.x by version. If nothing usable is found, startup resolves the latest stable 2.x and downloads its `@opencode/cli-<os>-<arch>` package into that data dir; failed registry lookup uses the tested pin. Owned-cache installation/reuse configures new-terminal PATH through the web-owned `terminal-path.js` module; it preserves user shell content, honors zsh `ZDOTDIR`, and handles bash/POSIX/fish or Windows user PATH. A PATH-setup failure logs a warning without discarding a usable runtime and is retried on startup. Only when CLI installation fails (or `YURI_OPENCODE2_AUTO_INSTALL=0` blocks it) does startup fall back to a staged 2.x binary named `opencode` (`opencode.exe` on Windows) under `YURI_BUNDLED_OPENCODE_CLI_DIR` or `process.resourcesPath/opencode-cli`. A healthy v2 `opencode serve` already listening on 4096 is reused; otherwise Yuri starts generic `serve` on 4096 when free. Explicit `OPENCODE_BINARY` / `settings.opencodeBinary` still win for an acceptable 2.x. SSH installation uses `@opencode/cli` and probes `opencode --version`.

SSH reuses any working OpenCode 2.x, independently of the desktop packaging pin. Missing or incompatible CLIs are installed with `@opencode/cli@2`, resolving the registry's latest stable 2.x (never 1.x or 3.x). Bun installs use `--trust` so the required postinstall prepares the executable, including when repairing an existing blocked install. A successful package-manager exit is still verified through `opencode --version` on the managed PATH; a broken Bun binary can otherwise shadow a healthy npm install.

On every managed SSH bootstrap, including reuse of an existing 2.x, the selected CLI and Node directories are written to `~/.config/yuri/ssh-path.sh` (`ssh-path.fish` for fish). Bootstrap appends an idempotent source line to zsh's `.zprofile`/`.zshrc` (honoring `ZDOTDIR`), bash's `.bashrc` and active login profile, POSIX shells' `.profile`, or fish's `config.fish`. Existing user content is preserved. Fresh login and interactive shells must run `opencode --version` as 2.x with the managed PATH removed before bootstrap succeeds. Unsupported shells, write errors, and failed probes are reported as failures; additive PATH setup remains for inspection/retry, and no CLI reinstall is attempted for a PATH-setup failure. Already-open terminals need a new shell to load the change.

`prepare:opencode-cli` stages `resources/opencode-cli` for packaging/CI; runtime discovery (`resolveOpencodeCliPath`) still ignores that copy — it is only a last-resort after install failure.

## Releases and automatic updates

Packaged desktop apps call `POST /v1/mobile/update/check` with `platform: desktop` on the public update service. Desktop and mobile share `ota/channels/{beta,stable}.json`, major isolation, rollout, pause and beta→stable rollback decisions. The About beta switch overrides the shell's baked channel (prerelease shell → beta, stable shell → stable). Updates are independent of the connected Host. Checks run at startup and hourly while visible, and from the menu/sidebar/Settings.

Download stages the desktop ZIP from `activeBundle.desktop`, checks size/SHA-256 and archive paths, and queues it for the next launch. Restart awaits the existing backend shutdown and uses `app.relaunch()` / `app.exit(0)`. The UI explicitly confirms readiness through local-only `desktop_ota_ready`. A failed/unconfirmed launch returns to the previous good bundle or builtin on the next launch; a 60-second UI readiness timeout requests that recovery restart. Rejected bundle IDs cannot loop. Changing channels invalidates queued downloads. A new native installer version resets cached activation to its builtin assets.

CI builds desktop and mobile ZIPs from the same Web build (the mobile ZIP may still use Capgo encryption). `scripts/desktop-ota-assets.mjs` fingerprints shell/backend sources and locked dependencies. Assembly carries the desktop minimum shell version forward when the fingerprint matches and raises it on change; OTA-only publishing rejects changed shell/backend fingerprints. The desktop floor always compares the installed shell version, never the downloaded UI version. Release CI publishes shared OTA only after installers are published and no longer publishes `latest*.yml`. Existing pre-OTA desktops need a one-time installer upgrade to adopt this mechanism.

The `Release` GitHub Actions workflow runs for `v*` tags or by manual dispatch. Before starting a release:

1. Run `bun run version:bump -- <version>` and update the matching `CHANGELOG.md` section.
2. Set `CSC_LINK`, `CSC_KEY_PASSWORD`, `APP_STORE_CONNECT_PRIVATE_KEY_BASE64`, `APP_STORE_CONNECT_KEY_ID`, and `APP_STORE_CONNECT_ISSUER_ID` for signed and notarized macOS desktop builds. CI imports the Developer ID p12 into a temp keychain and leaves `CSC_LINK` unset for electron-builder, so macos-26 does not hit `SecKeychainUnlock` with the p12 password.
3. Configure `NPM_TOKEN` so the release workflow can publish `@yuriai/web` and `@yuriai/relay-server` to npm. iOS signing secrets are required for the TestFlight upload that runs with the formal release workflow.
4. For a desktop-only release, manually dispatch the workflow with scope `desktop` (the default). Pushing tag `v<version>` retains the full-release behavior.

The workflow creates the GitHub Release and uploads desktop installers. macOS, Windows and Linux use in-app resource OTA plus restart; incompatible shells follow the native installer target. Formal releases also upload Android artifacts and send iOS builds to TestFlight. A dry run keeps the Release as a draft. The version validation step fails early if the requested version differs from the root or Electron package version.

Managed local Desktop startup prefers OpenCode binaries in this order:

1. Explicit overrides: `settings.opencodeBinary`, `OPENCODE_BINARY`, `OPENCODE_PATH`, `YURI_OPENCODE_PATH`, or `YURI_OPENCODE_BIN`.
2. The bundled Desktop CLI in `process.resourcesPath/opencode-cli`.
3. System installs discovered from PATH and known npm/Bun/Scoop/Chocolatey locations.

Use an explicit override when testing a different OpenCode CLI build or when a user needs to point Desktop at a custom binary. The configured path must point to the standalone CLI, not the OpenCode Desktop app executable.

## Common Env Vars

| Variable | Use |
|----------|-----|
| `YURI_UPDATE_ORIGIN` | Verified HTTPS update service origin, supplied at packaging (baked into main) or runtime. No guessed production domain; missing configuration fails update checks explicitly. |
| `YURI_ELECTRON_DEV=1` | Marks the runtime as desktop development mode |
| `YURI_ELECTRON_USE_BUNDLED_UI=1` | Uses staged web assets instead of the HMR dev server |
| `YURI_HMR_UI_PORT` | Preferred Vite UI port for desktop dev, default `5173` |
| `YURI_HMR_API_PORT` | Preferred API port for desktop dev, default `3901` |
| `YURI_RUNTIME=desktop` | Set by Electron before starting the web server |
| `YURI_OPENCODE_CLI_VERSION` / `YURI_OPENCODE2_VERSION` | Optional packaging override for the bundled OpenCode CLI version; defaults to `PINNED_OPENCODE2_VERSION` in `packages/web/server/lib/opencode/opencode2-pin.js`. SSH installs independently resolve latest stable 2.x. |
| `YURI_TARGET_ARCH` | Explicit desktop package architecture (`x64` or `arm64`); Linux requires it to match the native host |
| `YURI_DESKTOP_PROFILE` | Packaging profile: unset/`release` (CI default) or `preview` (local side-by-side QA build; distinct identity, PREVIEW icon, isolated Yuri data dir). Prefer `bun run electron:build:preview` for local Desktop packages. |
| `YURI_DATA_DIR` | Yuri server data root. Preview/dev set this under Electron `userData` when unset so they do not share `~/.config/yuri` with the release app. |
| `YURI_DESKTOP_NOTIFY=true` | Enables desktop notification flow in the web server |
| `YURI_SKIP_API_COMPRESSION=true` | Defaulted by Desktop to reduce local CPU overhead |
| `OPENCODE_HOST` / `OPENCODE_PORT` / `OPENCODE_SKIP_START` | Connect Desktop to an external OpenCode server instead of starting one locally |

## Native Features Owned Here

- Floating Mini Chat windows.
- Multiple native windows.
- Native notifications.
- Notification clicks target the originating window, with deduplication scoped to that window. In-process backend notifications target a local-runtime window, excluding relay hosts. Closed windows or windows whose shell runtime changed do not redirect old notifications to another instance.
- One-click open/reveal/open-in-app actions.
- Desktop host switcher and deep-link imports.
- Local and remote instance handling.
- SSH host import, connections, logs, and port forwarding. Managed SSH remotes default to `relayHost: true`: they start with a UI password (configured or a one-time in-memory secret) and `--relay-host` so the remote hosts its own private relay. A leftover `web` serve on the preferred port is restarted as `ssh-remote`. After connect, desktop persists the remote's public relay descriptor next to the local-forward `apiUrl` so this machine can fall back to relay when the SSH tunnel is down; pairing a phone or another desktop still uses the remote's ordinary Add Device flow. Each managed command scopes its own PATH, discovers a Node.js 22+ runtime from common remote locations (preferring even LTS majors 22/24 and a sibling `npm` over odd majors such as 23), installs missing Yuri or OpenCode CLIs with the selected package manager (`@opencode/cli` → `opencode` v2, never 1.x `opencode-ai`), and repairs the Yuri `better-sqlite3` binding when the selected Node ABI requires it (probe first, then clean `node_gyp_bins`, rebuild, retry, and npm reinstall). Bootstrap failures emit a classified `errorCode` plus a short `detail`; the full remote log stays in SSH logs so the desktop client can show user-actionable guidance. Bootstrap also configures and verifies login-shell CLI PATH as described above. Managed SSH remotes can mirror the local `~/.config/opencode` allowlist (config json/jsonc winner + agents/commands/skills/plugins dirs, symlinks dereferenced) and the `~/.agents` agent skills root, with remote-side backups under `.yuri.sync-backup` / `.yuri.sync-backup-agents` and stale counterpart deletion. Selected provider keys use the V2 credential API over authenticated HTTP through the SSH forward, with no credential file or database copying. Preview/apply sync for a given `ssh:<instanceId>` target is process-local exclusive (`sync_in_progress` when already running); each run gets a `syncRunId` and an append-only record under `<YURI_DATA_DIR>/sync-runs/` (newest 20 kept per target, never stored in `settings.json`; records include plan `direction`; readable via `desktop_ssh_sync_runs_list`). Sync planning, selections, POSIX prepare/probe/inventory/finalize scripts, and apply orchestration live in `packages/web/server/lib/config-sync/`. **Push** uses an SSH `TargetExecutor`; **pull** inventories the remote, downloads tar streams over ControlMaster, and applies generational backups locally. Direction changes re-run preview IPC (no cached plan flip). Whitelist selections (`fileGroups` / `singleFiles` / `directories` / `agentsRoot` / `providerCredentials`) are shared by preview and apply. Prepare keeps generational file backups under `<backupRoot>/<syncRunId>/` (retention 5). Provider keys (`providerCredentials`) stay unchecked by default; account merges and in-memory rollback belong to the host config-sync module. Desktop `settings.json` writes from main, ssh-manager, and the in-process web server share one mutation chain via `settings-store.mjs` / `startWebUiServer({ settingsPersistLock })`.
- Auto-update checks, downloads, and restart/apply flow.

## IPC Pattern

Renderer code should call the desktop bridge exposed by `preload.mjs`. Do not import Electron from shared UI code.

Add new native capabilities in this order:

1. Add or update the `preload.mjs` bridge only if a new renderer-facing shape is needed.
2. Add the real command handling in `main.mjs` under `yuri:invoke`.
3. Gate privileged commands in main process logic so remote pages cannot access local filesystem or shell capabilities.
4. Keep shared UI runtime contracts in `packages/ui` and server/runtime APIs in `packages/web` when the behavior is not inherently native.

## Virtual Image Asset Protocol

The durable `image-disk-cache.mjs` adapter also serves general file MIME types through the shared UI file-resource owner. Existing `image-cache-v1` disk data and image IPC names remain compatible. New preload capability `fileResources` enables generic reads and hit-only `lookup`; the gated lookup registers the same navigation/destroy lease cleanup as acquire. Cached protocol reads implement single byte ranges, suffix/open-ended seek, HEAD and 416. Native storage accepts up to 256 MiB per file; shared UI complete-body acquisition still caps at 32 MiB. The one-use image protocol below remains a display adapter, distinct from this durable store. Generic cached HTML carries a restrictive CSP and does not replace original-origin HTML previews.

Relay/host-backed images need a browser-consumable URL that Chromium can load as `<img src>` / CSS without giving main-process code tunnel credentials or host filesystem paths. Desktop uses a dedicated secure custom scheme and a local-only push bridge:

| Piece | Role |
|-------|------|
| Scheme | `yuri-asset` (privileged: `standard`, `secure`, `supportFetchAPI`, `corsEnabled`, **`stream`**) |
| URL form | `yuri-asset://stream/<assetId>` — opaque id in the path only; no userinfo, query, fragment, or host paths |
| Registry | `virtual-asset-protocol.mjs` maps `assetId` → `protocol.handle` `ReadableStream` |
| Static UI | Unchanged: packaged pages stay on `yuri-ui://` |

### Renderer bridge (local page only)

Exposed only when the page is the packaged UI (`yuri-ui://app`) or the exact local loopback origin. Remote host pages do **not** get `virtualAsset`. Main re-checks `isLocalSender` on every channel.

```ts
// window.__YURI_DESKTOP__.virtualAsset

type VirtualAssetCreateResult = {
  assetId: string;
  url: string;       // yuri-asset://stream/<assetId>
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

IPC channels (not via `yuri:invoke`):

- `yuri:asset:create` — `{ mimeType }`
- `yuri:asset:push` — `{ assetId, chunk }`
- `yuri:asset:finish` / `yuri:asset:cancel` — `{ assetId }`

### Lifecycle and limits

1. Local UI creates an asset with an image MIME (`image/png`, `image/jpeg`, …).
2. UI pulls bytes from the relay tunnel (or any renderer-owned source) and `push`es bounded chunks.
3. UI or layout assigns `url` to an image element; Chromium requests the scheme; main returns a streaming `Response`.
4. UI calls `finish` when the body is complete, or `cancel` on error/unmount. Protocol abort / stream cancel also destroy the asset.

Default bounds (see `DEFAULT_VIRTUAL_ASSET_LIMITS`): max concurrent assets, max queued bytes (backpressure), max chunk size, max total bytes, and TTL for idle assets. One consumer per `assetId` (second request → 409). `push` never buffers past `maxQueuedBytes`; when the queue is full it waits for the protocol consumer to drain (or for cancel / finish / dispose / TTL). A missing consumer therefore cannot hang the renderer pump forever or grow memory without bound.

Security invariants:

- Main never sees host paths, bearer tokens, or relay keys — only opaque ids + binary chunks + image MIME.
- Remote renderer pages cannot create or feed assets.
- Does not share the `yuri-ui` protocol handler.

## Relay Preview Loopback Gateway

When the desktop UI is connected to a Host over **private Relay**, Chromium cannot load Host loopback preview pages through `relay://` or by hitting the client machine's ports. Preview therefore uses a **local-only** HTTP gateway in the Electron main process:

- Bind **`127.0.0.1` only** on an **ephemeral port**. Unauthenticated front door: **GET/HEAD** and **WebSocket upgrade** under path prefix **`/api/preview/proxy/`** only (everything else 404).
- One owner `webContents` (the local page that called `ensure`). Multi-window: that window only; owner gone or send failure → HTTP 503 / WS close.
- Main is a dumb pipe: no Relay keys, Host URLs, or bearer tokens. HTTP: emits `{ requestId, method, path }` to the owner; renderer `runtimeFetch`es and streams body back (`begin` / `push` / `end` / `abort`). WS: emits `ws-open` / `ws-message` / `ws-close`; renderer mints `yuri_url_token`, opens via `openRuntimeWebSocket`, and pipes frames (`wsOpened` / `wsSend` / `wsClose`).
- Auth stays on existing **`yuri_preview_token` + `yuri_url_token`** query rewrite. Chromium cannot apply tunneled **`Set-Cookie`** into the iframe jar, so the gateway never re-emits Set-Cookie — **upstream-app cookies (login on the previewed site) are dropped over Relay**. Never log gateway URLs, tokens, or paths with query.
- LAN/direct Preview does **not** start the gateway; iframe `src` stays `authenticatedAsset(...)`. IPC channels are separate (`yuri:preview-gateway:*`), local-page only, and are **not** on `COMMANDS_SAFE_FOR_REMOTE`.

```ts
// window.__YURI_DESKTOP__.previewGateway (local page only)
previewGateway.ensure(): Promise<{ origin: string }>  // http://127.0.0.1:<port>
previewGateway.begin({ requestId, status, headers })
previewGateway.push(requestId, chunk)  // await each chunk (backpressure)
previewGateway.end(requestId) / previewGateway.abort(requestId)
previewGateway.wsOpened({ requestId }) / wsSend(requestId, data, binary?) / wsClose(requestId, { code?, reason? })
```

## Logs And Data

### Yuri installer migration (2.x window)

`brand-migration.mjs` is the single desktop startup coordinator. The new release,
Preview and development roots are respectively `Yuri`, `Yuri Preview` and `Yuri Dev`
under Electron's platform `appData`. Each reads only the corresponding previous
`OpenChamber` / `OpenChamberY` profile. Multiple legacy candidates require the user
to select one source outside the application; they are never merged silently.

Before storage owners start, migration checks that the previous desktop process is
closed, snapshots only `Local Storage` and `IndexedDB` into
`userData/migration-source-v1`, and takes consistent SQLite `VACUUM INTO` snapshots
of the desktop session-index, message-queue and transcript-cache databases (WAL
included). Existing destination files win. The image cache is staged and renamed.
Symlinks, corruption and unreadable sources fail closed. Original files remain
untouched. Host-owned state is handled by the web package's migration owner.

After Electron readiness but before any application window/preload runs, two hidden,
sandboxed, preload-free windows open the snapshot's `openchamber-ui://app` origin
and the new `yuri-ui://app` origin. A temporary protocol handler serves only an empty
page, denies all other URLs and is removed after import. The legacy origin is never
accepted by the privileged IPC gates. Database/store/index schemas, keys and values
are transferred record-by-record; Blob/File attachments, binary data and dates retain
their types. Only storage key/database identifiers are renamed; user content is not.
Independent destination databases win as a whole, including higher versions and
deleted records. Only databases created with the atomic desktop migration ownership
store may resume; per-database completion receipts prevent resurrection after later
deletion. localStorage uses per-key tombstones and changes namespace segments only,
preserving encoded URLs and opaque scope bytes. Limits are 64 databases,
200,000 records, 1 GiB encoded total, 64 MiB binary per record and 16 MiB localStorage.
Cookies, sessionStorage, service workers, Chromium preferences and old OTA bundles
are not imported. Loopback/HMR origins are not automatically re-originated.

Each IndexedDB write is transactional. The completion receipt
`yuri-desktop-migration-v1.json` is atomically renamed only after successful import
and storage flush. Failure shows an import error and exits before loading an empty
application; the snapshot and original remain recoverable. Retry resumes by inserting
missing records without overwriting current state. The snapshot is deliberately
stable across retries: do not resume editing in the old application mid-import.
An invalid receipt, unsupported schema/value type or exceeded bound is a visible
failure requiring recovery, not a successful empty migration. Source/snapshot cleanup
is manual after verified recovery; the installer never deletes the only old copy.

OTA requests and `desktop-ota.json` use `applicationId: dev.yuri.desktop` and
`shellApiVersion: 2`. The manifest assembler and update service must share these
fields. A foreign or pre-Yuri resource bundle is rejected before activation. Existing
Preview builds do not initialize the release updater and require manual Preview
installer updates; their bridge reports the `.preview` identity. Development reports
`.dev`. Neither can download a release-identity installer through the update bridge.
backend OTA no-automatic-rollback behavior is retained. Native IDs
`dev.yuri.desktop`, `.preview` and `.dev`, the `@yuriai` scope and `yee94/yuri` repository
are candidates pending external ownership/signing verification.

Legacy scan exceptions are confined to the explicit source identities/protocol/name
mapping/process guard in `brand-migration.mjs`, old-input fixtures in
`brand-migration.test.mjs` and `scripts/brand-migration-evidence.mjs`, and this migration
documentation. Owner: desktop maintainers. Exit: after the 2.x migration window and
successful user recovery, remove the importer and its legacy fixtures together; never
remove compatibility strings independently while the importer remains supported.

`test:brand-migration` runs a real Electron old-profile seed, new-origin import and
independent restart verification for drafts, attachment bytes, transcript content,
schema and settings. Unit tests cover WAL, destination precedence, corruption/retry,
running-source refusal and Preview isolation. macOS headless Electron evidence does
not verify Windows/Linux installation, signed upgrades, OS credentials, Dock cache,
real user-profile imports or remote update deployment.

Electron uses `electron-log`. In development, console logs are also visible in the terminal. Packaged apps route `console.warn` and `console.error`, plus explicit `electron-log` events, through the platform log path for the `Yuri` app name; ordinary `console.debug`, `console.info`, and `console.log` calls are no-ops.

Development builds use a separate user data directory named `Yuri Dev`, so dev state does not overwrite normal packaged app state.

## Things To Be Careful With

- Keep desktop-specific code in this package. Do not move OpenCode feature backend logic into Electron.
- Use hidden Windows process launches for background helpers. Avoid visible console flashes.
- Keep `@yuriai/web`, `bun-pty`, `node-pty`, and native modules external in `bundle-main.mjs`; bundling them can break Electron startup.
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
