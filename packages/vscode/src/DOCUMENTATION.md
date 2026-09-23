# VS Code Backend Modules

This document describes backend runtime modules used by the VS Code extension bridge (`packages/vscode/src/bridge.ts`).

## Purpose

Keep `bridge.ts` as a thin orchestration layer that delegates message handling to cohesive domain runtimes while preserving API behavior.

## Runtime modules

Skill discovery uses the official V2 `skill.list` SDK with the selected directory and projects `id`/`path` onto the shared catalog's `name`/`path`. Local skill discovery also keys by path-derived ID. Combined first-message requests validate `skills: [{ id }]` and forward them as native prompt attachments, matching the Web/Electron/mobile route.

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

- `bridge-localfs-proxy-runtime.ts`
  - Local `/api/fs/read` and `/api/fs/raw` proxy helpers and shared proxy utility helpers.
  - Optional file reads signal existence through `x-openchamber-file-exists` while preserving plain-text bodies.

- `reasoning-projection.ts`
  - OpenChamber outbound reasoning projection (`includeReasoning=false`, strict
    string only). HTTP snapshot helpers + per-connection stateful SSE filter.
  - Drops `type=reasoning` parts, reasoning deltas, unknown part deltas, and
    `session.next.reasoning.*` (dispatch strips terminal `.N` version suffixes;
    kept events preserve original `type`). Keeps `tokens.reasoning`. Never mutates
    inputs; never forwards the query param to OpenCode. SSE splitter holds a
    trailing CR so CRLF across chunks cannot split one event.
  - Used by `sseProxy.ts`, `bridge-proxy-runtime.ts`, and
    `bridge-session-turn-page-runtime.ts`. Internal watchers stay full-fidelity.

- `sseProxy.ts`
  - Extension Host SSE proxy to OpenCode v2 `/api/event` and `/api/global/event`.
  - Legacy `/event` forms are rewritten to `/api/*` before joining the sidecar
    origin so upstream never loses the v2 prefix.
  - Reads `includeReasoning` from the webview path query; strips it before the
    upstream OpenCode fetch. When `'false'`, parse-filters SSE blocks before
    `api:sse:chunk` postMessage, and emits `:heartbeat\n\n` every 10s while no
    downstream chunk was sent (keeps the webview 30s SSE idle timeout alive
    during pure-reasoning upstream).
  - Always composes Host session lifecycle projection (`session.created` /
    `session.updated` archive authority) onto outbound blocks when the session
    metadata store is loaded; registers each stream with `host-sse-fanout` for
    Host-injected archive events.
  - Every `connect` / socket-reconnect awaits
    `ensureSessionMetadataReadyForOutboundSse` (signal-aware) **before**
    upstream `fetchSseResponse`. Unconfigured store skips the gate; wired-but-
    unavailable failures use the existing exponential reconnect path. Abort /
    runtime switch during the wait never opens a late upstream stream.

- `opencode-ready.ts`
  - `waitForApiUrl` returns an origin only while `status === 'connected'` (after
    verified-band sidecar admission). **Deadline returns `null`** — never falls
    back to pre-ready `getApiUrl()`.
  - `resolveConnectedApiUrl` / `isOpenCodeExecutionPermitted` re-check the current
    instance permit at write dispatch time.

- `bridge-proxy-runtime.ts`
  - Proxy route handlers (`api:proxy`, `api:session:message`) with injected helper dependencies.
  - Execution writes (`prompt`, `message`, …) re-check the current connected
    permit immediately before upstream fetch; interrupt/abort and reads keep the
    waited URL path. Status leaving `connected` after wait must not forward writes.
  - `ensureOpenCodeApiUpstreamPath` restores the v2 `/api` prefix for bare root
    paths; webview local OpenChamber routes still win before this generic proxy.
  - Exact `GET /api/session/:sessionID/message/:messageID` responses are L1-projected
    (`summary.diffs` → thin `{ file, status?, additions, deletions }[]` plus
    additive `diffCount` / `hasDiffs`) on the Extension Host before the payload
    enters the webview. Full `parts` behavior is preserved unless
    `includeReasoning=false` (then `type=reasoning` parts are removed after L1).
  - Official `GET /api/session/:sessionID/message` list responses apply the same
    reasoning strip when `includeReasoning=false`. The param is stripped before
    OpenCode upstream.
  - OpenChamber-owned question auto-delegate routes and precise
    `/question/:id/reply|reject` claim intercepts are handled here via
    `tryHandleQuestionAutoDelegateProxy` **before** OpenCode upstream, so the
    shared UI can keep using `runtimeFetch` without new `RuntimeAPIs` fields.
  - OpenChamber-owned session metadata + Host archive routes
    (`PUT /openchamber/sessions/:id/metadata|archive`) and GET session list/detail
    Host overlay run via `tryHandleSessionMetadataProxy` /
    `overlaySessionProxyBodyText` before or after upstream as appropriate.

