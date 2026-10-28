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
| `magpie-auth.js` | Bounded portable authorization export, plugin-store merge and account verification |
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

Within one direction, scope changes retain the displayed preview and discovered options while refreshing. Preview requests are serialized, superseded queued selections are skipped, and stale completions cannot replace the latest review. Apply stays disabled until the latest selection snapshot is confirmed. Closing or changing the target invalidates pending results. The dialog expands naturally with its content, without a fixed height or nested scrolling body/list; only the shared dialog's viewport overflow protection remains. Static help and the footer do not depend on preview loading.

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

Routes under `/api/yuri/config-sync/*` (global `/api` auth gate: session or clientToken bearer):

| Method | Path | Role |
|--------|------|------|
| POST | `/probe` | Inventory + existence vs plan |
| POST | `/prepare` | Generational local backup + deletes; one inflight `syncRunId` |
| PUT | `/put/:kind?syncRunId=` | tar.gz for `config` / `agents`; versioned credential JSON bytes for selected `credentials` |
| GET | `/download/:kind` | Matching binary payload; `credentials` is never cached |
| GET | `/credentials/inventory` | Current-service credential byte count, without secrets |
| PUT | `/credentials` | Bounded credential import for local pull and SSH-forwarded transfer |
| GET | `/magpie/inventory` | `{ magpie: { available, installed } }`, metadata only; never installs |
| PUT | `/magpie` | Magpie config/authorization restore and verification for local pull and SSH-forwarded transfer; installs missing CLI |
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

Discovery checks `MAGPIE_BINARY`, PATH, the user's `.local/bin`, macOS application bundles and Homebrew paths, the standard Windows user installation path, then Yuri's managed executable. Symlinks resolve before locating portable data. Installed config honors absolute `XDG_CONFIG_HOME`, otherwise `~/.config/magpie`; portable config follows `.portable` / adjacent `data`, including the macOS app parent and an applicable AppImage directory. A shared Applications/home/download directory's `data` is not adopted over installed config. The source is available only when a verified CLI is installed and providers, settings, profiles, library, plugin config or authorization stores exist. Leftover config without an installed CLI does not expose the sync option. Magpie's checkbox and explanatory copy form a separate conditional group, default unchecked; general OpenCode sync copy remains independent. Metadata does not expose paths or secrets. Read errors fail discovery.

Selecting Magpie uses its native `backup` / `restore` with configuration, API keys, profiles, agent models, library and portable plugin declarations. Native provider/group restore merges by ID and does not propagate deletions; settings and library follow Magpie's own restore semantics, retaining machine-local settings. This is a full native bundle, not a provider-only restore.

The v2 envelope additionally carries recognized plugin API/OAuth accounts and self-contained saved Codex credentials. The source CLI account inventory limits export to recognized providers; hidden and orphaned plugin sign-ins are excluded. Plugin accounts merge by their native account key into `plugin-auth.json` under Magpie's exclusive-create lock, using a private atomic replacement. Destination-only accounts remain; repeated transfers do not append duplicates. Codex uses native `accounts import codex --yes`, which owns account identity/deduplication and the OS-level `logins.json` lock. Yuri never writes `logins.json` or copies machine-local account homes. A spent or expired ChatGPT refresh token can make the native Codex import exit non-zero even when the destination already holds that account; import then continues and the post-transfer `accounts --json` inventory decides success. Other subscription formats and accounts discovered only from external clients are not inferred or silently treated as transferred: unsupported active source accounts produce `sign_in_required`. An import re-reads `accounts --json` and requires all transferred plugin account counts and Codex identities to be recognized before returning success. Plugin diagnostics on stderr are ignored when recovering the top-level JSON array from the merged CLI streams. This checks discovery, not successful model inference or future token renewal; revoked credentials still require login.

Codex rejection exception: only exit code 1 with the native `ChatGPT didn't take the refresh token` diagnostic is skippable. That account is excluded from required identity verification, subsequent accounts continue, and the receipt always includes `sign_in_required`, even if the destination already recognizes the account. All other import failures (including network errors, timeouts and filesystem errors) still abort. Raw CLI output is never included in the classified error. This exception supersedes the inventory-only success rule above; all non-rejected accounts still require verification.

Missing destination executables are installed only when Magpie is explicitly selected for import, never in preview or ordinary OpenCode sync. The host selects the official pure CLI asset for macOS/Linux/Windows x64/arm64 from `https://usemagpie.ai/api/latest`, verifies SHA-256, checks `--version`, then atomically publishes it under `<YURI_DATA_DIR>/tools/magpie/` (default `~/.config/yuri`). Existing desktop clients and CLIs are reused. Installation is process-local single-flight, needs no global PATH change or desktop environment, and fails explicitly for unsupported platforms or unverifiable downloads.

Selected sync also publishes `~/.local/bin/magpie` (`magpie.exe` on Windows), a path searched explicitly by `opencode-magpie-plugin`. POSIX uses a symlink, Windows a hard link for installed-mode data and a symlink for portable data; unsupported linking fails explicitly. Existing valid user commands using the same data directory are retained; conflicting/broken entries are not overwritten. Shared-service and private OpenCode startup repair the command entry for an already managed CLI before launching OpenCode; they never download Magpie just because Yuri starts. SSH/direct/Relay push and pull apply Magpie before OpenCode config archives, preventing a newly synced plugin from loading before its dependency is installed. Native agent settings skipped before sign-in are retried after authorization succeeds.

The `magpie` transfer kind exports a bounded `magpie-sync-v2` JSON envelope containing the encrypted native backup, a random per-transfer passphrase and portable authorizations. The envelope is sensitive and stays in memory on authenticated sync transports; Relay adds its existing E2EE. New receivers accept old `magpie-sync-v1` config-only envelopes with the original warning behavior; old receivers reject v2 rather than silently discarding its accounts. Upgrade both hosts for authorization sync. Validate the entire envelope before installation or restore. Passphrases go to child stdin, never argv, run logs or disk. Private temporary directories hold native encrypted backups and, during native Codex import only, a mode-0600 credential file; both are removed on success/failure. Raw child output is sanitized before reporting. A zero exit with genuinely missing/unsupported sign-ins, unavailable agent settings, or plugins that Magpie could not install returns `magpieWarnings` (`sign_in_required`, `agent_settings_skipped`, `plugin_install_failed`). Plugin-install failures no longer abort the transfer: remaining configuration and accounts continue, verification skips accounts for plugins that never appeared on the destination, and the receipt warns. The sign-in warning is recomputed after authorization transfer, not copied from the pre-transfer native restore. Receipts carry these codes through SSH/direct/Relay and desktop IPC to localized completion warnings. Provider/API-key, library and other account-import failures remain errors. CLI failure can leave configuration and earlier accounts applied; retry merges idempotently. There is no cross-application rollback, and process termination can interrupt cleanup.

`/put/magpie` requires a selected prepared plan and finalize requires its receipt. Standalone `/magpie` is the corresponding authenticated host operation for SSH and local pull. Both use one host-local import/export lock. Desktop main only moves bytes and resolves the local host at call time; the web host owns process execution and installation, including under backend OTA. Web/mobile hosts can receive this operation; the initiating wizard remains desktop-only. No credential values enter previews or sync-run summaries.
