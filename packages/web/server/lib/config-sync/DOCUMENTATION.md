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
| `credentials.js` | V2 credential API transfer, validation, account merge and in-memory rollback |
| `magpie.js` | Host-local Magpie discovery, verified CLI provisioning, native backup/restore |
| `target-id.js` | `ssh:<instanceId>` namespace helper |

## Contract shape

- **SyncTarget**: `{ id, kind, capabilities: { posixShell, tarExtract, providerCredentialsWrite } }`
- **TargetExecutor**: `{ probe(plan), prepare(plan, { syncRunId }), putTar({ kind, payload }), finalize(plan, { syncRunId }) }`
  - `payload`: `Buffer | Uint8Array` — all executors currently buffer; reintroduce streaming only when a transport needs it.
- **Plan** (source-computed): `{ direction: 'push' | 'pull', syncRunId?, sourceTargetId?, targetId?, files, directories, agentsRoot, providerCredentials, deletes, totalBytes, selections? }`
- **Selections**: `{ fileGroups: boolean[], singleFiles: boolean[], directories: boolean[], agentsRoot: boolean, providerCredentials: boolean, magpie?: boolean }`
  - Preview and apply must share one selections snapshot so the confirmed scope cannot drift.
  - `providerCredentials` is the selection/metadata key; the UI calls it **Provider keys**. It defaults unchecked and contains only `{ bytes }`, never credential values or a filesystem path. The protocol has no legacy credential-file fields, aliases, archive kinds, probe markers or backup roots.

## Direction flow

| Direction | Source plan | Destination mutate |
|-----------|-------------|--------------------|
| `push` | Local home walk (`planOpenCodeConfigSync`) | Remote prepare + putTar + finalize |
| `pull` | Remote inventory script → `planOpenCodeConfigSyncFromInventory` | Local `prepareLocalSyncDestination` + extract + finalize |

Switching direction in the wizard **must** discard the previous preview and re-call preview IPC (no client-side flip of an old plan).

## Invariants

- Plan is computed on the source filesystem/inventory snapshot; destination executors never re-walk the source.
- All local, HTTP and SSH archive builders exclude `node_modules`, `.venv-asc` and `*.backup`
  at every depth, including followed symlinks, matching the inventory walk. Keep
  these exclusions in `OPENCODE_CONFIG_SYNC_TAR_EXCLUDES`; bypassing the shared
  archive builder can silently transfer dependency trees omitted by the preview.
- Managed SSH readiness is gated by `posixShell` (and `tarExtract` / `providerCredentialsWrite` as needed).
- Prepare (remote or local) writes generational backups under `<backupRoot>/<syncRunId>/` and prunes older than `OPENCODE_CONFIG_SYNC_BACKUP_GENERATIONS`. Failed runs keep their scene until pruned.
- Finalize confirms the run's backup directory exists.
- Run records (Electron `sync-run-store`) persist `direction` alongside `syncRunId` / summary; they are not stored in `settings.json`.
- **Provider keys:** read/write the active OpenCode service through the official V2 credential SDK. API keys and OAuth accounts retain IDs, labels, metadata and active selection. Matching IDs are replaced; other destination accounts remain. No `auth.json`, database copying, environment-key discovery, or credential backups on disk. Failed imports attempt in-memory rollback and report incomplete rollback explicitly. Already-applied config/skill files remain when credentials fail; retry is idempotent for credentials. Process termination cannot guarantee rollback.
- Credential API failures reject rather than becoming empty inventory. Empty successful inventory is `null`. Preview/run records contain metadata only. Transfer envelopes are versioned `opencode-credentials-v1`; only the current protocol is supported.

## HTTP receive protocol (direct / later relay)

Routes under `/api/openchamber/config-sync/*` (global `/api` auth gate: session or clientToken bearer):

| Method | Path | Role |
|--------|------|------|
| POST | `/probe` | Inventory + existence vs plan |
| POST | `/prepare` | Generational local backup + deletes; one inflight `syncRunId` |
| PUT | `/put/:kind?syncRunId=` | tar.gz for `config` / `agents`; versioned credential JSON bytes for selected `credentials` |
| GET | `/download/:kind` | Matching binary payload; `credentials` is never cached |
| GET | `/credentials/inventory` | Current-service credential byte count, without secrets |
| PUT | `/credentials` | Bounded credential import for local pull and SSH-forwarded transfer |
| GET | `/magpie/inventory` | `{ magpie: { available, installed } }`, metadata only; never installs |
| PUT | `/magpie` | Native Magpie restore for local pull and SSH-forwarded transfer; installs missing CLI |
| POST | `/finalize` | Confirm backup generation + success receipt |
| POST | `/abort` | Clear inflight |