- `session-metadata-runtime.ts`
  - Extension Host authority for per-session Host metadata and archive stamps.
  - Imports shared core from `packages/web/server/lib/session-metadata/`
    (store, archive service, projection) — do not vendor copies.
  - Durable file under extension `globalStorage` (or `OPENCHAMBER_DATA_DIR` /
    `~/.config/openchamber`), scoped by OpenCode runtime identity
    (`loopback:` vs external `host:port`) so multi-webview clients share one store
    while runtime switches isolate data (generation bumps drop late IO/broadcast).
  - Upstream archive `session.get` builds
    `buildUpstreamSessionGetUrl(origin, id)` → `/api/session/:id` (origin-only
    `getApiUrl()` never hits bare `/session/:id`). Base ending in `/api` is
    normalized once.
  - `PUT .../archive` body `{ archivedAt: number, directory? }` → `{ session, index? }`
    with Host `metadata.openchamber.archive.archivedAt` projected onto
    `time.archived` (positive = archive, `0` = explicit unarchive, missing =
    fall back to upstream). Successful archive broadcasts full `session.updated`
    via sinks + active SSE inject.
  - GET `/session` list + GET `/session/:id`: when Host store is wired,
    `resolveSessionProxyOverlay` folds committed metadata; load/read failure →
    **503** `{ code: session_metadata_unavailable, retryable: true }` (never
    silent un-overlaid upstream that clients treat as authoritative empty Host).
  - SSE lifecycle (`session.created|updated|deleted` + `.v2` suffixes,
    `properties.info` / `data.info`): until `isHostSessionMetadataReady()`,
    lifecycle frames are suppressed (`hostReady: false`); message paths stay open.
  - `waitForSessionMetadataReady` / `ensureSessionMetadataReadyForOutboundSse`
    (watcher + **webview `openSseProxy` connect/reconnect**) block until committed
    load `{ ok: true }` or timeout; unconfigured store skips the SSE gate; load
    `{ ok: false }` (corrupt) stays unavailable with background retry — avoids
    permanently missing unique lifecycle frames during a cold unknown window.
  - Successful `DELETE /session/:id` (bridge) + `session.deleted(.v2)` events run
    idempotent `forgetSession` cleanup.

- `host-sse-fanout.ts`
  - Thin registry of active webview SSE chunk emitters so Host-owned events
    (archive `session.updated`) reach every open `openSseProxy` stream.

- `question-auto-delegate-runtime.ts`
  - Extension Host authority for automatic question handling (default on,
    30s fixed reply). Imports the single source-of-truth core from
    `packages/web/server/lib/question-auto-delegate/core.js` (+ sibling `core.d.ts`).
  - IO talks to OpenCode **directly** (never loops Host `/question/*`).
  - Snapshot tip: `openchamber:question-auto-delegate-changed` with
    `{ epoch, revision }` only — webviews invalidate `GET /api/question-auto-delegate`.
  - Settings field `questionAutoDelegateEnabled` (boolean, default true/absent⇒on):
    persist via existing settings save; `applyEnabled` only after successful write.

- `sessionActivityWatcher.ts`
  - Global OpenCode event singleton (extension-level). Preserves directory on
    the raw envelope for question auto-delegate + session activity.
  - On connect/reconnect runs pending reconcile across workspace folders,
    settings projects/pinned dirs, working directory, and observed event dirs
    (background/subagent sessions keep timers even when no webview is open).
  - Same-upstream OpenCode disconnect **suspends** the SSE loop only
    (`suspendGlobalEventWatcher`) — QAD core, pause/claim/uncertain, and
    activity maps stay. Full `stopGlobalEventWatcher` (dispose core) runs on
    extension deactivate or when `start` detects a different OpenCode endpoint.
  - Multi-sink broadcast (`addGlobalEventMessageSink`) fans host tips to chat,
    agent manager, and session editor providers.

