# VS Code Backend Modules

This document describes backend runtime modules used by the VS Code extension bridge (`packages/vscode/src/bridge.ts`).

## Purpose

Keep `bridge.ts` as a thin orchestration layer that delegates message handling to cohesive domain runtimes while preserving API behavior.

## Runtime modules

- `bridge.ts`
  - Entry orchestration layer for bridge messages.
  - Delegates to specialized runtimes in order and handles only unmatched fallthrough cases.

- `bridge-git-runtime.ts`
  - Standard Git message handlers.

- `bridge-git-special-runtime.ts`
  - Specialized Git flows (`pr-description`, `conflict-details`) and generation helpers.

- `bridge-git-process-runtime.ts`
  - Git process execution and environment setup (`execGit`), including SSH agent socket resolution.

- `bridge-fs-runtime.ts`
  - Bridge handlers for filesystem-related message routes.
  - Uses shared FS helpers via injected dependencies.

- `bridge-fs-helpers-runtime.ts`
  - Filesystem/path/search helper functions:
    - path normalization and resolution
    - directory listing
    - file search
    - file read path safety checks
    - dropped-file parsing and attachment reading
    - models metadata fetch helper

- `bridge-localfs-proxy-runtime.ts`
  - Local `/api/fs/read` and `/api/fs/raw` proxy helpers and shared proxy utility helpers.
  - Optional file reads signal existence through `x-openchamber-file-exists` while preserving plain-text bodies.

- `bridge-proxy-runtime.ts`
  - Proxy route handlers (`api:proxy`, `api:session:message`) with injected helper dependencies.

- `bridge-config-runtime.ts`
  - Config and skills message handlers (`api:config/*`).
  - Includes OpenCode resolution diagnostics parity handler used by shared UI (`/api/config/opencode-resolution`).
  - Skills list, detail/CRUD, files, catalog, scan, and install requests carry the
    webview directory hint. Directory-sensitive handlers resolve that payload at
    call time, so project-scoped skills match the shared UI query directory.
  - Provider catalogs are projected through the Extension Host safe-field allowlist
    before they reach the webview.
  - Skill `summary=true` and command metadata `{ catalog: true }` requests return
    compact autocomplete contracts without skill content, sources, or command templates.

- `bridge-settings-runtime.ts`
  - Settings read/write, OpenCode skills discovery, and provider catalog API access for bridge consumers.
  - Full settings responses use an explicit non-sensitive DesktopSettings allowlist and expose stored tunnel and summary credentials only through their `has*` indicators.

- `settings-visible-runtime.ts`
  - Pure formatter for the full settings response allowlist and credential-presence indicators.

- `settings-bootstrap-runtime.ts`
  - Projects the bounded, secret-free settings bootstrap contract at the Extension Host boundary.
  - Validates bootstrap STT URLs as credential-free HTTP(S) URLs and restricts transport, STT provider, and response-style values to their supported enums.

- `provider-catalog-runtime.ts`
  - Pure bounded provider catalog projection at the Extension Host trust boundary.
  - Rejects malformed top-level responses and marks isolated invalid entities as partial.
  - Limits providers, models, defaults, and variants; validates identifiers and scalar bounds; and emits null-prototype dictionaries for dynamic catalog maps.
  - Requires a non-empty bridge directory and treats SDK errors as catalog failures before projection.

- `bridge-system-runtime.ts`
  - System/editor/provider/quota/notification/update-check message handlers.
  - Includes session activity snapshot bridge handler used by webview parity routes (`/api/session-activity`).
  - Includes Zen utility model parity handler used by shared notification settings (`/api/zen/models`).

## Extension guideline

The VS Code webview returns `501 { code: 'unavailable' }` for the message-queue
server route family. This explicit response precedes the generic OpenCode proxy,
so shared UI worktree-order synchronization exits cleanly in this runtime.

The exact `GET /api/config/settings/bootstrap` webview route dispatches to
`api:config/settings:bootstrap` before the generic settings route. The legacy
`GET /api/config/settings?bootstrap=true` form remains supported.

When adding new bridge route families:

1. Prefer creating or extending a domain runtime module under `packages/vscode/src/bridge-*-runtime.ts`.
2. Keep `bridge.ts` focused on delegation order and minimal fallthrough behavior.
3. Inject dependencies into runtimes instead of reaching into unrelated modules directly.
