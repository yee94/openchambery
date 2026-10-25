# Yuri extension migration

The candidate identity is `yee94.yuri`. Publisher ownership, marketplace availability and the candidate repository `yee94/yuri` have **not** been verified. Do not publish until verified. Install a locally built VSIX for validation.

## Configuration

1. Keep the previous extension installed until you have saved unsent drafts, exported any settings it supports and backed up its data. Disable it before starting Yuri to avoid two managed OpenCode processes.
2. Run **Yuri: Import Legacy Configuration**. This explicit command reads only `openchamber.apiUrl` and `openchamber.opencodeBinary` from VS Code's public configuration API. It copies each key's winning explicit workspace/global value to the corresponding Yuri key at the same scope. Any explicit Yuri value, including empty strings, wins. Source values are never removed; invalid values and failed writes are reported, independent successes remain, and retry is idempotent.
3. Review `yuri.apiUrl` before reconnecting. URLs containing credentials, query strings or fragments are rejected; enter a clean endpoint and authenticate separately. Reload the window to apply the imported configuration.
4. Folder-specific, language-specific and other profiles/remote hosts are not imported by this command. Review those settings manually in each VS Code profile/remote environment; rebind custom shortcuts to `yuri.*` commands.

## Private state and credentials

Changing publisher/name creates a different extension identity. VS Code's `SecretStorage`, `globalState`, `workspaceState`, webview origins and storage are isolated by identity. Yuri does **not** read another extension's secrets or its private state database. Re-enter credentials or pair/authenticate again. Do not copy encryption records, one-time pairing secrets or active process registrations.

The previous extension is `fedaykindev.openchamber`; keep its private storage backup for recovery. Session history belongs to OpenCode and remains available when reconnecting to the same engine and project. This does not imply recovery of unsent drafts, webview attachments, private settings, panel state or archive metadata stored only under the previous extension identity. Save/export those from the old installation before uninstalling. No automatic private-state import is currently provided; keep the old installation available until those items have been recovered manually.

Shared Host files under `~/.config/openchamber` are a separate migration owned by the Host. Use that documented migration before relying on the shared settings file in `~/.config/yuri`; do not overwrite a populated Yuri directory or copy a live SQLite database. This extension's configuration command does not migrate those files.

## Runtime and release contracts

- Shared UI dependency: `@yuri/ui`; host helpers and UI must be built from the same Yuri revision.
- Commands/views/settings/storage keys, bridge globals/events, own routes and headers use `yuri`/`YURI`/`Yuri` (`/api/yuri`, `x-yuri-*`). Opaque page cursors retain `oc1.` to match the shared Host wire contract; this is not a product identity. Reload old webviews together with the Host/UI upgrade.
- Update checks require `YURI_UPDATE_API_URL`; no guessed production domain is used. Prerelease extension versions request the beta channel.
- Activity/titlebar/loading/marketplace icons derive from the supplied final B monochrome silhouette SVG. This final supplied asset supersedes the older issue's vortex description. The previous screenshot is replaced by a brand illustration, not presented as runtime evidence.
- Validate a real Extension Development Host and VSIX install, light/dark/high-contrast icons, configuration import/reload and reconnect before release. Unit tests and bundles alone do not prove platform migration.

## Exact legacy-name exceptions

| Location | Purpose | Owner / exit condition |
| --- | --- | --- |
| `LICENSE`, copyright line | Original MIT attribution | Legal; retain permanently |
| `src/brand-migration.ts`, `LEGACY_CONFIGURATION_SECTION` | Explicit public-configuration reader only | VS Code maintainers; remove in the next major release after the migration window |
| `src/session-turn-page-runtime.ts`, `oc_asst_session_divider:` | Read existing persisted assistant divider IDs without treating them as authored turns | Host/VS Code maintainers; remove only after retained history has been migrated |
| `src/session-turn-page-runtime.ts`, `HOST_CURSOR_PREFIX`; turn-page tests and `src/DOCUMENTATION.md`, `oc1.` | Shared versioned opaque Host cursor protocol | Host/VS Code maintainers; replace only in a coordinated protocol revision |
| This document: old configuration keys, extension ID and Host directory | Recovery instructions and audit mapping | VS Code maintainers; archive when the migration command is removed |

No production default writes to the legacy namespace.

## Local validation evidence (2026-10-25)

- VS Code package test suite: 40 files / 313 tests passed, including non-destructive import, invalid legacy values, retry and idempotence.
- Root workspace mode also passed: `bunx vitest run --project yuri-vscode` (40 files / 313 tests). The three SDK-mocking regression files separately passed in root mode (38 tests); their mocks use `vi.hoisted` / `vi.mock`, preserving the original SDK payload and lifecycle assertions.
- Package type-check passed (extension host and shared webview). Lint: 0 errors, 19 existing path-normalization warnings.
- Full extension/webview build and local VSIX packaging passed, version `2.1.10-beta.11`, identity `yee94.yuri`.
- VSIX inspection confirmed `@yuri/ui`, all three packaged icon assets byte-identical to source, and no old-brand filenames. Remaining old-brand content is the MIT copyright, this migration guide, the explicit configuration reader and the shared UI's storage migration reader.
- Docs validation: 369 pages and 41 sidebar links passed.
- Repository dead-code scan ran; its non-blocking report treats the VS Code extension entrypoint as unused and consequently reports its reachable exports (including the imported migration section). No reachable extension code was removed to silence that configuration limitation.
- Not validated: real Extension Development Host/VSIX installation, cross-identity private-state recovery, editor icon rendering at small sizes, marketplace ownership, remote repository/website deployment or update-service operation. No publishing was performed.