- `session-turn-page-runtime.ts`
  - Pure turn-window aggregation over official OpenCode `session.messages` pages.
  - Exports `isUserAuthoredTurnBoundary`, `selectTurnRecords`,
    `encodeHostCursor` / `decodeHostCursor`, `projectSlimParts`,
    `projectMessageSummaryDiffCounts`, `projectExactMessagePayload`,
    `SLIM_PARTS_PROJECTION`, and
    `createSessionTurnPageService({ fetchPage, maxScanPages?, maxScanMessages? })`.
  - Turn-page `slim-v1` projection is Host-parity (first packet and prepend): message
    `summary.diffs` is kept as a thin L1 file list (`file` / `status?` /
    `additions` / `deletions` only; no patch bodies) with additive markers
    `diffCount` / `hasDiffs`; tool / reasoning / file summaries after
    `selectTurnRecords`. Slim tools
    keep short locator input
    (path / pattern / query / command / `subagent_type` / `description` / skill `name` / `id`),
    `metadata.sessionId`, skill `metadata.name`, and edit `additions`/`deletions`, and drop result bodies. Slim `file` parts keep identity, mime,
    filename, and size metadata only — never `url` or base64. Clients must
    hydrate the full message by `messageID` before rendering or editing an
    attachment.
  - OpenCode pages are chronological (oldest → newest); older pages are prepended
    with info.id dedupe (no reverse). Missing `info.id` → explicit `upstream` error.
  - Client-facing `cursor` is an opaque Host token (`oc1.` + base64url JSON) with
    `{ before, boundaryID }`: `before` is the upstream request cursor of the page
    that held the earliest selected authored user boundary; `boundaryID` is that
    message id. Raw OpenCode cursors on the first request pass through unchanged.
  - Resuming with a Host token re-fetches the origin page with the decoded raw
    `before`, keeps only records strictly older than `boundaryID`
    (`slice(0, index)`), then continues with raw `nextCursor` until the turn
    budget is met. Malformed token, missing boundary, or `before` over 4096 chars
    → `invalid_cursor` (no partial records).
  - `complete` is true only when upstream is exhausted and
    `selected.length === accumulated.length` (no overscan trim). When incomplete,
    cursor encodes the earliest selected authored user origin.
  - Authored user turn boundary excludes fully synthetic, subtask, compaction, and
    hosted session dividers; empty user parts still count.
  - Hard scan caps: 50 pages / 5000 messages; no partial success on stall or cap.

- `bridge-session-turn-page-runtime.ts`
  - Bridge handler for `api:session-turn-page`.
  - Reads OpenCode base URL + auth from the manager and requests OpenCode v2
    `/api/session/:id/message?limit=`: first page adds `order=desc`, continuation
    adds only `cursor=<raw upstream cursor>` (upstream 400s on both; Host tokens
    are decoded in the aggregator and never forwarded). Reads
    `{ data, cursor: { next } }`, reverses `data` to old→new, projects native
    rows to `{ info, parts }` through the web
    `session-turn-pages/session-message-projection.js` module (control rows
    dropped; a non-v2 body fails as `upstream`), and returns unified
    `{ records, cursor, complete, turnCount, partsProjection }` where `cursor`
    is an opaque Host token when history remains. `partsProjection` is
    `slim-v1` on every turn-page response (first packet and prepend).
  - Optional payload `includeReasoning` (from webview query): only strict
    `'false'` drops entire `type=reasoning` parts after slim-v1; keeps
    `tokens.reasoning`. Missing/other values keep slim reasoning identity.
  - Maps `invalid_cursor` to a safe client error string; never logs message
    contents, tokens, or secrets.
  - Whole aggregation uses a 45s AbortController timeout (signal forwarded; cleared
    in `finally`).
  - Delegated from `bridge.ts` before the generic proxy handler.

- `session-turn-changes-runtime.ts`
  - Pure L2/L3 helpers matching web host `changes.service.js`.
  - L2: project `summary.diffs` → `{ files: [{ file, status?, additions, deletions }] }`.
  - L3: exact `file` match from official `session.diff` → `{ diff }`.

