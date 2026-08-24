# OpenChamber Agent Guide

## Purpose

OpenChamber provides shared web, desktop, VS Code, hosted-mobile, and native-mobile UI surfaces for OpenCode.

This file contains only always-on repository rules and routing. Detailed workflows belong to project skills and module documentation.

## Instruction Order

Before editing:

1. Follow this root guide.
2. Load every matching project skill.
3. Read the nearest `DOCUMENTATION.md` and package `README.md` when present.
4. Follow local code and test precedent.

If these sources materially conflict, stop and resolve the conflict instead of silently choosing one.

## Runtime Boundaries

- `packages/ui`: shared React UI, state, sync, and runtime contracts.
- `packages/web`: web surfaces, OpenChamber server, managed/external OpenCode lifecycle, and CLI.
- `packages/electron`: native desktop shell and privileged Electron boundary.
- `packages/vscode`: extension host, webview, and runtime bridge.
- `packages/mobile`: Capacitor iOS/Android shell; bundles the mobile web surface and connects to an existing OpenChamber server.
- `packages/docs`: product documentation; not a Bun workspace.

Shared UI calls official OpenCode APIs through `@opencode-ai/sdk/v2`. OpenChamber-owned capabilities use `RuntimeAPIs`, `runtimeFetch`, and shared browser/realtime transport helpers. Server-side upstream integrations may use their owning runtime modules.

Electron starts the OpenChamber backend in-process, never as a sidecar. Development may load loopback/HMR UI; packaged builds load staged assets through `openchamber-ui://` while the loopback server remains the API backend. Keep domain backends in web/runtime modules unless behavior is inherently native.

Shared contracts must define intentional behavior for every applicable runtime: web, desktop, VS Code, hosted mobile, and Capacitor mobile.

Desktop release work belongs in `packages/electron/`. Electron owns windows, menus, dialogs, notifications, updater, deep links, runtime host switching, local IPC gates, and SSH management. The desktop runtime imports `@openchambery/web/server/index.js` and starts the web server in-process through `startWebUiServer`; notifications flow through the injected `onDesktopNotification` callback.

Release artifacts and repository links use `yee94/openchamber`. Electron is the desktop release target; use `bun run electron:build` for the current platform and `bun run release:test` for the release smoke build. Ship or update a version: default `v*` (desktop + APK + same-version OTA) so first-time downloaders have installers. TestFlight follows the mobile plan mode, not the tag: native-mode betas and stable upload iOS (beta internal-only, stable external group); web-only (`mode: ota`) betas skip iOS. The in-app minNativeBuild floor (one-tap OTA vs reinstall) rises only on native mode. `mobile-beta/v*` only for explicit mobile-web-only OTA with no installers and no iOS. See `docs/RELEASING.md` § 先选产物. Agent GitHub releases follow `docs/RELEASING.md` and `.opencode/commands/release.md`. Semver prereleases (`X.Y.Z-beta.N` / any version with `-`) must publish as GitHub prereleases and must never enter the stable auto-update feed (`/releases/latest`, Vercel `/desktop/latest*.yml`, or `deploy/update-service/release-manifest.json`). Every OTA publish must pass `scripts/mobile-ota/verify-detectability.mjs` on both Vercel and EdgeOne, including the iOS Capgo builtin marketing-version profile (`currentBundleId` = stripped `1.18.2`); beta-channel checks use the running web bundle version, never the store/TestFlight marketing version.

## Native Module Runtime

- The Web API development server runs with Node.js 24. `better-sqlite3` must use the matching Node ABI before Node starts the server.
- `packages/web` development server scripts run `scripts/ensure-node-better-sqlite3.mjs`, which probes SQLite and rebuilds `better-sqlite3` with npm when its native binding targets another runtime ABI.
- Electron packages rebuild native modules against Electron through `packages/electron/scripts/rebuild-native.mjs`. A later Web API development launch restores the Node-compatible `better-sqlite3` binding automatically.

## Always-On Constraints