`credentials` put requires a selected plan; finalize rejects a missing credential transfer. Concurrent prepare → `sync_in_progress`; credential imports are separately serialized by rejection. Credential routes use the existing global authenticated API gate and sanitize upstream errors.

## Composition

- Electron SSH: `TargetExecutor` push + inventory/tar pull for files; credentials use authenticated HTTP through the established SSH forward.
- Electron direct hosts: `direct-config-sync.mjs` calls these HTTP routes.
- **Relay hosts (ticket 06):** UI opens an E2EE tunnel (`packages/ui/src/lib/relay/relay-config-sync.ts`) and calls the same HTTP routes via `tunnel.fetch`. Target id is `relay:<serverId>` (signing-key fingerprint). Preview/apply refresh candidates and refuse on `serverId` mismatch (`relay_identity_changed`) with no fallback identity. Only explicit sync transports carry credential payloads; ordinary provider UI never receives them.
- Desktop local credential operations go through the local host HTTP routes, resolving its URL/token at call time. This also works when the active backend is an OTA module distinct from installer-owned config-sync code. Web/mobile hosts can receive through the same server; initiating the two-instance wizard remains desktop-only, including for VS Code.

## Magpie discovery and transfer

The existing sync wizard discovers Magpie on the **source** for every preview. A push uses the local host's inventory; a pull uses the selected remote host's inventory (HTTP through the SSH forward, direct, or E2EE Relay). `magpieAvailable` survives selection filtering. The optional `magpie` plan entry is `{ bytes: 0 }` when selected: backup size is unknown until export, not counted as a zero-byte archive. Switching direction clears the Magpie selection and discovers the new source. A selected source disappearing is a failure, never an empty successful sync. This is discovery during the existing explicit sync flow, not a background file watcher.

Discovery checks `MAGPIE_BINARY`, PATH, the user's `.local/bin`, macOS application bundles and Homebrew paths, the standard Windows user installation path, then OpenChamber's managed executable. Symlinks resolve before locating portable data. Installed config honors absolute `XDG_CONFIG_HOME`, otherwise `~/.config/magpie`; portable config follows `.portable` / adjacent `data`, including the macOS app parent and an applicable AppImage directory. A shared Applications/home/download directory's `data` is not adopted over installed config. Providers, settings, profiles, library or plugin config files make the source available even without a CLI. Metadata does not expose paths or secrets. Read errors fail discovery.

Selecting Magpie uses its native `backup` / `restore` with configuration, API keys, profiles, agent models, library and portable plugin declarations. Subscription OAuth and plugin sign-ins are excluded by Magpie itself; the option says so. This does not modify Magpie or copy its login databases. Native provider/group restore merges by ID and does not propagate deletions; settings and library follow Magpie's own restore semantics, retaining machine-local settings. This is a full native bundle, not a provider-only restore.

Missing executables are installed only during selected export/import (including a config-only source), never in preview. The host selects the official pure CLI asset for macOS/Linux/Windows x64/arm64 from `https://usemagpie.ai/api/latest`, verifies SHA-256, checks `--version`, then atomically publishes it under `<OPENCHAMBER_DATA_DIR>/tools/magpie/` (default `~/.config/openchamber`). Existing desktop clients and CLIs are reused. Installation is process-local single-flight, needs no global PATH change or desktop environment, and fails explicitly for unsupported platforms or unverifiable downloads.

The `magpie` transfer kind is a bounded, versioned `magpie-sync-v1` binary JSON envelope carrying an encrypted native backup and a random per-transfer passphrase. Both travel only through the authenticated sync transport; Relay adds its existing E2EE. Passphrases go to child stdin, never argv, run logs or disk. Private temporary directories hold only native encrypted backups and are removed on success/failure. Raw child output is kept local and sanitized before reporting. A zero exit with excluded sign-ins or unavailable agent settings is successful restore with `magpieWarnings` (`sign_in_required`, `agent_settings_skipped`), not a failed transfer. Receipts carry these codes through SSH/direct/Relay and desktop IPC to a localized completion warning. Provider/API-key, plugin-install or library-application failures remain errors with a sanitized reason. CLI failure can leave some native configuration applied; already-applied OpenCode files remain too. Retrying can complete the merge; this is not an atomic cross-application rollback.

`/put/magpie` requires a selected prepared plan and finalize requires its receipt. Standalone `/magpie` is the corresponding authenticated host operation for SSH and local pull. Both use one host-local import/export lock. Desktop main only moves bytes and resolves the local host at call time; the web host owns process execution and installation, including under backend OTA. Web/mobile hosts can receive this operation; the initiating wizard remains desktop-only. No credential values enter previews or sync-run summaries.