- `bridge-session-turn-changes-runtime.ts`
  - Bridge handler for `api:session-turn-changes`.
  - L2 uses official legacy `/session/:id/message/:messageID`; L3 uses
    `/session/:id/diff?messageID=`. Extension Host filters before returning to
    the webview. Delegated from `bridge.ts` before the generic proxy handler.

- `bridge-config-runtime.ts`
  - Config and skills message handlers (`api:config/*`).
  - V2 Agent/Command/MCP/Plugin/Skill and AGENTS.md writes no longer call
    `manager.restart()`. Mutation receipts describe persistence (`application:
    'watch'`), not confirmed activation. OpenCode domain events refresh the shared
    webview Query data. Raw OpenCode config saves do not prompt for restart;
    opaque plugin-owned configs retain manual restart guidance.
  - The explicit webview reload command uses SDK `location.reload`. The legacy
    `api:config/reload` bridge remains a process restart capability for binary
    changes and startup recovery, not ordinary configuration writes.
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

- `opencode-sidecar.ts`
  - Shared OpenCode 2 sidecar contract used by the extension host (same parse/health rules as web).
  - Auto-discovery looks only for the official `opencode` executable (PATH, `~/.bun/bin/opencode`, `~/.opencode/bin/opencode`, Homebrew, and Windows install locations).
  - Admission uses `--version`, not basename: 2.x is accepted and an explicitly configured 1.x binary fails with `OPENCODE_BINARY_INVALID`.
  - Listening accepts `server listening on http://…` and the legacy `opencode server listening on …` line.
  - Health probes `GET /api/health` first, then `/global/health`, with Basic auth (username `opencode`). Admission requires `healthy: true` and a non-1.x version string; 1.15.0-style bodies fail closed. The password is never written to logs.
  - V1 migration gate (`GET /api/experimental/migration/v1`): `required` / `running` / `error` block transcript readiness; `completed` or HTTP 404 admit. Managed and external starts both wait on this gate; dispose/stop aborts an in-flight wait.

- `bridge-system-runtime.ts`
  - System/editor/provider/quota/notification/update-check message handlers.
  - Includes session activity snapshot bridge handler used by webview parity routes (`/api/session-activity`).
  - Includes Zen utility model parity handler used by shared notification settings (`/api/zen/models`).
  - `api:opencode/version` reads version from the sidecar health probe (`/api/health`, then `/global/health`) with the manager's Basic auth headers.

## Webview local notification gate

Ordinary VS Code native notifications are decided in the webview
(`webview/main.tsx` listening for `openchamber:vscode-notification-event`), not
on the Extension Host. Session eligibility is pure logic in
`webview/notificationSessionFilter.ts` (`shouldSkipVSCodeNotificationSession`):

- Skip missing sessions and any session with a non-empty `parentID` (child /
  subagent).
- Skip system-owned sessions by authoritative OpenChamber metadata only:
  non-empty `smallModel.purpose`, non-empty `llm.purpose` (LLM gateway
  throwaways), non-empty `scheduledTask.taskID`, and non-empty
  `assistant.assistantID` unless `assigned.from === 'contact'`.
- Contact-assigned worker sessions stay eligible and still notify.
- Empty `smallModel.purpose` / `llm.purpose` strings do **not** hide a session
  (same contract as Host `notifications/runtime.js` and UI
  `globalSessions.isSystemOwnedSession`).

## Extension guideline

The VS Code webview returns `501 { code: 'unavailable' }` for the message-queue
server route family. This explicit response precedes the generic OpenCode proxy,
so shared UI worktree-order synchronization exits cleanly in this runtime.

Session turn-page (`GET /api/openchamber/sessions/:sessionID/messages`) is an
OpenChamber-owned webview route (`webview/sessionTurnPageRoute.ts`). It is
matched ahead of the generic OpenCode proxy, validates `turns` (1..10) and
`scanLimit` (10..200), forwards optional `includeReasoning` query to the bridge,
dispatches `api:session-turn-page` to the Extension Host, and returns the same
unified JSON contract as the web host module
(`packages/web/server/lib/session-turn-pages/`), including opaque Host cursors
(`oc1.` tokens). Non-GET → 405; illegal query → 400.