- Do not modify `../opencode`; it is a separate repository.
- Do not run git or GitHub commands unless the user explicitly asks.
- Do not add dependencies unless explicitly requested.
- Never add or log secrets, bearer tokens, pairing credentials, or sensitive user data.
- Keep repository artifacts free of personal domains, machine paths, and container-registry namespaces; use neutral examples and environment-driven deployment references.
- Keep changes minimal and preserve unrelated worktree changes.
- Enforce security and correctness in core/runtime logic, not only UI visibility or prompts.
- Keep entrypoints and bridges thin; place domain logic in focused owning modules.
- Update owning documentation when module ownership, contracts, or invariants change.

## Correctness Invariants

- Prefer authoritative state over heuristics.
- Derive live activity from live channels, not persisted history.
- Scope temporary fallbacks narrowly and clear them when authoritative state arrives.
- Never let fetch failure masquerade as authoritative empty success.
- Make partial results, rollback, cleanup, and stale-data behavior explicit.
- One failed entity must not erase or block unrelated complete entities.
- Rank a collection by its order source, not by identity, unless identity order is the contract.
- Runtime-specific differences must be intentional and visible in code.

## UI State and Runtime Ownership

- TanStack Query owns runtime-scoped pull server state.
- `@reactuses/core` is installed and owns standard browser, DOM, event, timer, observer, and storage interaction Hooks.
- Zustand and component state own UI selections, drafts, and mutation orchestration.
- `RuntimeAPIs`, `runtimeFetch`, and relay transports own cross-runtime and realtime boundaries.
- Use `useEffect` to synchronize external systems. Calculate derived values during render and trigger mutations from event handlers.
- Shared UI never uses `React.useCallback` or `useCallback`. Event handlers and callbacks passed to child components or external subscriptions with stable identity requirements use `@reactuses/core` `useEvent`.
- Render-phase selectors, synchronous derived calculations, and callback factories use `useMemo`, module-level pure functions, or ordinary functions. `useEvent` is reserved for event-time callbacks because its latest implementation changes during the layout phase.
- Effect rerun conditions express their real semantic dependencies. `useEvent` identity never controls an effect's rerun condition.

## Session Index and Performance Invariants

- The runtime session index is SQLite-backed and owns durable cold-start session summaries.
- The server-owned refresh scheduler performs bounded directory refreshes; session content, child-session, and message mutations preempt index refresh work.
- Sidebar list ownership remains index-driven. Display snapshots stay bounded, while catalog-wide cleanup uses the authoritative full catalog.
- Cross-directory selectors subscribe to narrow child-store fields. Per-session status readers subscribe only to their session entry.
- Preserve stable references for unchanged state and isolate high-frequency consumers from shell and layout subscribers.

## Documentation Discovery

Before changing a module, search for the nearest `DOCUMENTATION.md`; before package-level work, read its `README.md`. Discover docs dynamically under `packages/**/DOCUMENTATION.md` rather than relying on a static exhaustive map.

High-value anchors:

- App router (path mode): `packages/ui/src/router/DOCUMENTATION.md`
- Sync: `packages/ui/src/sync/DOCUMENTATION.md`
- Stores: `packages/ui/src/stores/DOCUMENTATION.md`
- Shared UI primitives (Select / searchable pickers, dialogs, mobile sheets): `packages/ui/src/components/ui/DOCUMENTATION.md`
- CLI: `packages/web/bin/lib/DOCUMENTATION.md`
- VS Code runtime: `packages/vscode/src/DOCUMENTATION.md`
- Electron: `packages/electron/README.md`
- Mobile: `packages/mobile/README.md`
- Releases (default `v*` for installers + OTA; stable + beta isolation): `docs/RELEASING.md`, agent command `.opencode/commands/release.md`
- Update feed: `deploy/update-service/README.md`
- Tests (Vitest projects): `vitest.config.ts`

## Project Skills

Project skills live under `.agents/skills/*/SKILL.md`. Before editing, load every matching skill; multiple skills may apply. Skills are canonical for their detailed workflows and checklists.

