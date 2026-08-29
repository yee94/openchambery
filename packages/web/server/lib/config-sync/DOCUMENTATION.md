# Config Sync Module

## Purpose

Own the direction-agnostic OpenCode config sync contract: allowlist planning on the source, target identity/capabilities, POSIX prepare/probe/finalize scripts, tar collection, selection filtering, local/remote generational backups, and apply orchestration. Electron's managed SSH push **and pull** paths are the first executors; non-SSH targets reuse the same shapes.

## Entrypoints

| File | Role |
|------|------|
| `index.js` | Public re-exports |
| `constants.js` | Allowlist, backup roots, size limits, direction constants, generation retention (`N=5`) |
| `contract.js` | `SyncTarget`, capabilities, `TargetExecutor` typedefs, capability asserts |
| `plan.js` | `planOpenCodeConfigSync` / `planOpenCodeConfigSyncFromInventory` |
| `selections.js` | Default/normalize/filter whitelist selections |
| `scripts.js` | Probe / inventory / generational prepare / finalize / remote tar scripts |
| `local-backup.js` | Local (pull destination) generational backup + tar extract |
| `tar.js` | `collectLocalTarBuffer` (buffered) |
| `engine.js` | `applyConfigSyncPlan` orchestration for **push** (prepare → putTar* → finalize) |
| `target-id.js` | `ssh:<instanceId>` namespace helper |

## Contract shape

- **SyncTarget**: `{ id, kind, capabilities: { posixShell, tarExtract, authFileWrite } }`
- **TargetExecutor**: `{ probe(plan), prepare(plan, { syncRunId }), putTar({ kind, payload }), finalize(plan, { syncRunId }) }`
  - `payload`: `Buffer | Uint8Array` — all executors currently buffer; reintroduce streaming only when a transport needs it.
- **Plan** (source-computed): `{ direction: 'push' | 'pull', syncRunId?, sourceTargetId?, targetId?, files, directories, agentsRoot, authFile, deletes, totalBytes, selections? }`
- **Selections**: `{ fileGroups: boolean[], singleFiles: boolean[], directories: boolean[], agentsRoot: boolean, authFile: boolean }`
  - Preview and apply must share one selections snapshot so the confirmed scope cannot drift.
  - `authFile` defaults unchecked like an opt-in ordinary selection; once checked it syncs the same way as other allowlisted files (no extra grant).

## Direction flow

| Direction | Source plan | Destination mutate |
|-----------|-------------|--------------------|
| `push` | Local home walk (`planOpenCodeConfigSync`) | Remote prepare + putTar + finalize |
| `pull` | Remote inventory script → `planOpenCodeConfigSyncFromInventory` | Local `prepareLocalSyncDestination` + extract + finalize |

Switching direction in the wizard **must** discard the previous preview and re-call preview IPC (no client-side flip of an old plan).

## Invariants

- Plan is computed on the source filesystem/inventory snapshot; destination executors never re-walk the source.
- Managed SSH readiness is gated by `posixShell` (and `tarExtract` / `authFileWrite` as needed).
- Prepare (remote or local) writes generational backups under `<backupRoot>/<syncRunId>/` and prunes older than `OPENCODE_CONFIG_SYNC_BACKUP_GENERATIONS`. Failed runs keep their scene until pruned.
- Finalize confirms the run's backup directory exists.
- Run records (Electron `sync-run-store`) persist `direction` alongside `syncRunId` / summary; they are not stored in `settings.json`.
- **`auth.json` sync:** treated like any other selected allowlist item. Default selection leaves it unchecked; when selected, push/pull transfer it under the dedicated auth backup directory with no separate credential grant.

## HTTP receive protocol (direct / later relay)

Routes under `/api/openchamber/config-sync/*` (global `/api` auth gate: session or clientToken bearer):

| Method | Path | Role |
|--------|------|------|
| POST | `/probe` | Inventory + existence vs plan |
| POST | `/prepare` | Generational local backup + deletes; one inflight `syncRunId` |
| PUT | `/put/:kind?syncRunId=` | Stream tar.gz (`config` \| `agents` \| `auth`) |
| GET | `/download/:kind` | Stream tar.gz for pull source |
| POST | `/finalize` | Confirm backup generation + success receipt |
| POST | `/abort` | Clear inflight |

`auth` put/download follows the same selection/plan rules as other kinds. Concurrent prepare → `sync_in_progress`.

## Composition

- Electron SSH: `TargetExecutor` push + inventory/tar pull.
- Electron direct hosts: `direct-config-sync.mjs` calls these HTTP routes.
- **Relay hosts (ticket 06):** UI opens an E2EE tunnel (`packages/ui/src/lib/relay/relay-config-sync.ts`) and calls the same HTTP routes via `tunnel.fetch`. Target id is `relay:<serverId>` (signing-key fingerprint). Preview/apply refresh candidates and refuse on `serverId` mismatch (`relay_identity_changed`) with no fallback identity. Auth remains the global `/api` bearer gate; selected `auth.json` transfers without a separate credential grant.