Reasoning projection (`includeReasoning=false`) is per webview request/SSE
stream on the Extension Host send boundary (parity with web Host
`event-stream/reasoning-projection.js`). Internal watchers stay full-fidelity.
VS Code does not implement transcript-cache read or messages/reconcile routes;
those remain Host-only when present.

Session turn-changes (`GET /api/openchamber/sessions/:sessionID/changes`) is an
OpenChamber-owned webview route (`webview/sessionTurnChangesRoute.ts`). It is
matched ahead of the generic OpenCode proxy, requires `messageID`, optionally
accepts `file` and `directory`, dispatches `api:session-turn-changes`, and
returns `{ files }` (L2) or `{ diff }` (L3). Non-GET → 405; illegal query → 400.

The exact `GET /api/config/settings/bootstrap` webview route dispatches to
`api:config/settings:bootstrap` before the generic settings route. The legacy
`GET /api/config/settings?bootstrap=true` form remains supported.

## Session metadata + Host archive (Extension Host)

Contract source of truth (do not vendor/copy):
`packages/web/server/lib/session-metadata/` (`session-metadata-store.js`,
`session-archive.js`, `session-projection.js`, `routes.js`, `DOCUMENTATION.md`).

| Path (after webview strips `/api`) | Behavior |
|---|---|
| `PUT /openchamber/sessions/:id/metadata` | RFC 7386 merge patch → `{ metadata }` |
| `PUT /openchamber/sessions/:id/archive` | `{ archivedAt, directory? }` → `{ session, index? }` |
| GET `/session` / `/experimental/session` | Overlay committed Host map; 503 retryable if unavailable |
| GET `/session/:id` | Same overlay / 503 contract |
| `DELETE /session/:id` | On upstream 2xx → idempotent Host forget |
| SSE lifecycle (+ `.v2`, `data.info`) | Overlay when ready; suppress until ready |
| SSE `session.deleted(.v2)` | Compensatory Host metadata drop |

Archive authority: positive `archivedAt` → Host wins; `0` → clear even if
upstream still has history; missing Host key → upstream `time.archived`.
Directory match prefers `location.directory`. Successful archive does not reverse
on post-commit broadcast failure. Runtime switch (different OpenCode endpoint
key) swaps the durable store directory and invalidates in-flight generation.
Full dispose on extension deactivate. `isHostSessionMetadataReady()` is the
explicit readiness gate (committed snapshot only).

## Question auto-delegate (Extension Host)

Contract source of truth (do not vendor/copy): `packages/web/server/lib/question-auto-delegate/core.js`
+ `core.d.ts` and `DOCUMENTATION.md` (snapshot shape, tip event, claim code
`question_submission_claimed`). The VS Code host imports that core directly.

| Path (after webview strips `/api`) | Behavior |
|---|---|
| `GET /question-auto-delegate` | Authoritative snapshot |
| `POST /question-auto-delegate/requests/:id/pause` | `{ sessionID, directory, reason }` |
| `POST /question-auto-delegate/requests/:id/delegate` | Immediate auto-reply claim |
| `POST /question/:id/reply\|reject` | Sync claim + upstream; preserve SDK body/status |

Timers are host-owned: closing every webview does not cancel counting. Webview
tips call shared `refreshQuestionAutoDelegate` once (no window `message`
re-dispatch). Same-endpoint disconnect retains core state; reconnect reconciles
pending. Offline auto-submit waits briefly for `getApiUrl`; if still missing,
returns `{ notSent: true, uncertain: false, status: 0 }` so core releases the
claim into paused (manual retry). A real fetch that fails with status 0 stays
`uncertain` (may have reached upstream). Shared settings: only ENOENT defaults
enabled on; read/parse failure → `readEnabled() === null` (core unavailable
gate, no auto timers even if the feature was previously off). Full dispose runs
on extension deactivate or a real OpenCode endpoint switch.

When adding new bridge route families:

1. Prefer creating or extending a domain runtime module under `packages/vscode/src/bridge-*-runtime.ts`.
2. Keep `bridge.ts` focused on delegation order and minimal fallthrough behavior.
3. Inject dependencies into runtimes instead of reaching into unrelated modules directly.