| Trigger | Required skill |
|---|---|
| Any source, dependency, export, build-config, generated-asset, package-contract, or module-ownership change | `openchamber-change-discipline` |
| CLI commands, prompts, terminal output, non-TTY, `--quiet`, or `--json` behavior | `clack-cli-patterns` |
| Shared UI data access, React Hooks, `@tanstack/react-query`, query keys/cache/invalidation, `@reactuses/core`, browser Hooks, OpenCode SDK, `RuntimeAPIs`, runtime fetch/auth/URLs, bridges/proxies, runtime switching, or server API routes | `ui-api-decoupling` |
| Electron main/preload, IPC, native UI, updater, deep links, SSH, packaging, or child processes | `desktop-shell` |
| Session sync, bootstrap/reconnect, reducers, polling, optimistic state, queues, live status, reconciliation, or directory-scoped caches | `sync-state-invariants` |
| Render/store/event hot paths, large lists, caching/indexing, high CPU/memory, lag, jank, freezes, or performance regressions | `performance-engineering` |
| WebSocket, SSE, streaming transport, runtime transport internals, or private relay | `relay-transport` |
| UI components, styling, colors, buttons, or icons | `theme-system` |
| User-facing or accessible UI text, labels, aria, toasts, dialogs, or navigation copy | `locale-ui-patterns` |
| Settings UI, settings dialogs, configuration surfaces, or settings search | `settings-ui-patterns` |
| Sortable or drag-to-reorder behavior, especially `@dnd-kit` and touch/wrapping layouts | `drag-to-reorder` |
| iOS Simulator build, launch, preview, gestures, or `serve-sim` control | `serve-sim` |

Pure code-reading or explanation does not require implementation skills unless needed to interpret a specialized subsystem.

## Tests

Workspace tests run on Vitest 4 (`vitest.config.ts` `projects`). Do not use `bun test` or `node --test` as the runner.

| Command | Scope |
|---|---|
| `bun run test` | Every workspace package `test` script |
| `bun run test:vitest` | All Vitest projects (`ensure-node-better-sqlite3` first) |
| `bun run test:ui` | `@openchamber/ui` |
| `bunx vitest run --project <name> <file>` | One project, optional file |
| `bun run --cwd packages/<pkg> test` | That package only |

Project names: `@openchamber/ui`, `@openchamber/web`, `openchamber-vscode`, `@openchamber/electron`, `@openchamber/mobile`, `@openchamber/relay-server`, `@openchamber/update-service`.

- New tests import from `vitest`. `bun:test` still works through `scripts/test/bun-test-shim.ts`; module mocks that must beat static imports use `vi.hoisted` + `vi.mock`, not `mock.module`.
- `packages/ui` uses `happy-dom`. Do not read local files with `new URL(..., import.meta.url)` (not a `file:` URL); use `path.join(path.dirname(fileURLToPath(import.meta.url)), ...)`.
- `packages/web` tests need the Node ABI `better-sqlite3` binding (`scripts/ensure-node-better-sqlite3.mjs`).
- Electron IndexedDB evidence tests spawn a real Electron window: `bun run --cwd packages/electron test:input-draft-indexeddb` / `test:transcript-durable-indexeddb`. Skip them unless that surface changed.

## Validation

- Use `package.json` scripts as the command source of truth.
- Prefer focused Vitest files for the touched surface, then the owning package `test` script when the contract is broader.
- Run `bun run dead-code` when source files are added/deleted/renamed or exports, types, entrypoints, or import shape change; inspect its report because it is non-blocking.
- Run focused tests, syntax checks, builds, or runtime validation for the touched surface when relevant.
- For docs-only or isolated config changes, run the narrowest relevant validation.
- Report exactly what was and was not validated. Static checks alone do not prove runtime, relay, performance, or platform correctness.

## Agent skills

### Issue tracker

Tickets live as local Markdown under `.scratch/<feature>/issues/`. See `docs/agents/issue-tracker.md`.

### Domain docs

Use a single `CONTEXT.md` and `docs/adr/`. See `docs/agents/domain.md`.
