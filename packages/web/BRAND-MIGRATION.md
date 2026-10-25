# Yuri Host identity migration

## Isolated desktop profile hook

`importHostBrandData({ sourceRoot, targetRoot })` is the synchronous explicit-root entrypoint for Electron's existing `prepareDesktopMigration` coordinator. `packages/electron/main.mjs` passes it as `migrateHostData` before the desktop snapshot, origin migration, or storage owners start. Preview/Dev source selection remains entirely with that coordinator; the Host importer does not discover or mix release roots. The importer is installer-owned via the main bundle, not loaded from a selected OTA backend.

It reuses the default importer resource allowlist, SQLite snapshot/validation, credential identity checks, target lock and per-resource receipts. Explicit roots must be absolute, non-overlapping directories and cannot resolve through symlinks. A missing source or failed resource throws; the desktop coordinator cannot return a successful migration plan or initialize an empty replacement Host. Completed unrelated resources and the original source survive for retry. A pre-existing target resource wins, and receipt tombstones prevent a subsequent retry from resurrecting deleted imported state. Target identity conflicts leave old credentials unimported and report `identity-conflict`.

`server/lib/brand-migration-desktop.integration.test.js` calls the real desktop coordinator and Host importer together, covering Preview/Dev selection, active SQLite WAL, credentials, target precedence, deletion/retry semantics, malformed state, missing sources and root validation.

The CLI and in-process Host import `server/lib/brand-migration-bootstrap.js` before storage owners initialize. `brand-migration.js` owns a bounded list of durable Host resources. Default state is `~/.config/yuri`. The two previous default roots are read-only migration inputs during Yuri 2.x. Explicit custom and Preview roots are isolated; custom-root operators must export/import into their selected `YURI_DATA_DIR` while the old Host is stopped.

Existing new resources win. Each imported resource is staged, validated, and committed without overwriting an existing file. SQLite uses `VACUUM INTO` on a read-only connection and `quick_check`, including committed WAL content. The old root is never deleted or rewritten. Each resource gets a completion record so a later user deletion cannot resurrect old data. A process lock excludes concurrent importers; interrupted imports can be retried. Failed resources remain uncommitted, unrelated imports survive, and startup fails before credentials or empty replacement state are created. Fix the failed source or permissions and restart. Identity conflicts are recorded in the migration journal; do not merge credentials into a Host with a different signing identity.

The import includes settings (Relay signing/encryption identity, scheduled-task definitions and runtime state), client-token hashes, JWT secret, passkeys, push bindings, Git identities, projects, quota credentials, assistants, managed assistant workspaces, goal files, folders/order, persistent message queue, session index, transcript cache and prompt attachments. One-time pairing sessions, process registries, locks, logs and temporary state are excluded. User content is copied byte-for-byte, never string-rebranded. Symlinks require manual import. Stop the old Host before switching writers; SQLite snapshots provide consistency but do not merge future writes from the old process. Absolute historical workspace paths remain historical paths, and old workspace sources are retained.

New tokens use `yuri_client_`; existing hashes still authenticate their original tokens during Yuri 2.x, without changing grants, TTL or revocation. UI cookies and short-lived URL tokens use Yuri names and require a new login/token mint. New deep links use `yuri://`, Host-owned routes use `/api/yuri`, and URL authentication uses `yuri_url_token`. Host, UI, native bridge and Relay crypto labels must ship together. No old CLI bins or Host API route aliases are exported. App shells retain receive-only legacy deep-link schemes; this does not change Host routes, pairing validation or link generation.

## Exact legacy exceptions

Owner: Host/storage maintainers. Exit: remove in Yuri 3 only after the import/export migration window and credential re-pairing are completed.

| Location | Allowed value | Purpose |
| --- | --- | --- |
| `server/lib/brand-migration.js`, `LEGACY_ROOT_NAMES` | `openchamber`, `openchambery` | Read-only default-root discovery and resource journals |
| `server/lib/brand-migration.test.js`, fixture root | `openchamber` | Real disk migration regression coverage |
| `server/lib/brand-migration-desktop.integration.test.js`, old profile fixtures | `OpenChamber`, `openchamber-data` | Exercise the actual desktop coordinator's isolated Host callback and release-profile exclusion |
| `server/lib/client-auth/remote-clients.js`, credential validator | `oc_client_` | Authenticate migrated token hashes without modifying token bytes |
| `server/lib/client-auth/remote-clients.test.js`, legacy credential fixture | `oc_client_` | Verify hash authentication, tamper rejection and revocation after migration |
| `server/lib/session-turn-pages/service.js`, divider predicate | `oc_asst_session_divider:` | Recognize stored transcript divider IDs; never rewrite user history |
| `server/lib/opencode/core-routes.js`, retired-route gate | `/api/openchamber` | Return HTTP 426 with `YURI_CLIENT_UPGRADE_REQUIRED`, never serve SPA/proxy success to old clients |
| `server/lib/opencode/core-routes.test.js`, retired-route request | `/api/openchamber/relay/status` | Exercise the HTTP 426 mixed-version boundary |
| `server/lib/session-metadata/session-projection.js`, owned metadata normalizer | `metadata.openchamber` | Read existing OpenCode session metadata only when the new namespace is absent; preserve the source |
| `server/lib/session-metadata/session-projection.test.js`, legacy namespace fixture | `openchamber` | Verify old archive/goal visibility and authoritative new state without mutating old records |
| This table | The exact legacy values above | Auditable exception documentation |

## Assets and external resources

`scripts/build-brand-icons.py <approved-vector-B-export-directory>` regenerates all Web favicon, PWA and light/dark assets from the approved vector-B SVG/PNG exports. The provided SVG remains vector paths; no raster is embedded.

`@yuri/web`, `@yuri/relay-server`, `yee94/yuri`, and native `com.yee94.yuri` are release candidates, not verified remote identities. Configure `YURI_RELAY_URL` explicitly; no replacement hosted domain is assumed. This change does not deploy services, publish packages or register native identities. Actual installation, browser-origin transfer and remote transport acceptance remain platform/release validation requirements.

Update service and TestFlight links are provided by `YURI_UPDATE_API_URL` and `YURI_TESTFLIGHT_PUBLIC_URL`; otherwise the candidate Yuri repository release page is used. GitHub Device Flow requires `YURI_GITHUB_CLIENT_ID` or an explicitly saved `githubClientId`; there is no inherited OAuth application ID. Existing token/gh CLI login remains available.
