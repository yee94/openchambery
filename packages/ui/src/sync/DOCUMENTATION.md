# Sync architecture, event handling & store update rules

## Scope

This document covers the current client-side session/data architecture in `packages/ui/src/sync` and the rules for updating stores safely.

There are **two distinct session data scopes** in the UI:

1. **Directory-scoped sync stores**
   - Owned by the sync layer child stores created in `sync-context.tsx`
   - Source for per-directory live session catalog, status, permission, question, and other non-transcript domain state
   - Transcript message/part/pagination live only in QueryCache / TranscriptRepository (sole production authority)
   - Backed by SSE / directory-scoped polling for non-transcript domains
   - Read via hooks like `useSessions()`, `useDirectorySync()`, `getSyncSessions()`, `getDirectoryState()`; transcript reads use repository facades (`useSessionMessages`, `useSessionTranscriptPagination`, …)

2. **Global sessions cache**
   - Owned by `packages/ui/src/stores/useGlobalSessionsStore.ts`
   - Shared source of truth for the Sessions sidebar global lists and Session Retention cleanup
   - Holds:
     - global active sessions
     - global archived sessions
     - active sessions indexed by directory

These two scopes are intentionally different, but they are no longer equal peers for live UI truth.

### Why both exist

The directory-scoped sync stores are **not** a complete global view.

- They are created lazily per directory
- They only contain data for directories initialized in the current app session
- They are optimized for live per-directory domain data
- They do not maintain the complete global active+archived session view needed by the sidebar and retention settings

So:

- Use the **directory sync stores** for per-directory live session/status/permission/question state
- Use **QueryCache / TranscriptRepository** for transcript message/part/pagination (sole production authority)
- Use the **global sessions store** for cold/global session coverage (especially archived pages and unopened directories)
- Use **aggregated child-store snapshots** for live session/status truth across already initialized directories
- Sidebar-only consumers may create and subscribe to a child store with
  `ensureChild(directory, { bootstrap: false })`. Global events can still route
  live status/permission updates into that store, but merely rendering a cached
  row must never start the directory's full bootstrap.
- `SyncProvider` keeps the current directory child store available during an
  open blank new-session draft with `bootstrapDirectory={false}`. The store
  remains in `loading` and accepts live or optimistic updates. A root enables
  bootstrap when the draft closes or a real session becomes current; the same
  directory then performs one full bootstrap. Reconnect, transport-switch, and
  watchdog resyncs use this gate for the current draft directory, while other
  initialized directories retain their normal recovery lifecycle.

## Ownership map

### Worktree topology catalog reconciliation

`worktreeTopologySync.ts` owns renderer-level worktree catalog reconciliation. It starts from `AppEffects`, remains shared through a realm ref-count, and skips VS Code. Event-stream ready envelopes, topology changes, registry topology changes, and deduplicated unknown recovery directories force per-project catalog enumeration. Recovery candidates are the union of live `activeSessions` directories and session-index snapshot `cachedDirectories`, so an empty worktree (no live sessions) still recovers catalog for other clients that only have index-backed directories. Candidate membership is semantic: a new Set/array with the same members does not force an extra catalog refresh. When a directory leaves the candidate set, its unknown/suppression bookkeeping is cleared so a later reappearance can recover again in the same ready epoch. Successful empty results authoritatively clear that project, failed reads preserve its prior catalog, and only added worktree directories start global session synchronization. Unknown-directory suppression begins only after every registered project completes successfully for its recovery epoch; failures retain bounded retry and lifecycle/runtime changes discard stale work.

| Layer / Store | Owns | Scope |
|---|---|---|
| child directory stores in `sync-context.tsx` | `session`, `permission`, `question`, `session_status`, `session_error_at`, etc. — non-transcript domains only | One directory |
| `scoped-blocking-requests.ts` | Blocking-request scope (`useScopedBlockingQuestions` / `useScopedBlockingPermissions`): catalog `parentID` subtree plus live task dispatch edges read from running `task` tool parts (`state.metadata.parentSessionId`/`sessionId`). Fork + task_id reuse can leave a reused subagent session's catalog `parentID` on the pre-fork lineage, so the dispatch edge is what keeps a running subagent's pending question reachable from the dispatching session; terminal tasks contribute no edge | One directory |
| QueryCache / TranscriptRepository | Production sole authority for transcript message/part/pagination boundary, request lifecycle, optimistic rows, SSE transcript merge, reconnect compensation | Transport + generation + directory + session |
| `session-ui-store.ts` | Session selection, draft lifecycle, abort prompts, worktree metadata, SDK-facing action entrypoints | App UI state |
| `useGlobalSessionsStore.ts` | Global active sessions, global archived sessions, `sessionsByDirectory` | All opened project/worktree session lists |
| session-index Query (`sessionIndexQueries` / `sessionIndexPinQueries`) | Authoritative session-index snapshot; pinned IDs derived from `pinnedSessionIds` plus in-window `time.pinned` | Transport-scoped pull + optimistic pin/unpin |
| `viewport-store.ts` | Scroll anchors, session memory, loading indicators | App UI state |
| `input-store.ts` | Legacy pending input state plus keyed draft metadata, hydration, persistence state, and DraftKey-scoped attachment views; explicit-key VS Code attach primitives (`addDraftVSCodeFileAttachment` / `addDraftVSCodeSelectionAttachment`); atomic root attachment replace via `replaceDraftRootAttachments` (single `commitDraftSnapshot` CAS, preserves text/composer/mentions/synthetic) | App UI state |
| `draft-attachment-resource-adapter.ts` | Explicit DraftKey attachment resource adapter for ChatInput/Assistant surfaces (add local, remove by attachmentID, root-only clear, replace root AttachedFile[] via single CAS + per-draftKeyString serial flight, VS Code file/selection); owns `resolveDraftAttachmentRefID` | App UI state |
| `message-composer-restoration.ts` | Thin facade re-exporting restoration builders + CAS (see sources/cas modules) | App UI state |
| `message-composer-restoration-sources.ts` | Sent/queue Composer restoration payload builders (path/mention/data-URL helpers) | App UI state |
| `message-composer-restoration-cas.ts` | Composer restoration CAS capture/commit/rollback (prior absence uses durable `deleteDraftSnapshot`) | App UI state |
| `session-history-mutation-coordinator.ts` | Serial flight for same-session revert/unrevert keyed by transport/generation/directory/session; failures never block the next op | App UI state |
| `conversation-order.ts` | Pure conversation-position helpers for revert visibility, dock, history, and slash undo/redo — `messageOrder`, never id lexicographic order | App UI state |
| `composer-send-manager.ts` | Per-surface submit flight plus new-session establishing follow-ups (client pending-admission chips) | App UI state |
| `composer-send-drain.ts` | After createWithPrompt materializes a session, drain establishing follow-ups into server/legacy queue | App UI state |
| `input-draft-metadata-store.ts` | Validated durable draft metadata, legacy staging, migration markers | Browser storage |
| `selection-store.ts` | Model/agent/variant selections | App UI state |
| `voice-store.ts` | Voice state | App UI state |

### Keyed draft metadata

`input-store.ts` owns memory-first validated `DraftRecord` state keyed by transport identity and draft owner. `DraftRecord` stores textarea-visible text, Composer Session/Paste sidecars, and attachment metadata; per-occurrence `AttachedFile` views, missing blob occurrence IDs, and attachment hydration/persistence state remain runtime memory. `packages/ui/src/composer/use-composer-controller.ts` projects the active `DraftKey` record into ChatInput and commits document plus file/agent mentions through `setDraftComposerState` as one revision. Primary session and new-draft keys retain their durable shape; an explicit `surface` owner isolates a secondary ChatInput surface. The durability and blob-reconciliation lanes admit all three owner kinds (`session`, `draft`, and `surface`) so Assistant surface attachments survive handoff and restart. Persistence enablement controls the durability lane while memory editing remains available. Composer ranges use UTF-16 offsets, and durable sidecars validate sorted non-overlapping ranges, unique IDs, bounded per-reference and cumulative Paste payloads, and stable Session IDs. Blob put and draft-reference retain complete before a snapshot containing that metadata enters the durability lane; quota and storage failures preserve editable memory views for explicit retry. Removal and replacement persist metadata before releasing old blob references. `moveDraftWithAttachments()` retains destination references, moves metadata, persists, then releases source references; synchronous `moveDraft()` remains URL-only. Hydration isolates transport generation, key epoch, and record identity, so delayed blob reads cannot replace newer attachment views. Disabled persistence keeps drafts and attachment views in memory without IndexedDB work. Legacy session drafts import into the migration's claimed transport; legacy Composer envelopes become visible text plus validated sidecars, and the legacy `new` record remains staged until `claimLegacyNewDraft()` receives its destination key. Queue admission and send ownership transfers remain outside this store.

Legacy imperative attachment actions route into the active `DraftKey` record and attachment views; an independent unowned in-memory bucket remains for callers without an active draft. Delayed FileReader completion stays scoped to its captured source key, and clearing that key invalidates the pending read. Legacy migration treats the durable staged snapshot claim as authoritative; a valid marker carrying another transport identity is repaired to that captured claim before cleanup, while malformed markers and failed repair writes preserve the staged data and fail closed.

`input-draft-durability-coordinator.ts` owns serialized draft durability. `input-store.ts` keeps memory-first records and submits scoped candidates through the coordinator; blob materialization, references, metadata ordering, rollback, release cleanup, and move transfers stay behind that boundary. Hydration seeds the coordinator once after migration, persists every touched snapshot, flushes durability before completion, and replays locally dirty keys after the durable baseline is available. Disabled persistence keeps editable memory records and blocks durable admission until re-enabled.

Text and Composer-state bursts use one per-store 40ms latest-wins persistence window. Memory revisions publish synchronously and persistence reports `saving`; flush drains the window before coordinator flush. Attachment, ownership, move, delete, retry, and other durability barriers absorb a pending Composer request for their keys and persist the latest complete record immediately. Disable clears pending timers and preserves dirty memory for a later enabled persistence pass.

Committed draft snapshot, durable delete (`deleteDraftSnapshot`), and ownership actions use per-key CAS epochs plus a captured runtime generation. The durability lane validates candidate currentness before every blob, cleanup, or metadata operation and validates it again before metadata persistence. A metadata-committed action adopts its durable draft or tombstone keys independently after post-write epoch changes; runtime-stale completions clear attachment views, missing-ref IDs, hydration, and both persistence maps in one publication while preserving newer memory records. Durable delete commits tombstone + metadata delete first, then removes the memory draft and clears ephemeral attachment/hydration/persistence maps when the key epoch is still current; revision/runtime races return conflict/stale and leave newer memory intact, while durable-stale reports `durable=true` with `current=false`. Ownership finalization evaluates source and destination epochs independently, so one durable source tombstone can coexist with a newer destination record. Composer restoration rollback requires `status=committed` and `current=true`; prior absence restores true absence through `deleteDraftSnapshot` rather than an empty snapshot. Revision increments require positive safe integers, including delete tombstones. Synchronous `deleteDraft` remains for in-memory-first paths that schedule deferred persist.

`snapshotViews` always resolves URL locators from `locator.url` (or an explicit same-value entry in `values`); existing attachment views never override a URL locator with a placeholder File/Blob. Blob locators may reuse `values`, existing view files, or durable data URLs. `replaceDraftRootAttachments` re-supplies every preserved synthetic URL locator into `values` so a root-only clear/replace keeps hydrated synthetic durable URLs.

Before `revertToMessage` / `stageMessageEdit` call `buildSentMessageComposerRestoration`, they read transcript file parts. A slim or url-less authored file part awaits `materializeTranscriptMessage` under the existing directory/session/message identity (repository single-flight), then re-reads parts. Complete file parts make no extra request. Materialize failure or a still-incomplete file body fails the edit explicitly and leaves the live composer/attachments untouched — attachments are never silently dropped. The action captures runtime generation; a stale materialize cannot commit into a new runtime. `buildSentMessageComposerRestoration` skips `slim === true` file parts before url/type parsing so a preview/stub url cannot be written into Composer; full data/file/http URLs restore as before.

Cross-runtime restoration rollback (`message-composer-restoration-cas.ts`) writes only through a capture matching the draft key transport. A missing matching capture or stale write returns `failed` and ends the best-effort attempt. Revision conflicts preserve the user's newer draft, and no retry queue or runtime subscription participates in restoration.

Root attachment send consumption (`draft-attachment-resource-adapter.ts`) serializes clear/restore/replace on the same per-`draftKeyString` lane across factory instances. `clearRootAttachments` clears root metadata in memory first through `setDraftAttachments`, so sent chips disappear immediately while store persistence continues. `restoreRootAttachments` merges failed-send attachments with live root metadata through one CAS.

Draft metadata hydration is single-flight per transport and returns an explicit success signal; external durable handoffs proceed only after that authoritative hydration succeeds. Android share handoff commits text, image blobs, and a hidden synthetic receipt in the same draft CAS. Composer submission atomically retains that receipt until native cancellation and runtime-correct Assistant navigation finish, then the bridge durably removes the receipt before finalizing its handoff journal.

## Session list rules

### Directory-scoped session list

Use the directory-scoped sync store when the UI needs the live session list for the **current directory**.

Examples:

- current chat/session switching
- per-directory session catalog bootstrap
- session/status/permission/question SSE updates (transcript SSE commits to Query via `sse-event`)

### Global session list

Use `useGlobalSessionsStore` when the UI needs a **shared global session cache**.

Current consumers:

- `useSessionAutoCleanup.ts`

### Live cross-directory session/status view

Use the sync hooks backed by aggregated child stores when the UI needs **live truth** for sessions or statuses across all initialized directories.

Current consumers:

- `SessionSidebar.tsx`
- `SessionNodeItem.tsx`
- agent/session activity surfaces using `useGlobalSessionStatus()` / `useAllSessionStatuses()`

Cross-directory selectors subscribe to the narrow child-store field they aggregate. Session aggregation listens to `state.session`; per-session status listens only to that session's `state.session_status` entry. Unrelated streaming events such as `message.part.delta` must not trigger global session/status scans.

Sessions titled `smartfetch-secondary` are temporary SmartFetch model calls. The
directory event reducer never inserts them into live child-store session lists,
and `aggregateLiveSessions` excludes them so sidebar/mobile merges cannot flash
them before `session.deleted` arrives. The same title blacklist is shared with
`useGlobalSessionsStore` and the server session index. System sessions are also
  hidden from ordinary active/archived lists by authoritative metadata only: a
  non-empty `metadata.openchamber.assistant.assistantID`,
  `metadata.openchamber.scheduledTask.taskID`, or
  `metadata.openchamber.smallModel.purpose`. Sessions with a non-empty
  `parentID` are also excluded from the root catalog (`isVisibleGlobalSession`
  and `aggregateLiveSessions`); they never promote to sidebar roots when the
  parent is missing, archived, or system-owned. Title prefixes never participate
  in this check. Metadata is ownership/isolation; `time.archived` is archive
  state; titles are human labels. Direct open by sessionID+directory is
  unaffected. Assistant history and scheduled-task source surfaces remain the
  entry points.

Catalog visibility must not destroy live transcript caches. `session.created` /
`session.updated` remove system, subagent, and archived sessions from the live
directory list only; they do **not** call `dropSessionCaches` / Query
`purgeSession` for those rows. Wiping status on hide is reserved for temporary
SmartFetch secondaries and for `session.deleted`. Scheduled tasks and assistants
archive while still streaming — wiping on archive is what made mid-run viewing
look nothing like a normal live session. When caches are wiped,
`dropSessionCaches` clears non-transcript domains only; Query `purgeSession`
owns the transcript key families (canonical InfiniteData, transport-page,
tail/reconcile/checkpoint). A deleted session, a wiped temporary secondary, and
an ordinarily evicted session all leave pagination clean — a later visit reads
`unknown` and performs one authoritative tail refresh.

`useCurrentSessionEntity(sessionID)` owns current-session entity resolution for the desktop Header and mobile Header. It prioritizes the matching cross-directory live session, then the matching global active session. A resolved entity remains available for two seconds during a brief source gap; clearing or changing the session ID immediately clears that fallback.

Renderable messages and session identity are independent completeness signals. Missing session identity keeps `session.get` eligible even when the repository transcript is already resolved, blocks prompt submission while preserving the mounted primary Composer and its editable draft, and receives a bounded current-view retry. The subagent read-only prompt banner requires a confirmed child `parentID` before first paint; loading, missing, cached cross-directory, root, and generic read-only states never display it. Once that child identity is confirmed for the current chat view, `resolveSubagentReadOnlyBannerLatch` keeps the parent target and last-known agent/provider/model through temporary live-list gaps (`session.updated` hides subagents from the directory list; recovery may reinsert the row) and resets when the view identity changes. Parent navigation derives its target identity from the authoritative child `parentID`; a cached parent entity enriches its title and directory. Cover the latch in `components/chat/chatPromptAvailability.test.ts`.

`scoped-session-status.ts` owns exact `(directory, sessionID)` status reads and subscriptions. A missing child-store snapshot reads as `unknown`; a successful directory status snapshot with no matching entry reads as `idle`. Its registry subscription rebinds when a requested directory store appears, and status listeners ignore parts plus other session IDs.

`session_error_at` is a live per-session timestamp written only from `session.error` with `callbacks.now`. It is not persisted history and is not invented from ordinary `session.idle` / `session.status` idle. The next authoritative `busy` or `retry` (`session.status`, or a directory status snapshot applying busy/retry) clears that session's entry. `useSessionErrorAt(sessionID, directory)` is read-only (`bootstrap: false`) and notifies only when that session's `session_error_at` value changes.

Imperative cross-directory session lookups use the cached ID index from `getAllSyncSessionMap()`. The index is rebuilt only when a child store's `state.session` reference changes; permission lineage checks must reuse it instead of rebuilding a full session map per call.

### Mutation responsibility

`useGlobalSessionsStore` is not maintained by SSE directly. It is kept correct by:

1. shared global fetch/reconciliation via `loadSessions()` / `refreshGlobalSessions()`
2. direct mutation from session actions after successful SDK calls:
   - create
   - title update
   - share
   - unshare
   - archive
   - delete
   - retention cleanup batch archive/delete

This keeps cold/global lists responsive without requiring a refetch after every change.

Live activity/status indicators must not depend on this cache. They must derive from aggregated child-store state.

Cross-directory status aggregation resolves duplicate session entries by the
latest live session source. Session-index ordering timestamps and persisted
status transitions are owned by the OpenChamber server's global event
subscriber. Renderer session events update visible metadata only; time-only
session updates, busy/retry transitions, and token/message delta events do not
replace the global session list or write the SQLite index. The session-index
SSE tip observer remains active after startup so user-message and task-completion
ordering revisions promote their session inside its project immediately.
The desktop tray's one-shot cross-project status seed compares canonicalized
directory and session-ID membership. Directory/session iteration order changes
reuse the existing seed, while a membership change during an in-flight seed is
coalesced into one latest-target follow-up.

Sidebar directory refreshes are intentionally bounded snapshots, not full catalogs:

- active and archived requests are independent and capped at 20 rows per directory
- directory-sync bootstrap also loads only 20 root sessions; it no longer performs a 500-row full pagination pass or a 200-row mixed root/child prefetch
- active requests coalesce by directory with bounded concurrency
- active pagination stores a per-directory cursor; reaching the local Show more boundary requests and appends the next 20 roots
- child sessions arrive through live `session.created` events. Historical
  `session.children` recovery is requested only when the user selects that
  parent session; the startup watchdog must not fan out one request per active
  or persisted parent
- `loadingDirectories` means no usable active snapshot; `refreshingDirectories` keeps stale rows visible
- archived rows load only when the archived bucket is expanded
- retention must wait for `hasLoadedFullCatalog` and use `ensureFullGlobalSessionsLoaded()`, never treat a bounded directory snapshot as authoritative for cleanup

### Runtime session index cold-start ownership

The runtime session index (SQLite-backed) provides one durable session-summary
source. The legacy per-directory `localStorage` session list is removed
on child-store creation and must not be reintroduced. `main.tsx` establishes a
startup barrier before React effects; `SessionStartupCoordinator` starts the
session-index flow immediately: SQLite hydrate (`GET /session-index`) is fired
without waiting for settings so the last snapshot can paint first (local-first /
server-cache-first). On the client, TanStack Query owns that GET as transport-
scoped SWR (`queryKeys.sessionIndex.snapshot(transport)`), while a separate
runtimeKey-scoped persistent snapshot (`oc.sessionIndexStartupCache`, at most
eight runtime entries and 1 MiB) seeds
stale first paint so a paired host can reuse LAN↔relay cold-start rows. The
persistent payload is only the public session-index summary (revision, sync
progress, directory session rows) — never credentials, tokens, messages, or
attachments. Query/local storage accelerate paint only; server SQLite + GET
remain authoritative. A failed authoritative GET keeps the last good seed; a
successful empty snapshot clears rows under the existing merge rules; a
501/unsupported `null` must not be written as a successful empty storage entry.
Directory planning and background root refresh still wait for registered
settings hydration so the project catalog and active directory are complete,
then refresh known root/worktree directories through the bounded scheduler
(with priority — see below), write one transaction batch, and release normal
global and directory bootstrap. Concurrent early + startup hydrate callers
share one in-flight GET. A runtime that reports the capability as unsupported
uses the existing bounded SDK-backed path. Desktop main splash dismisses when a
cached snapshot is restored, or when both OpenCode init and hydrate have
settled (so an empty list is not shown before the restore attempt finishes).

**Startup directory priority** (`planSessionStartupDirectories` +
`startSessionIndexStartup`):

| Condition | Immediate POST `/session-index/sync` set | Blocking `startupSyncProgress` | Deferred (P1) |
|---|---|---|---|
| No SQLite cache (`hasCachedSessionIndex=false`) | Full catalog (all registered projects + worktrees + cached dirs) | Yes — wait until root sync settles | None |
| Cache hit + resolvable active directory | **P0 only**: project that owns `useDirectoryStore.currentDirectory` + that project's known worktrees | No — hydrate returns cache; progress stays idle after restore | Remaining catalog directories via `syncSessionsForDirectories` after a `setTimeout(0)` yield |
| Cache hit but active directory missing/unmatched | Full catalog (safe fallback) | No | None |

P1 reuses the existing server enqueue + tip/GET observer path
(`startSessionIndexBackgroundSync` / `syncSessionsForDirectories`); it must not
introduce a parallel sync pipeline. The only allowed client-side browser cache
for session-index is the transport/runtime-scoped Query + startup snapshot
above (stale paint only). Runtime switches still discard in-flight work through
`captureSessionIndexRuntime` / `isCurrentSessionIndexRuntime`, and Query memory
clears on transport identity change via the shared query lifecycle.

Every global session-index asynchronous entry captures the runtime generation
and transport identity. Snapshot hydration, startup sync, persistence, and
tip-driven snapshot reloads commit only while that capture remains current.
Authoritative GET traffic goes through session-index Query helpers (which call
`loadSessionIndexSnapshot` via `runtimeFetch` so relay stays transparent).
`loadSessionIndexSnapshot` still shares one in-flight GET across concurrent
callers, and `waitForSessionIndexInvalidation` debounces dense revision tips
(and stream-ready edges) before consumers issue the next full snapshot GET.
Successful non-null POST/GET snapshots write back through the Query helper so
memory and the runtimeKey persistent seed stay aligned.

The startup observer in `startSessionIndexStartup` never exits — it keeps
watching for later tips — so it disables the wait hang-break
(`safetyTimeoutMs: null`) whenever server sync is idle. An armed hang-break
inside a re-entering wait is a fixed-interval poll, not a rescue:
Trace-20260804T171706 shows `GET /session-index` every 1.5s for the life of the
app, each one re-rendering the entire sidebar (~120ms of main thread). The
hang-break stays armed only while `sync.active` is true, which is the one window
where a tip can be published between POST `/sync` returning and the subscription
attaching. Idle waits resolve on a tip, a stream-ready edge, or abort.

Password-gated runtimes force a fresh settings hydration after authentication
and keep the app tree behind the auth gate until persisted project paths have
been applied. This prevents a pre-authenticated `401` settings request from
becoming the cached startup result consumed by the session coordinator.

## Session message loading

### Transcript repository seam (QueryCache sole production authority)

`TranscriptRepository` is the unified read/command contract for session
transcript data. **QueryCache / TranscriptRepository is the sole production
authority** for transcript message, part, and pagination boundary. Child
directory stores hold only non-transcript domains (session catalog, status,
permission, question, …).

It covers:

- **Reads**: flat transcript data (`messageOrder`, `messagesByID`,
  `partsByMessageID`, `boundary`, `liveRevision`), pagination projection
  (`hasPreviousPage`, `isComplete`, `cursor`, `loadedTurns`, `boundary`),
  request lifecycle (`getRequestState`), per-message exact-fill status
  (`getMessageMaterializationState`), hydration phase
  (`getHydrationState`: `idle` / `p0` / `p1` / `p2` + `p0Satisfied`),
  and single-message / parts selectors.
- **Commands**: `http-page` (purpose =
  `initial` / `prepend` / `recovery` / `materialize`), `sse-event` (message /
  part events only), `sse-event-batch` (ordered multi-event SSE merge with one
  rebuild per flush frame), `optimistic-add` / `optimistic-confirm` /
  `optimistic-remove`, `materialize-snapshots`, `remove-message`, and `reset`
  (clear or rebuild tail). Production never uses a `commit-reduced` command.

Modules:

| Module | Role |
|---|---|
| `transcript-repository.ts` | Contract types, pure pagination/transcript projections, SSE event-type guard, command union (`http-page`, `sse-event`, `sse-event-batch`, optimistic, `materialize-snapshots`, `remove-message`, `reset`); `messageNeedsExactMaterialization` / `messageNeedsExactRevalidation`; `hasTailAssistantMissingSettledCompletion` (lost settle-tick gap detection: missing completed, or stop without positive tokens); optional `materializeMessage` / `getMessageMaterializationState` / `getHydrationState`; P0/P1/P2 helpers |
| `transcript-repository-query-adapter.ts` | **Production** Query-backed implementation: canonical InfiniteData in QueryCache; active-scope retain on `subscribe`; cache budget enforce; `fetchPreviousPage` / `ensureInitial` (cold authority tail + enter-and-sync hot reconcile); on-demand `materializeMessage` (single-flight, idle/loading/ready/error); optional injected `durableStore` first-paint + persist queue; durable-seeded slim or open tool/reasoning/file parts exact-fill via `session.message` after the authority tail (≤4 concurrent FIFO; settled full rows skip); post-write durable byte evict with retained-scope protect; destructive reset / purgeSession / purgeGeneration |
| `session-authority-revalidate.ts` | Enter-and-sync 30s window keyed by transport+generation+directory+sessionID; stamped only after a successful authority pull |
| `transcript-repository-store-adapter.ts` | **Test-only / pure-merge** child-store-backed adapter: maps commands onto pure reducers for unit tests and residual pure-merge helpers — not production SyncProvider binding |
| `session-transcript-query-cache.ts` | Key-family shapes (canonical / transport-page / tail·reconcile·checkpoint), active-scope registry, QueryCache LRU enforce, purgeSession, purgeGeneration, destructiveReset; incremental `sessionID → canonical scopes` index (`listCanonicalScopesForSession`) kept in sync with QueryCache add/remove and cleared on purge/evict/dispose |
| `session-cache-limits.ts` | Shared platform capacity targets (VS Code 4 / mobile 12 / default 40 sessions) plus durable body budgets (`getTranscriptDurableByteBudget`: 4 / 12 / 40 MiB) |
| `session-transcript-reconcile-api.ts` | Host anchor-reconcile HTTP client (`fetchSessionTranscriptReconcile`) — runtimeFetch, timeout race, strict contract, classified retry |
| `session-transcript-recovery-checkpoint.ts` | Stable authored-user turn anchor selection + recovery checkpoint model / QueryCache read-write |
| `session-transcript-reconnect-compensation.ts` | Query reconnect compensation controller — checkpoint-before-replay, immediate set (main + Context Panel viewed), directory concurrency, serial continuation, multi-round head chase; null-anchor → non-destructive `ensureInitial`; Host `resetRequired` → `destructiveReset`; observe-time 60s TTL reconcile head check for non-stale cached sessions |
| `transcript-event-broadcast.ts` | Pure helper: list every current-runtime canonical scope that should receive one transcript `sse-event` (multi-directory broadcast; zero hits fall back to resolved directory) |
| `transcript-reconnect-compensation-runtime.ts` | Registration seam; production `mountProductionTranscriptStack` registers the Query controller so SyncProvider `onRecoveryContextCaptured` / `onCompensation` reach it |
| `transcript-exact-fill-scheduler.ts` | Process-wide exact `session.message` fill queue (concurrency ≤4, `user` ahead of `background`, same-key coalesce). Used by `materializeTranscriptMessage` and durable-seed background fills |
| `transcript-repository-runtime.ts` | Production binding revision + `bindTranscriptRepositoryInstance` (Query) / test-only store bind; `fetchTranscriptPreviousPage` / `ensureTranscriptInitial` / `retryTranscriptInitial` / `materializeTranscriptMessage` (shared exact-fill scheduler) / `getTranscriptHydrationState` / `getTranscriptMessageMaterializationState` / `purgeTranscriptSession` / `listCanonicalTranscriptScopes` |
| `transcript-repository-production.ts` | `mountProductionTranscriptStack` (registry + budget + Query repo + compensation; default runtime durable store, optional injected `durableStore`) and Host turn-page production fetcher (`fetchProductionTranscriptTransportPage` → Query `http-page`) |
| `transcript-parent-recovery.ts` | Production assistant-parent recovery helpers plus shared exact `session.message` fetch (`fetchExactSessionMessageRecord`, transport+generation flight key; no nested store commit). Parent recovery is best-effort: a 404/failed exact fetch keeps the Host page. |
| `session-todo-projection.ts` | Hydrate-path todo seed: project the latest loaded `todowrite`/`todoread` list into `store.todo` + persist when live `todo.updated` never arrived. No extra HTTP. |
| `transcript-diagnostics.ts` | Client diagnostics hub: named `feat` events (`transcript`, `task`, and `perf`), redacted snapshots (bounded user text only; no assistant bodies/tokens/URLs/titles), bounded recorder, export schema `openchamber.client-diagnostics.v1`; `transcript-diff` before/after identity snapshots; `task-row` / `task-click` lifecycle facts; `perf-window` aggregates |
| `transcript-diagnostics-runtime.ts` | Production selector: About switch (beta default on, stable default off), IndexedDB/memory sink, export/download, `recordTranscriptDiff` |
| `perf-diagnostics.ts` | App-level perf probes (`feat: perf`, `kind: perf-window`): always-on longtask + event-loop lag, duty-cycled FPS (first 3s of each 30s window), haptic counters; writes only while the About diagnostics switch is on |
| `transcript-diagnostics-diff.test.ts` | Canonical snapshot capture + added/removed/partsChanged/downgraded/optimisticLost contracts |
| `transcript-diagnostics-indexeddb.ts` | IndexedDB ring buffer for local feat events |
| `transcript-repository.test.ts` | Focused seam tests (reads, all purposes, SSE, optimistic, reset, materialize/remove, subscribe) |
| `session-transcript-query-cache.test.ts` | Capacity constants, key families, active retain, LRU order, purge families, long growth, destructive reset, generation isolation, adapter integration |
| `session-transcript-reconcile-api.test.ts` / `session-transcript-reconnect-compensation.test.ts` | Client contract, checkpoint/anchor, first-ready skip, priority set, concurrency, continuation, multi-round, reset, generation cancel |

**Client diagnostics hub:** Query adapter, Task rows, and About export share one local recorder. Each event names a `feat` (`transcript`, `task`, or `perf` today). About has a switch: prerelease versions default on, stable versions default off, and the user can override. Export appears only while the switch is on. User-message text is copied into snapshots (400-char bound; credential-shaped values become `redacted-text`) so duplicate or optimistic user rows can be located. Assistant/system bodies, URLs, tokens, titles, prompts, agent names, and attachments stay out. SSE `message.part.delta` and unchanged connection batches are not recorded. Each `transcript` event records `source` (`network` / `query-cache` / `durable-cache` / `sse`), optional `durationMs`, request status, hydration/paint order (`lastMessageIDs`), command/SSE type, and sanitized `error` / `httpStatus` so GET vs cache vs on-screen order and settled load-failed walls are reconstructable. `purpose: load-failed` is the visible "unable to load this conversation" wall; `purpose: retry` is the user retry. `kind: transcript-diff` is a before/after identity snapshot (`messageIDs`, per-message part/slim/full/optimistic counts, plus bounded user text) recorded around user send/edit/delete/refresh and reconnect compensation / materialize / destructiveReset. Diff fields are `addedMessageIDs`, `removedMessageIDs`, `partsChanged`, `downgraded` (full parts replaced by slim-only), and `optimisticLost` (optimistic row vanished or became non-optimistic without `time.completed > 0`). Capture is read-only `getTranscript` and is swallowed on throw. `feat: task` records compact Task-row lifecycle facts (`kind: task-row` on identity/status change, `kind: task-click` on row click or queued open): parent/child session IDs, whether a child id is present, tool status, finalized/background/effective-active/suppress-loading/delegating, child/parent `session_status` (`idle`/`busy`/`retry`/`missing`), idle-confirmed, navigate capability, directory presence, and click outcome (`opened` / `queued` / `capability-off` / `missing-directory` / `navigate-rejected`). Recording is gated by the same About switch as transcript events and never writes when the switch is off. `feat: perf` (`kind: perf-window`) is produced by `perf-diagnostics.ts`: always-on longtask PerformanceObserver + 1s event-loop lag probe, plus duty-cycled FPS sampling for the first 3s of each 30s window; haptic success counts come from `notePerfHapticFired`. Window flush writes only while the About switch is on (otherwise counters reset with no record). Export fields include optional `fpsAvg`/`fpsMin`/`fpsP10` (omitted when no samples), `longTask*`, `eventLoopLag*`, `haptic*Count`, optional Chromium `jsHeap*MB`, `visible`/`foreground`, and `platform`; `sessionID` is `app`. Probe callbacks are try/catch-wrapped so diagnostics never affect the call path. Export writes `openchamber.client-diagnostics.v1` JSON from the local ring buffer; native `diagnostics.downloadLogs` is optional and never replaces an empty local report with a failed fetch. Capacitor uses `OpenChamberMedia.saveFile` (iOS document picker / Android create-document) so export is a real file save, not clipboard or `navigator.share`. Android writes a cache file first and drops `dataBase64` from the persisted plugin call so DocumentsUI pause/restore cannot `TransactionTooLarge`; the create-document MIME is `application/octet-stream` because `application/json` crashes some OEM pickers on confirm.

**Ownership boundary (QueryCache sole production authority):**

- Production transcript **writes and reads** bind a **Query-backed** repository
  from SyncProvider via `mountProductionTranscriptStack`: one active registry,
  one cache budget (30s min-residency), one Query repo, one reconnect
  compensation controller. Binding revision re-subscribes observers after
  provider-bind. Runtime identity uses `subscribeRuntimeEndpointChanged` (no
  polling); stack lifecycle is independent of ordinary directory switches.
- **UI history pagination**: Chat / Context / timeline call
  `fetchTranscriptPreviousPage` (Query `fetchPreviousPage`,
  `cancelRefetch:false`). Success / availability read repository pagination +
  request state via `useSessionTranscriptPagination` and
  `useSessionMessageLoadState`. There is no production `useSync.loadMore` /
  `sync.loadMore` facade.
- Initial / recovery / materialize / selection: production transport fetcher
  (`fetchProductionTranscriptTransportPage`) enters Query as `http-page`
  directly, or via `ensureTranscriptInitial` / `ensureInitial`. On-demand
   exact fills use `materializeTranscriptMessage` → Query `materializeMessage`
  (`session.message`, captured transport+generation, `materialize-snapshots`).
   Durable first-paint seeds the canonical transcript from the local cache
   before the authority tail **only while canonical is still empty**. After
   `readSession` resolves, `ensureInitial` re-checks emptiness: a non-empty
   canonical (HTTP `initial` won the race) skips seed — older rows load
   through `fetchPreviousPage`, not a late seed. If a seed still lands on a
   non-empty canonical, unowned snapshots insert by `time.created` (same as
   reconcile-page), never append to the tail.    Seeded tool / reasoning / file parts schedule a background exact
   `session.message` fill only when the store still holds a slim part of
   those types, or the message snapshot is still open (`isMessageSnapshotOpen`).
   Settled messages whose matching parts are already full skip revalidation
   and report materialization `ready` (cold-start must not fan out one exact
   fetch per historical tool/reasoning row). Remaining fills run with bounded
   concurrency (≤4 FIFO) after the authority tail lands. Authority-tail pull
   itself is gated by `seededAuthorityPending`, independent of the exact-fill
   pending set.
   Slim text parts take the on-demand exact-fill path
   (`messageNeedsExactMaterialization` requires `isSlimPart`, and the set
   includes `text`) so an explicit `materializeMessage` replaces a summary
   with the Host full body. They stay out of the durable-seed revalidation
   set (`messageNeedsExactRevalidation` remains `{tool, reasoning, file}` plus
   slim/open gates) so cold-start text-only messages do not fan out exact
   `session.message` fetches.
   Visible slim file images subscribe to that message's live parts so the fill
  upgrades in place. File `url` / `slim` are part of merge equality so an exact
  fill is not dropped as a no-op. A fill that leaves slim parts is `error`, not
  `ready`.
  A late result after a runtime switch is discarded and does not write the
  current Query. SSE, optimistic, and recovery reconcile apply through the
  repository command path. Store adapter / pure reducer paths are **tests or
  pure merge only**. Activity-lane loading UI is not wired here.
- Production transcript **reads** go through repository observers in
  `transcript-repository-observers.ts`, exposed as
  `useSessionMessages` / `useSessionParts` / `useSessionMessageCount` /
  `useSessionMessagesResolved` / `useSessionTranscriptPagination` /
  `useSessionMessageRecords` / `useSessionMaterializationStatus` /
  `useEnsureSessionMessages` / `useUserMessageHistory` facades in
  `sync-context.tsx`. Chat, Context Panel, timeline, activity, queue auto-send
  completion/turn, and RevertedMessageDock
  consume repository projections only (session.revert metadata may still come
  from the directory session list). Message-record snapshots and materialization
  status are built from repository TranscriptData + catalog `session.revert`;
  observer subscribe schedules `ensureTranscriptOnObserve` for reconnect-stale
  inactive scopes. Multi-scope readers use
  `subscribeTranscriptScopes` + `readTranscriptCompletionSignature` /
  `readTranscriptMessages`.
- Production session actions (last-assistant model, optimistic dedupe, send
  presence wait, revert/unrevert/stage/fork source messages and parts, message
  counts, selection cache reuse) read via `getTranscriptRepository` /
  `getTranscript` / `getMessage` / `getParts` / `hasSession`. Directory
  resolution prefers session catalog / status / permission / question and
  Query `listCanonical` inventory — never child-store message ownership.
  Fork target discard uses Query `destructiveReset`; unrevert may
  destructiveReset when message count does not grow. Imperative
  `getSyncMessages` / `getSyncParts` / `getSyncSessionMaterializationStatus`
  / `resolveMaterializedSessionDirectory` also use repository projections.
- Production `State` / DirectoryStore does **not** define `message` / `part` /
  history-boundary fields. Transcript SSE is pure
  `applyTranscriptDirectoryEvent` in `transcript-event-reducer.ts`; production
  `applyDirectoryEvent` ignores message/part events (Query `sse-event` owns
  them). Routing index ingest uses catalog + Query inventory. Streaming
  derives from `session_status` + repository tail. `dropSessionCaches` is
  non-transcript only; Query `purgeSession` owns transcript purge. Reconnect
  candidate selection does not scan store transcript. Production transport
  recovery lives in `transcript-parent-recovery.ts` (Query classifier owns
  retries; no nested store page-loader commit).
- Covered writers: `http-page` (initial/prepend/recovery/materialize), SSE
  `sse-event`, optimistic add/confirm/remove, `materialize-snapshots`,
  `remove-message`, narrow `reset`, Query compensation `reconcile-page`.
- Pure internals remain: `reduceSessionMessagePage`, `materializeSessionSnapshots`,
  `applyDirectoryEvent`, `mergeSessionTranscript` — adapter/model / test only.
- **Not** owned by the repository: session catalog, status, permission, question,
  todo, session_diff, and multi-domain eviction (`dropSessionCaches` for
  session.deleted / non-transcript cache eviction). Those keep their existing writers.
  `todo` is written by live `todo.updated` SSE; after transcript hydrate
  (`loadMessages`, session cache reuse, reconnect recovery, materialize),
  `session-todo-projection.ts` may fill an unoccupied `store.todo[sessionID]`
  from the latest loaded todowrite/todoread part so clients that missed the
  write event (typical mobile) still show the list. Occupied keys, including
  an explicit empty list, are never overwritten, and empty projections do not
  clear existing data.
- QueryCache transcript LRU is production-active:
  - Capacity reuses `session-cache-limits` (VS Code 4 / mobile 12 / default 40)
    per transport / generation / directory bucket for **inactive** canonical
    sessions; min-residency protects freshly ensured/observed scopes.
  - Active retain = TanStack Query observer count **or** repository listener
    scopes via an explicit active-scope registry (cache subscribers alone do not
    increment Query observers).
  - Active transcripts keep every loaded page; inactive order by canonical
    `dataUpdatedAt` LRU.
  - `purgeSession` cancel+removes canonical, transport-page, and reserved
    tail/reconcile/checkpoint key families.
  - Destructive reset purges the old cursor/task/checkpoint chain, ensures a
    fresh tail, and on ensure failure leaves empty/failed state without
    restoring old authoritative data. Delete/evict only purge.
  - Runtime switch: `cancelTranscriptReconnectCompensation` then
    `purgeGeneration` for the previous transport/generation identity.
- Transcript hydration phases (ticket 05): repository `getHydrationState`
  is the only writer of `phase` (`idle` / `p0` / `p1` / `p2`) and
  `p0Satisfied`. UI reads via `useSessionTranscriptHydration` /
  `getTranscriptHydrationState` and must not push phases. P0 latches when
  the latest authored user turn is readable and the same-turn assistant has
  displayable parts or an in-progress Activity-shell row. A user-only tail
  stays unsatisfied. Initial HTTP / durable seed that meets P0 enters `p0`
  immediately. In-flight prepend or more than one authored turn is `p1`.
  In-flight per-message materialize is `p2`. After work settles, phase
  returns to the highest satisfied stage. A later empty read cannot drop a
  latched P0 back to skeleton. Runtime `purgeGeneration` resets the latch.
  ChatContainer / Activity wiring is not in this slice.
- Durable transcript cache (ticket 11): each successful `upsertSettled` on the
  per-scope persist queue runs `evictToBytes` with
  `getTranscriptDurableByteBudget()` (VS Code 4 MiB / mobile 12 MiB / default
  40 MiB). `activeRegistry.listRetained()` scopes stay protected. Hash-skipped
  writes do not scan. `clearAll` / `clearCurrentRuntimeTranscriptCache` wipe
  the current runtime backend only (Electron local → HTTP/SQLite; otherwise
  IndexedDB). `clearGeneration` still hits both backends. `destroy` stays
  lifecycle-only. Settings UI is not wired here.
- Query reconnect compensation is production-registered. Ready +
  `isReconnect:true` triggers Query gap compensation after replay flush; first
  ready (`isReconnect:false`) skips gap compensation. Immediate set prioritizes
  Context Panel open sessions (persist across blur) plus the main active
  session. Sessions without a stable authored-user anchor (typical subagent /
  subtask transcripts) refresh via non-destructive `ensureInitial` so a failed
  or focus-time recovery cannot blank an open panel; Host `resetRequired` and
  reconcile budget exhaustion still use `destructiveReset`.   Merge purpose
  `reconcile-page` upserts records with recovery/liveRevision rules but
  **never** rewrites the canonical history boundary / cursor / loadedTurns
  (`complete` ends a compensation round only). Unanchored continuation pages
  insert by (`time.created`, id) so a later older Host window cannot append
  past a newer gap page already merged in the same round. Checkpoint is
  fixed on disconnect / recovery-context capture before replay.
  `ensureOnObserve` still runs stale-marked ensure/reconcile. For a
  **non-stale** cached canonical it also fires a background reconcile head
  check (local tail `messageID` as anchor, one page) throttled by an
  in-process 60s TTL per scope. Empty / no-new pages are silent; new
  records merge through existing `reconcile-page` upsert. Fetch failure is
  discarded (no request error, prior transcript kept). Scopes with no
  canonical Query entry skip the check.

Pagination projection is derived solely from repository `SessionHistoryBoundary`
(`unknown` / `has-more` / `exhausted`). Request lifecycle is
`repository.getRequestState` (loading / ready / error). Session catalog, status,
permission, question, and message queue stay outside this repository. The
`reset` command is transcript-scoped only: it purges the target session's
Query transcript families (and optionally rebuilds from a fresh tail). It must
not call `dropSessionCaches` and must not clear `session_status`, `todo`,
`permission`, `question`, or `session_diff`.

### Module map

Session transcript HTTP pull and SSE push converge at the **Query-backed**
TranscriptRepository (production sole authority):

```
HTTP pull (initial / prepend / recovery / materialize)
  session-message-policy.ts          limit per runtime + purpose (single source)
  session-merge-strategy.ts          (purpose, stale) → frozen merge strategy
  session-message-reducer.ts         pure page → transcript draft (model/test)
  transcript-repository-production   fetchProductionTranscriptTransportPage
                                     Host turn-page + parent recovery
  transcript-repository-query-adapter
                                     http-page → canonical InfiniteData (QueryCache)
  transcript-repository-runtime      fetchTranscriptPreviousPage / ensureInitial
                │
                ▼
        QueryCache / TranscriptRepository (message / part / boundary / request)

SSE push (live transcript increments)
  event-pipeline.ts                  WS/SSE transport
  handleEvent → listTranscriptEventBroadcastScopes
              → TranscriptRepository.apply(sse-event) per matching scope
  transcript-event-reducer.ts        pure applyTranscriptDirectoryEvent
                │
                ▼
        QueryCache / TranscriptRepository

  Transcript `sse-event` commands broadcast to every canonical scope whose
  sessionID matches on the current transport/generation. Zero inventory
  hits fall back to the resolved directory (apply is a no-op when that
  scope has no canonical). Child-store session_status / todo / permission
  routing stays single-directory.

UI history pagination
  Chat / Context → fetchTranscriptPreviousPage
                 → useSessionTranscriptPagination + useSessionMessageLoadState
```

### Event pipeline recovery barrier

`event-pipeline.ts` owns the browser-side reconnect barrier that pairs with the
Host global WS `replay events → ready` protocol:

- Global WS reconnects may deliver buffered `event` frames before `{ type:
  "ready" }`. The pipeline flushes queued events on ready so reducers merge
  replay before compensation starts.
- Disconnect, visibility hidden, system resume (`openchamber:system-resume`),
  pageshow (bfcache), and online-driven reconnect capture a recovery context
  with `lastEventId`, `disconnectedAt`, and `runtimeGeneration`.
- Each ready barrier publishes **one** `onCompensation` trigger carrying that
  context (or current live tip + generation when no gap was captured). The
  trigger always includes `isReconnect`: `false` on the clean first ready,
  `true` when a recovery context was captured for a real gap. SSE and WS share
  the same hook so reconnect, visibility restore, and system resume use one
  compensation seam.
- **WS protocol consistency:** JSON parse failure, an unknown/missing top-level
  frame `type`, or an `event` frame whose payload cannot be normalized are real
  transport faults (not silent drops). The pipeline keeps the last
  **successfully ingested** `eventId` (ingest success is explicit; `eventId`
  advances only after a domain event is enqueued), captures recovery context,
  closes the socket, and enters the normal disconnect/reconnect path so the next
  ready compensation is `isReconnect:true`. In `auto` mode these faults also arm
  the SSE fallback window. Bad frames never call `reportTransportActivity`, so
  corrupted input cannot postpone heartbeat recovery. Frame bodies and other
  sensitive payload data are never logged. SSE keeps its existing per-event
  drop semantics for non-normalizable payloads.
- `onReconnect` remains the connection-state hook for non-transcript resync
  (status, catalog, blocking requests). Production wires
  **`onRecoveryContextCaptured`** (checkpoint capture with `lastEventId`, once
  per gap, before any replay merge — covers transport errors, visibility hidden,
  pageshow, system resume, and online) and `onCompensation` through
  `transcript-reconnect-compensation-runtime.ts` to the registered Query
  controller. `onDisconnect` stays connection UI/state only so visibility-only
  gaps are not missed. Ready + `isReconnect === true` runs Query gap
  compensation; first ready (`isReconnect:false`) is a lightweight skip.
  Immediate/capture sets include `activeRegistry.listRetained()` scopes that may
  lack a canonical query entry.
- Runtime switch cancels compensation and `purgeGeneration` for the previous
  transport/generation identity via `subscribeRuntimeEndpointChanged`.
- Relay stays transparent: sockets still open via `openRuntimeWebSocket` with
  URL-token auth; SSE still uses bearer headers. This barrier does not change
  transport authentication.

Rules that keep this single-sourced:

- Production HTTP transcript pages enter Query only through the production
  transport fetcher → repository `http-page` (or `ensureInitial` /
  `fetchPreviousPage`). Exact one-message fills use `session.message` through
  `materializeMessage` / parent recovery (same single-flight helper). No
  production callsite fetches `session.messages` and writes a child-store
  transcript map.
- `session-message-policy.ts` is the only place a page-size number appears.
  Purpose (`initial` / `prepend` / `recovery` / `materialize`) determines the
  limit; no `RECONNECT_MESSAGE_LIMIT`-style constants exist elsewhere.
- `session-merge-strategy.ts` is the only place that resolves how one fetched
  HTTP page folds into existing transcript state. `resolveSessionMergeStrategy({
  purpose, stale })` returns a frozen `SessionMergeStrategy`; the Query
  adapter, pure reducer's apply gate, and materialization's message/part
  merge only read that value. Layers must not re-derive drop/backfill,
  insert-only/upsert, or streaming preservation from `purpose` or staleness.
- `session-message-reducer.ts` holds no SDK/Query/store side effects; it is a
  pure function so all four purposes stay unit-testable (store adapter / tests).
- UI transcript selectors read Query / TranscriptRepository projections via
  repository facades — never child-store message/part maps.
- Pagination fact ownership is exclusive: Host turn-page responses are
  **transport input** into Query; repository `SessionHistoryBoundary` is the
  **only client-side fact** for older-history availability; request lifecycle
  is `getRequestState` and must never be read for cursor/complete/loaded-turns.
- `displayParts.ts` is the only place that decides when the parts a view already
  painted may shrink. See below.

### Display part monotonicity

HTTP and SSE channels both update repository parts for a message, so a single
commit can hand the UI fewer parts than the previous commit: a `materialize`
page for a still-open assistant omits tools SSE already admitted, and a part map
is briefly empty between commits. Painting those frames removed rows the user
was watching and put them back on the next frame.

`displayParts.ts` owns the invariant, and `buildSessionMessageRecordsSnapshot` in
`sync-context.tsx` is where it is applied — the snapshot is the stable model every
view consumes:

- `allowsAuthoritativeShrink(info)` — a settled assistant (`finish` or
  `time.completed`) and every non-assistant row follow authoritative repository
  parts exactly. User rows must, or optimistic part replacement would paint twice.
- `mergePartsForDisplay(previous, incoming, info)` — while an assistant turn is
  open, parts the snapshot already published are unioned back in by part id, at
  their previous relative position. An unchanged lagging frame resolves to the
  previous array reference, so the snapshot and the turn projection behind it are
  not rebuilt.
- Explicit trade-off: a genuine `message.part.removed` on a still-open assistant is
  held until the message settles. Aborts stamp `finish`/`error`, which releases the
  hold on the next commit.

Views must not re-derive this. A render-phase hold cannot distinguish a lagging page
from a real removal, and feeding its own output back as the baseline turns a
one-frame regression into permanently stale UI. `streamingTailEntry.ts` subscribes to
repository parts for streaming text and calls the same `mergePartsForDisplay`, so
both readers agree on when a frame may shrink.

### Context panel session transcripts

- Web and Electron ContextPanel chat tabs render an in-realm strict-read-only transcript through the root `SyncProvider`. They read the same Query/TranscriptRepository transcript and directory-scoped non-transcript stores as the primary chat and do not create an independent sync lifecycle.
- Browser and preview iframe surfaces retain their existing ownership and bridge behavior.
- The direct `?ocPanel=session-chat` embedded entry remains available for compatibility, while ContextPanel chat rendering always selects the in-realm transcript.
- A panel transcript's domain identity is the normalized `(directory, sessionId)` target. Its geometry/view identity is `JSON.stringify([runtimeKey, surfaceId, normalizedDirectory, sessionId])`; `surfaceId` is scoped to normalized `(directoryKey, tabId)`. Keep these identities separate when changing viewport restoration or retained-view behavior.
- Nested panel navigation is local to the `(directoryKey, tabId)` surface. It accepts same-directory targets, maintains anchor/current/stack metadata, and never writes the primary `setCurrentSession()` selection.
- ContextPanel retains a bounded panel-local `React.Activity` cache of three transcript views and 32 MiB. The active view is touched, hidden views pause effects, estimate callbacks update their matching view, and closing a tab removes every retained nested view for that tab.
- Context panel transcript capabilities are strict read-only: nested-session navigation is available within the panel directory; composer, session mutation, and primary-selection ownership remain outside the surface. Once a viewed session is authoritatively confirmed as a child session, its fixed read-only execution footer remains mounted through temporary session-identity gaps and resets with the panel view identity. Primary `ChatContainer` (including mobile nested-session pages) uses the same confirmation rule for its read-only execution footer via `resolveSubagentReadOnlyBannerLatch`, so a live-list hide of the child row cannot flash the footer to the metadata-less banner.
- Cover planner, navigation, geometry key, cache touch/estimate/close, render-mode, and viewed-session behavior in `components/layout/contextPanelSessionSurface.test.ts`.

- HTTP page → transcript draft conversion is owned by the pure reducer
  `session-message-reducer.ts` (`reduceSessionMessagePage`). Page purpose
  (`initial` first load, `prepend` history pagination, `recovery` reconnect,
  `materialize` orphan/missing-part repair) is an input, not a second merge
  vocabulary. The reducer resolves one `SessionMergeStrategy` from
  `(purpose, liveRevisionStale)` via `resolveSessionMergeStrategy`, carries that
  strategy on `ReduceSessionMessagePageResult.merge`, and passes it into
  `materializeSessionSnapshots` through the `merge` option. Materialization
  reads message/part merge modes and streaming preservation from the strategy
  (`shouldPreserveStreamingParts(merge, role)`); it does not re-derive them from
  purpose. (A separate local role check in materialization still decides empty
  snapshots: assistant rows store an explicit `[]` renderability marker so
  materialization status can settle aborted turns; user/system rows
  keep non-empty local parts when the snapshot is empty — idle/materialize
  turn pages must not wipe a bubble that SSE already delivered — and leave the
  key absent when both sides are empty. That empty-key policy is not part of
  the merge strategy.) The reducer also performs optimistic merge,
  returns reference-stable state when unchanged, resolves the session's next
  `SessionHistoryBoundary` (`result.boundary` + `boundaryChanged`; the legacy
  flat `result.meta` is a derived projection), and emits commands such as
  `clear-optimistic`. Production commits the reduced draft into Query
  InfiniteData via the Query adapter `http-page` path; store-adapter callers
  (tests) may still commit a pure draft surface in one update. A
  boundary-only page (unchanged message references) still commits the
  boundary. The reducer never touches SDK/Query/store. Fetch errors
  (`ok: false`) preserve prior state and never write empty success.

  Strategy dimensions (`SessionMergeStrategy`):

  | field | values | meaning |
  |---|---|---|
  | `onStale` | `drop` \| `backfill` | discard the page, or still apply it as hole-filling |
  | `messages` | `upsert` \| `insert-only` | replace existing message objects, or only add absent IDs. Insert-only also copies missing terminal settle fields (`finish`, `time.completed`, `error`, and positive `tokens` when live counts are still zero) onto the live object; live terminal fields and positive tokens are never cleared |
  | `parts` | `replace` \| `skip-existing` | fetched parts are authoritative, or leave messages that already have parts |
  | `preserveStreaming` | `assistant` \| `all` \| `none` | which roles keep live parts the snapshot omits or truncates (streaming text/output, in-flight tools, and mid-turn completed tools) |
  | `protectOptimistic` | `none` \| `keep-unless-full` | unconfirmed optimistic parts (`__openchamberOptimistic`) keep the local set when incoming is slim or empty; a non-empty full snapshot still replaces |

  Resolution (`id` is a debug label, not a behavioral input):

  | purpose | stale | id | onStale | messages | parts | preserveStreaming |
  |---|---|---|---|---|---|---|
  | `initial` | — | `initial` | drop | insert-only | replace | assistant |
  | `prepend` | — | `history` | drop | insert-only | skip-existing | assistant |
  | `materialize` | — | `materialize` | drop | insert-only | replace | assistant |
  | `recovery` / `reconcile-page` | no | `recovery` / `reconcile-page` | backfill | upsert | replace | assistant |
  | `recovery` / `reconcile-page` | yes | `recovery-backfill` | backfill | insert-only | skip-existing | assistant |

  Staleness (`liveRevision > capturedRevision`) therefore downgrades two
  dimensions for recovery and reconcile-page: `messages` goes from `upsert` to
  `insert-only`, and `parts` goes from `replace` to `skip-existing`. A stale
  reconnect page still supplies messages/parts the SSE gap swallowed (`onStale:
  backfill`), but never replaces existing live messages or their already-held
  parts. Insert-only may still copy missing terminal settle fields (`finish`,
  `time.completed`, `error`) onto a live assistant so Activity can auto-collapse
  after idle/Query backfill; a lagging snapshot cannot strip fields the live
  row already has.   Current recovery/reconcile still upserts messages and replaces parts
  against server truth. Current `reconcile-page` (non-stale) additionally
  sets `protectOptimistic: keep-unless-full`. When a local message already
  holds an unconfirmed part (`__openchamberOptimistic: true`), a slim or
  empty incoming snapshot keeps those local parts as a whole — Host
  reconnect pages can carry an older server copy with a different slim
  part id, and `preferExistingFullOverIncomingSlim` only shields the same
  part id. A non-empty full incoming snapshot still replaces (authoritative
  confirmation, same as SSE `message.part.updated`). Message shell fields
  (`time`, …) still upsert. Other purposes, stale backfill
  (`skip-existing`), reset, and edit/`remove-message` are unchanged.
  Every other purpose drops the page when stale
  (`shouldDropStalePage(purpose)`), except a cold empty transcript: the first
  tail still applies so the skeleton can leave. Note the historical helper names:
  `mergeMessages` is insert-only while `mergeRecoveryMessages` is an upsert —
  the strategy field names that asymmetry explicitly.

  Known limitation: `initial` resolves to `insert-only`, so a first-screen load
  cannot refresh a message body the server has since changed for settled full
  rows. Durable-seeded tool / reasoning / file parts still schedule one
  background exact `session.message` fill when the store holds a slim part or
  the snapshot is open; settled full parts skip that fan-out. Whether to widen
  insert-only itself is a separate decision; the table makes the behavior
  visible.
  User-triggered refresh is a reconcile, not a reset: `refreshFromAuthority`
  fetches a fresh tail, then merges `{type:"http-page", purpose:"reconcile-page"}`
  with `capturedLiveRevision` taken **before** the fetch and `liveRevision` at
  apply time. It does **not** issue `reset`. After a non-stale merge it deletes
  only canonical messages that are absent from the new page, have
  `time.created` strictly later than the page's oldest message (the tail-window
  anchor), and are not unconfirmed optimistic rows (`__openchamberOptimistic`).
  Messages older than the anchor stay — a tail page must not truncate already-
  loaded history. Optimistic rows stay until server confirmation or a separate
  timeout. An empty page skips the deletion pass (no anchor). Fetch failure
  keeps the prior transcript and does not apply. `clearOptimisticShadow` runs
  only for ids actually removed. `reconcile-page` already preserves the history
  boundary / cursor / loadedTurns (Host `complete` ends a compensation round,
  not older-history exhaustion); refresh keeps that, because older-than-anchor
  pages remain.   SSE that advances revision during the pull trips
  `STALE_RECOVERY` and skips the deletion pass so live objects are not
  overwritten. The fetch is outside the
  InfiniteQuery observer, so `getRequestState` stays `ready`;
   `refreshTranscriptFromAuthority` publishes an in-flight signal
   (`transcript-authority-refresh-flight`) for mobile title hints. The whisper
   stays up only while that refresh is in flight, during cold first paint
   (no transcript yet), or while reconnecting before any messages exist.
   A loaded transcript hides it even if the socket is still reconnecting or
   the InfiniteQuery observer is still `isFetching`. Background catch-up has
   its own ref-counted signal (`transcript-resync-flight`): the reconnect
   recovery tail pull for materialized sessions in `resyncDirectoryAfterReconnect`,
   every compensation reconcile flight (`pumpDirectory`), and stale-on-observe
   `ensureInitial` mark it. The whisper means a known gap is being chased
   (disconnect, background resume, marked-stale session), so it also shows for
   warm transcripts while those flights run and clears when the last
   overlapping flight ends; every mark ends in a `finally`, so a failed fetch
   cannot strand the hint. Routine verification fetches stay silent by design:
   while foregrounded the SSE stream merges every canonical scope live, so
   hot revalidation (`runAuthorityHotRevalidate`), idle materialization, and
   the observe-time head check almost never find a diff — whispering there
   would flash noise on every session switch past their revalidation windows.
   The painted hint is smoothed at the display layer
   (`createSyncHintSmoother` in `useMobileTranscriptSyncHint`): it appears
   only after 250ms of sustained work and stays 1000ms past the last flight
   clear, because one foreground resume legitimately runs several relayed
   recovery/reconcise flights (visibilitychange, pageshow, system-resume,
   debounced online each trigger their own cycle). The flight registries stay
   exact; only the whisper rendering is hysteresis-debounced.    Desktop session context-menu
   "Sync messages", the dedicated-mobile overflow "Sync messages", and the
   mobile session row-actions sheet all call
    `refreshSessionTranscript`. Do not route those buttons through `ensureInitial`
    (enter-and-sync reconcile without the in-range delete pass) or `destructiveReset` (ensure failure blanks the chat).

- **Enter-and-sync hot revalidate.** A hot cache (canonical pages present,
  boundary known) used to make `ensureInitial` a no-op (`staleTime: Infinity`).
  Entering a session now performs one light authority check:
  - `use-sync.syncSession` and `fetchMessagesForSession` short-circuit only
    when the last successful authority pull for that
    `(transport, generation, directory, sessionID)` is younger than
    `SESSION_AUTHORITY_REVALIDATE_WINDOW_MS` (30s). The window is stamped in
    the adapter after a real successful pull — never on a failed or skipped
    load. Runtime/generation isolation is in the key.
  - `ensureInitial` on a hot cache that is **not** `activeRegistry`-retained
    fetches a fresh tail (`staleTime: 0` so the Infinity transport-page cache
    cannot satisfy it) and applies `{type:"http-page", purpose:"reconcile-page"}`
    with `capturedLiveRevision` taken **before** the fetch and `liveRevision`
    at apply time. SSE that advances revision during the pull trips
    `isLiveRevisionStale` → `STALE_RECOVERY` (insert-only + skip-existing).
    An in-flight user refresh (`isTranscriptAuthorityRefreshInFlight`), or a
    writer that dropped `liveRevision` below the capture, skips apply so the
    user-requested reconcile wins.
  - Retained scopes (repository `subscribe` / live UI) skip the hot pull —
    SSE already owns that tail. `setCurrentSession` fires
    `fetchMessagesForSession` before React commits, so the newly entered
    session is not retained yet and still revalidates.
  - Fetch failure keeps the prior transcript (Failure Is Not Empty), does not
    stamp the window, and does not surface as request `error`. Existing
    `getTranscript` data is never cleared; `getRequestState` may be `loading`
    while the check runs.
  - `refreshFromAuthority` is a user-triggered reconcile (not reset); see above.
   The chat load-error wall has no transcript to keep, so Retry calls
   `retryTranscriptInitial` (`destructiveReset` + fresh ensure) and the gate
   treats that click as `hydrating` until the reload settles.
   Busy/retry refuse only when the child-store live status is busy/retry.
  Sticky global fallback busy (missed idle, no mobile tray snapshot) must not
  disable refresh. Send self-heal: if the event stream has been silent past
  the stale threshold, `waitForConnectionOrThrow` reconnects before trusting
  `isConnected`; a hung prompt times out and requests the same reconnect so
  "Sending message" cannot stick forever.
- Production application orchestration for transcript pages is owned by
  `transcript-repository-production.ts` + the Query adapter: Host turn-page
  via `fetchProductionTranscriptTransportPage` (policy limit, parent recovery,
  abort signal), then repository `http-page` / InfiniteQuery
  `fetchPreviousPage` / `ensureInitial`. Stale pages gate with
  `shouldDropStalePage(purpose)`. Loading / ready / error status lives on
  repository `getRequestState`. Pure `reduceSessionMessagePage` remains the
  model for merge math (Query adapter and test store adapter).
- Canonical transcript InfiniteData lives in QueryCache under
  transport/generation/directory/session keys. SSE/WS enter only through
  repository `sse-event` (not as raw transport-page cache entries). Runtime
  switches cancel compensation and `purgeGeneration` for the previous identity;
  stale generation results never commit.
- Session selection / ensure / reactive sync share Query single-flight for the
  same scope so mount/remount must not issue duplicate tail requests, and a
  smaller concurrent request must not satisfy a larger request.
- `queries/sessionStatusQueries.ts` owns runtime- and directory-scoped
  `/session/status` pull snapshots for reconciliation. Its Query entry uses
  `staleTime: 0`, forwards the Query abort signal, and shares one in-flight GET
  across concurrent callers with the same transport and directory. Query data
  carries the request-start timestamp created inside the shared `queryFn`, so
  every joined caller applies the same conservative authority boundary.
- `queries/sessionActiveQueries.ts` owns process-global
  `v2.session.active` (`GET /api/session/active`) single-flight keyed by
  transport identity **and** runtime generation (no directory). Concurrent
  directory reconnect and post-message-pull callers on the same
  transport+generation share one HTTP request; a new generation never reuses
  an older in-flight request or cache entry. Query completion is gated by
  `assertRuntimeCurrent` so a superseded generation cannot commit.
  `client.getSessionActive()` returns a three-state result:
  - `supported` — HTTP 200 with a strict `{ [sessionID]: { type: "running" } }` map
  - `unsupported` — HTTP 404 / 405 / 501 (older OpenCode)
  - `unknown` — 401, 5xx, network, or malformed body (never empty success)
- `session-status-reconciliation.ts` owns authoritative status snapshot fuse and
  post-message-pull convergence. Each resync issues **parallel** directory
  legacy `/session/status` and process-global active membership pulls, then
  fuses them (`fuseActiveWithLegacyStatus`):
   - active running + legacy retry still inside `next` → keep retry metadata
   - active running + expired retry → busy (the attempt has resumed)
   - active running + busy / absent → busy
  - active supported + absent from membership → idle (stale busy converges)
  - active supported + absent from membership + `tailOpenSessionIds` → keep
    retry metadata when legacy is retry, otherwise busy (open transcript tail
    is authoritative that the turn has not settled; membership alone may be
    incomplete in a reconnect window)
  - active unknown / unsupported → legacy only
  - both unusable → preserve prior status; **do not** advance
    `session_status_snapshot_at`
  - active supported with a failed legacy load still fuses (empty legacy map)
  - fuse scope is directory-local only: `candidateSessionIds` ∪ this
    directory's legacy status keys. Pure process-global membership IDs from
    other directories are never written into the wrong child store
  - empty candidates + failed legacy + active listing only foreign IDs →
    preserve prior status; **do not** advance `session_status_snapshot_at`
  After each terminal reconnect-compensation outcome for an immediate session,
  the production stack confirms directory session status once so the child
  store can re-derive live busy from the transcript tail. Destructive resets
  of the same session are deduped within a short window and degrade to a
  non-destructive ensure-tail when the host repeatedly returns `resetRequired`
  for a long-running turn.
  Authority boundary uses the earlier of the two request-start timestamps so
  SSE/WS status observed during either in-flight window keeps precedence via
  `session_status_observed_at`. Unknown session IDs are never invented outside
  the candidate + directory-local snapshot apply set. Only a successful
  fused/legacy boundary with at least one directory-local apply ID advances
  `session_status_snapshot_at`. After such a successful apply, the module
  converges the global busy/retry fallback for the same directory and apply-id
  set, building the payload from **post-apply** child-store status so live
  SSE/WS that won via `session_status_observed_at` stays preferred over the
  older snapshot (non-idle entries only; absence within apply IDs means idle).
  Failed loads, unusable dual paths, empty apply sets, and stale resyncs
  **do not** converge — they preserve the existing global busy/retry fallback.
  Session selection, reactive sync, forced sync, reconnect, and materialization
  share the Query request layer. Idle, empty, history, stale, and superseded
  pulls add zero status requests.
- `session-todo-projection.ts` seeds `store.todo` after transcript hydrate
  without a new HTTP round-trip. Live `todo.updated` remains authoritative;
  projection only fills a missing key from the newest loaded todowrite/todoread
  part. Cache-reuse session opens still seed, because eviction can drop
  `store.todo` while Query still has the transcript.
- `opencode-event-normalizer.ts` is a pure transport-ingress normalizer that
  runs **before** directory resolution and coalescing. It accepts legacy
  `{ type, properties }`, current `{ type, data, location, durable }`, and
  global `{ directory, payload }` envelopes; strips versioned type suffixes
  (`session.status.1` → `session.status`); drops durable `sync` replicas so the
  same logical event is not consumed twice; maps current `session.status` into
  the legacy Event reducer contract; and exposes admission / domain-activity
  hints for   `session.next.*` without inventing `message.part.*` events.
  `event-pipeline.ts` keeps `/global/event` WS/SSE + Relay (never
  `client.v2.event.subscribe`). Current `session.next.*` frames emit
  `onNormalizedEvent` only and skip the legacy reducer queue. Canonical
  `session.status` still enters the reducer and coalesces per session.
  `sync-context.handleNormalizedOpenCodeHints` issues **one** bounded
  repository materialize / ensure for the currently viewed session on terminal
  `session.next.step.ended` / `.failed` only.
- **P2 promptAsync admission gate (documented, not switched):** OpenCode 1.18
  `v2.session.prompt` does not yet expose a per-item immutable
  provider/model/agent/variant admission contract matching OpenChamber's direct
  send and durable queue requirements. Direct-send and the durable message
  queue therefore remain on `promptAsync`. Do not implement a pseudo-atomic
  `switchAgent` / `switchModel` then `prompt` path as a substitute.
- Session materialization coalescing is scoped to the owning directory store.
  A remounted `SyncProvider` must start its own commit path even when the
  runtime, directory, and session ids match an old in-flight request; transport
  single-flight can still share the HTTP response, but the new store must not
  reuse a promise that only commits into a detached store.
- Product **`limit` means authored-user turns**, never message count. Budgets are
  **link-tiered** via `isRelayModeActive()`: **local/LAN** first paint **6** turns
  and prepend **4** turns; **Relay** first paint **2** turns and prepend
  **4** turns. Repository pagination `loadedTurns` accumulates turn budgets
  across pages. Host→OpenCode message
  scan chunk is **server-owned** (`_inner_scanLimit` /
  env `OPENCHAMBER_SESSION_TURN_SCAN_LIMIT`, default 100); the shared client
  omits `scanLimit` on the wire. Optional client `scanLimit` remains an
  explicit override only. Initial / recovery / materialize / selection use the
  production transport fetcher →
  `GET /api/openchamber/sessions/:id/messages?turns=…` (no scanLimit by default)
  and commit via repository `http-page` / `ensureInitial`. Policy lives in
  `session-message-policy.ts`. Incomplete Host pages may recover missing parent
  user messages by exact ID (up to eight). A missing or failed parent fetch is a
  miss: the Host page stays, and one 404 must not fail the initial transcript.
  Authoritative complete pages skip parent recovery. Loading failures are
  subscribable via repository request state and preserve prior ready records.
- Message loading status is runtime-scoped on the Query repository. Reactive
  ensure/selection share Query single-flight so a remounted provider does not
  dual-commit a shared transport response into a detached child store.
- Older history is user-driven pagination only. Prepend uses one Host turn-page
  request (`turns=4` local/LAN and Relay) via
  `fetchTranscriptPreviousPage` → Query `fetchPreviousPage`
  (`cancelRefetch:false`). Callers must pass the session's workspace
  `directory` into pagination reads and fetch helpers so cross-project sessions
  resolve the correct Query scope — using only the primary sync directory for a
  cross-project session yields the wrong scope. Repository
  `SessionHistoryBoundary` (`unknown` / `has-more(cursor, required non-empty)` /
  `exhausted` plus cumulative `loadedTurns`) is the **only** client fact for
  older-history availability. UI reads it through
  `useSessionTranscriptPagination` (and related request state via
  `useSessionMessageLoadState`); Chat / Context call
  `fetchTranscriptPreviousPage` directly (no production `sync.loadMore`).
  Every successful initial/prepend/recovery/materialize page commits
  message/part/boundary into Query — even when message references are unchanged.
  Failures keep the last known boundary and only flip request status to error;
  stale generation completions never commit. Live append never mutates the
  older-history boundary. Query `purgeSession` removes transcript families on
  `session.deleted`, temporary SmartFetch-secondary cleanup, and ordinary
  eviction — no orphan boundary survives its session, and the next visit reads
  `unknown`. Explicit load-earlier refreshes the authoritative tail once when
  the boundary is `unknown` (via `ensureTranscriptInitial`), then prepends from
  the recovered cursor; persistent cursor absence and request `status=error`
  surface to user-initiated load-earlier as `chat.history.loadOlderFailed`. The
  client asserts a strict page contract: each record is an object with non-empty
  `info.id` and optional `parts` array; `turnCount` is an integer in
  `0..requestedTurns`; `complete=true` requires `cursor=null`, `complete=false`
  requires a non-empty cursor string; empty cursor strings and `partial:true`
  are rejected. The pure reducer additionally enforces the **cursor progress
  invariant** for incomplete pages: an empty page makes no progress, and a
  prepend whose response cursor equals the previous `has-more` cursor would
  paginate the same window forever — both are page contract errors. A contract
  error behaves like a failed load: no commit, previous
  boundary/messages/loadedTurns preserved exactly, request status error, later
  retry can still converge. Legal cursor advances accumulate `loadedTurns` per
  prepend; a final `complete=true` page resolves to `exhausted`.
  Host `scanLimit` is not sent by default. Refetch 100 and send-confirmation 30
  are unchanged. The chat timeline controller issues at most one Host turn-page
  request per user interaction (desktop near-top scroll or explicit upward
  intent; mobile top button). Explicit load-earlier is TanStack
  `useMutation`-owned (`chatTimelineLoadEarlierMutationKey`); UI busy is
  `mutation.isPending` for the active session (plus local auto-fill state),
  never background `historyLoading` alone which can stick on Relay. Concurrent
  wheel bursts share one in-flight chain via a synchronous loading guard;
  fetches check `historyLoading` and cancel viewport-anchor hold only while
  still owning the armed snapshot. Active desktop transcripts may auto-fill
  earlier history while the first paint stays short
  (`scrollHeight ≤ clientHeight + 48`) and `canLoadEarlier` is cursor-backed;
  height-only geometry so collapsed stacks keep filling without expand-first;
  owned by TanStack Query (`chatTimelineAutoFillQueryKey`) rather than a
  `useEffect` chain; no-growth/failure blocks further auto-fill for the session;
  successful short pages re-arm via query-key edge movement. That path does not
  release auto-follow. Timeline handlers use `@reactuses/core` `useEvent`.
- Composer session mention search filters every loaded global active-session
  summary across projects, while the empty menu keeps three recent suggestions.
  Opening the mention menu performs no referenced-session fetch. Selecting a
  session lazily materializes its bounded identity snapshot in its owning
  directory before inserting the durable reference, then kicks a background
  full-transcript prefetch (failures fall back to the send-boundary retrieval
  card). Sending resolves each referenced session at the owner boundary and
  adds a hidden reference part that is self-describing: every entry carries the
  stable session ID, display title, owning directory, and messages inlined
  from the client cache when loaded — an empty messages array means not-loaded,
  never an empty session — and the instruction prefix embeds a verified
  read-only SQLite recipe (candidate DB paths plus the exact query) so the
  receiving assistant can retrieve any referenced transcript itself, because
  the server API is auth-gated and no session-reading tool exists. Delivery
  compilation also matches visible `@<title>` labels in authored text against
  loaded session summaries (the same matching the sent-message display
  fallback uses), so pasted or copied references still deliver session
  semantics; canonical `@session:<id>` tokens and matched titles dedupe by
  session ID. The textarea stores visible Session labels plus DraftRecord
  sidecars containing stable Session IDs. Sending resolves each sidecar at the
  send boundary into stable Session identity and visible sent text
  `@<session title>`.
- A rejected shared request is removed from the coordinator so the next
  explicit/reactive attempt can retry; failure must never be cached as an empty
  authoritative history.
- Reconnect recovery may poll lightweight status for multiple active sessions,
  but it materializes `session.get` plus one transcript ensure/recovery page
  only for the currently viewed session (status path) while Query reconnect
  compensation covers gap reconciliation for retained scopes. Message pages for
  reconnect (`purpose: "recovery"`) and orphan/ensure materialization
  (`purpose: "materialize"`) go through the production transport fetcher →
  repository `http-page` / `ensureInitial` (policy limit, single-flight,
  assistant-tail recovery, pure merge, request state, stale/live revision).
  Failure and skipped loads preserve the existing transcript. Viewed-session
  materialization requires only a matching directory; it must not depend on the
  session already appearing in the reconnect candidate list or child-store
  catalog. Background busy sessions wait until selection and continue receiving
  live events without fetching their bodies. `statusOnly` reconnect (clean first
  stream ready only) still runs this bounded viewed-body recovery and an
  authoritative blocking-request resync (`question.list` / `permission.list`);
  it only skips heavier reconnect work such as full routing ingest, never viewed
  transcript reconciliation. A viewed session whose transcript still has an
  unanswered `question` tool while `state.question[sessionID]` is empty lists
  once via `useRecoverPendingQuestions` (`resyncBlockingRequestsForDirectory`
  scoped to that session); it never invents a `QuestionRequest` from tool
  parts. Ready + `isReconnect:true` triggers Query
  compensation after replay; first ready skips gap compensation.
- A real reconnect and every transport switch can gap **every** cached
  transcript in an initialized directory, not just the viewed session.
  Recovery-context capture writes Query checkpoints before replay; ready +
  `isReconnect` drives compensation for retained/canonical scopes. Runtime
  switch explicitly cancels compensation and `purgeGeneration` for the previous
  transport/generation. Known repository boundary and cached transcript stay as
  last-known UI facts until compensation or ensure converges; no eager body
  fetch is required on every background session during resync. `statusOnly` is
  resolved by `resolveReconnectStatusOnly` and qualifies ONLY for a clean first
  connect (no disconnect before it) — a disconnect racing the first connect is a
  real gap regardless of boot recency and takes full reconnect semantics. A
  failed viewed-session recovery keeps the boundary and request error so the
  next entry still refetches; a successful pull commits new messages+boundary
  and restores ready.
- Reconnect recovery gates session identity and the message body on separate
  live revisions. The identity revision is captured before `session.get`; the
  body revision is captured after it returns. A missing session or live events
  landing during `session.get` skip only the identity write. Sharing one
  revision strands the transcript of a session that keeps streaming, because
  every `session.get` round trip loses the race and aborts body recovery.
- A bounded bootstrap may omit a selected session. `ensureSessionRenderable()`
  accepts an explicit target directory for this exact materialization path. It
  creates that directory child store with `bootstrap: false` for non-transcript
  identity, uses that directory's scoped SDK client for `session.get`, and
  commits identity into the child store while transcript materialization goes
  through Query ensure / `http-page`. Message readiness and session identity
  remain independent: a ready transcript page with missing identity still
  performs the exact identity read.
- Snapshot-revision and live transcript SSE commit through repository
  `sse-event` (and related ensure/materialize). Each event is applied to
  every current-runtime canonical scope for that session, not only the
  single resolved directory. Repository pagination and
  request state own older-history facts and flight status. An `unknown`
  boundary always ensures; a known boundary retains UI facts while background
  ensure/compensation may refresh. The next `syncSession` / selection ensure
  performs one bounded tail ensure through Query when needed; merge is
  reference-stable when unchanged, so same-size completed parts replace
  truncated live text. On `session.idle` for the **active** top-level session
  (`setActiveSession` directory/session identity, not window focus),
  `handleEvent` enqueues one bounded `session-idle` materialization; background
  top-level idle stays zero-request; child idle still materializes the parent
  (`child-session-idle`). Idle materialize captures live revision before the
  HTTP round trip and drops the page when SSE advanced while it was in flight.
  Query `structuralSharing` (`shareSessionTranscriptData`) re-merges a same-
  length or collapsed tail through insert-only `materialize` so a lagging Host
  snapshot cannot replace a live last turn the stream already admitted, while
  still filling `finish` / `time.completed` / `error` the live row is missing.
  A same-length **ref-stable subset** (`remove-message` / `message.removed`)
  is kept: remaining message/part objects are the prior refs, so it is not a
  rebuilt lagging tail.
  Events missed during a suspend with no SSE delivery
  remain covered by reconnect compensation + viewed-session recovery.
  A lost settle tick — tail assistant with a server-stamped terminal finish
  (`stop` / `length`) but no `time.completed`, or a confirmed `stop` with
  `time.completed` but no positive token counts (tokens half of the settle
  tick lost), detected via `hasTailAssistantMissingSettledCompletion` —
  self-heals through
  `refreshTranscriptFromAuthority` (reconcile upsert, never stale-dropped):
  a cooldown-suppressed materialization enqueue re-checks the gap one
  microtask after the event frame (transcript SSE batches commit at flush
  end), and a completed materialization re-checks after its page applies.
  Without this repair, turn duration and assistant TPS stay missing until a
  cold start because the transcript stall watchdog only runs while the
  session reports work.
- The client stall timer starts before SSE response headers arrive. Transport
  activity includes SSE comments and heartbeats, iterator events, and every
  WebSocket message frame. A transport stale watchdog reconnects after this
  activity expires; quiet heartbeat streams remain healthy.
- A viewed `busy` or `retry` session records message and part domain activity.
  Fresh transport with no such activity for 60 seconds triggers one directory
  recovery per minute. Recovery reuses reconnect materialization, so only the
  viewed session receives `session.get` plus one runtime-sized message page.
- Domain activity and recovery revisions resolve only from an event's explicit
  session identity or an indexed message identity. Orphan materialization keeps
  its active-session fallback without affecting domain health or recovery
  freshness. Recovery captures a monotonic per-session live revision and skips
  its session/message commit when a newer live event arrives before HTTP settles.
- Current (non-stale) recovery/reconcile upserts fetched-tail message metadata
  with the authoritative server snapshot, including completion, finish, and
  token fields, and uses `parts: replace` with `preserveStreaming: assistant`
  so live assistant parts retain precedence until an authoritative completed
  snapshot arrives: streaming text/output is never truncated by a lagging page;
  in-flight tool/reasoning parts omitted by the page are kept; while the
  snapshot message is still open, earlier completed tools omitted by a partial
  mid-turn page are also kept (so Activity tool rows do not flicker away during
  inference); same-id hollow tool snapshots cannot regress richer live
  status/input/output. A settled message snapshot remains authoritative for the
  part set. Stale recovery/reconcile backfill is insert-only for messages and
  skip-existing for parts: it only adds missing messages and missing part
  buckets, never rewrites existing live parts (including completed /
  non-streaming state that `preserveStreaming` alone would not protect against a
  lagging in-flight HTTP page). Local messages outside the bounded tail remain
  intact in both cases.
- `getSessionMaterializationStatus` does **not** treat a trailing *open*
  assistant (no `time.completed` / `finish`) with missing parts as unrenderable.
  Live multi-step turns emit `message.updated` before the first `part.updated`;
  counting that gap as missing flipped `hasRenderableSessionSnapshot` false and
  re-fired `ensureSessionRenderable` → thrashing `GET .../messages` mid-turn
  (Performance traces showed 5+ messages pulls within ~4s of one prompt).
- A later `message.updated` for an existing message is merged, not wholesale
  replaced. Token/cost/time ticks that omit `agent` / `mode` / `providerID` /
  `modelID` / `variant` keep the identity already stored so the assistant
  header cannot flash between a model name and the empty `Assistant` fallback.
  The same identity preservation applies to every transcript write seam that
  replaces existing messages — HTTP `recovery` / `reconcile-page` upserts
  (`materialization.ts`) route through `mergeTranscriptMessageUpdate` too, so
  a fetched snapshot can refresh content without blanking identity a live
  event established. String identity fields (`agent` / `mode` / `providerID` /
  `modelID` / `variant`) keep omit-preserves-existing semantics; object
  `model` (UserMessage since OpenCode 1.4.0 — carries nested `variant`) is
  retained wholesale when incoming omits it and replaced wholesale when
  present, never run through string emptiness checks that would delete it. Assistant-header display additionally keeps a bounded
  last-known-identity cache per message id (`ChatMessage.tsx`) so a remounted
  row renders stable identity before authoritative fields arrive, and client
  diagnostics record `identityMissingCount` / diff `identityLost` (facts
  only, never values) to make any remaining loss visible in exports.
- A WebSocket-to-SSE fallback enters connecting or reconnecting state. Connected
  state publishes after the fallback SSE stream reports its real connection.
- A successful directory status snapshot records its conservative request-start
  time. Historical assistant/tool activity that started before that boundary and
  is absent from the active-only snapshot resolves as idle. Activity created
  after the boundary waits for live status, and a failed snapshot preserves the
  previous unresolved state.
- The periodic status watchdog polls only sessions with live `busy` or `retry`
  status. Historical incomplete messages participate in one-shot reconnect
  recovery without keeping a directory on the five-second polling path.
- Network session-detail and message-page reads for the current selection use
  high fetch priority; background materialization of other sessions does not.
  Broad
  cold-start discovery reads (status, config, Git, quota, and bounded session
  lists) use low priority, so opening a chat is not stuck behind an already
  queued bootstrap burst. This is only a direct-network scheduling hint; relay
  request ordering and request payloads are unchanged.

## Runtime endpoint lifecycle

- A runtime transport identity change means the normalized direct endpoint URL
  or relay descriptor changed. A direct-runtime key alias on the same endpoint
  is storage metadata, not a transport change, and must not reset app state or
  remount `SyncProvider`.
- Updating a bearer token or request headers for the same endpoint is a
  credential refresh, not a runtime switch. It must update transport auth in
  place without re-running global bootstrap, authentication checks, or opening
  another global event stream.
- Startup host restoration can publish several intermediate endpoint identities
  in one short burst. App reset and authentication consumers coalesce that burst
  and apply only its final identity; never remount `SyncProvider` once per
  intermediate host/token state.
- TanStack Query owns runtime-scoped pull server state. Query keys begin with
  transport identity and append feature scope such as directory or quota
  provider. A transport identity change clears the Query client.
- Agent and command queries scope by transport identity plus configuration directory.
  Each resolves scope metadata through one bounded batch request; a metadata refresh
  failure retains the prior complete query snapshot for that key. Directory bootstrap
  does not fetch the command catalog; composer, settings, and slash routing consume
  the shared TanStack Query entry.
- Quota runtime reset clears rendered results, fetch state, errors, and active
  refresh generations. Provider refreshes commit independently, preserving
  successful provider results while exposing a failed provider error.

### Queue transport and admission invariants

### Queue server shared-UI lane (Phase 2)

Each TanStack card mutation variable and exact scope key include the runtime transport and generation. Its mutation function compares that capture with the current runtime before calling a headless action, and an old runtime resolves as stale. An A→B→A transport sequence receives a fresh generation for the final A lifetime, so pending mutations from the earlier A lifetime never lock the new generation.

`messageQueueQueries.ts` owns server queue catalog, revision-pinned scope pages, and capability reads through TanStack Query, including imperative `ensure`/`refresh` helpers so non-React observers share in-flight GETs. Queue query keys start with transport identity; scope pages contain at most eight items and fetch every `nextOffset` under the first-page revision. Failed page sequences retain the prior complete scope snapshot. `message-queue-server-runtime.ts` is a headless attachment surface with exact-scope reads only. Production status and snapshot pulls go through those Query helpers (status honors staleTime; tip/mutation snapshot pulls force network but still coalesce). Scope page GETs (`fetchMessageQueueScope`) single-flight by scopeID+offset+limit+expectedRevision so concurrent startup observer and cutover refresh share one network request per page. Successful status, catalog, and scope reads write their transport-scoped Query keys. Descriptor state and stable scope snapshots bind their captured transport identity, and a direct identity read clears them before a delayed runtime-switch callback runs. `getScope()` reads a stable complete current-scope reference from Query data. A successful empty catalog clears queue scope cache, and removal of one catalog scope clears every revision key for that transport and scope; failed polls and failed later pages preserve prior complete data. Local attachments upload bytes, server attachments retain their canonical server path and authoritative byte size, and VS Code attachments close server admission. SSE revision tips (`openchamber:message-queue-changed`) arrive through the shared `runtimeFetch` streamed-response transport, including Relay tunnels, then trigger a snapshot GET; only scopes with a changed revision are page-loaded, with abortable exponential backoff on failures. Its lazy singleton performs no fetch or storage work at import; AppEffects starts it, installs one ref-counted runtime-switch observer, and releases both on cleanup. `useMessageQueueServerScope()` subscribes to its exact scope and returns capability, authority, import state, hydration, scope items, and actions. Available active authority selects server mode directly; `canActivate` remains the Phase 3 activation gate. Shadow and unsupported states expose legacy mode. Phase 2 keeps v3 production authority and auto-send active. Client queue mutations are overwrite intent for the scope the client saw: after each commit the runtime replaces display state with a complete authoritative scope, and a reorder conflict reapplies the visible order while retaining rows appended by another device after that visible subset. Removing an active attempt discards queue tracking only; it cannot unsend a request that already crossed the upstream boundary.

Message-queue scope-page transport single-flight keys include the resolved runtime endpoint, scope ID, paging parameters, and expected revision. A runtime endpoint switch therefore cannot reuse an in-flight page from the previous endpoint even when scope IDs collide. A server runtime constructed with an injected QueryClient derives its default status and snapshot pulls from that same client and its captured transport identity.

Server admission publishes an exact-scope, headless pending shadow. ChatInput may call `stageAdmission` with a stable request/queue identity before any await so chips appear immediately; `admit` reuses that identity (no duplicate chip). When `admit` is called without a prior stage, it still publishes the shadow synchronously before attachment upload. `unstageAdmission` drops a staged shadow when flush/compile fails before commit. The shadow is outside TanStack Query and carries only display-safe admission fields plus an uploading, admitting, ambiguous, or acknowledged phase. `hasPendingAdmission` includes every shadow for visibility and diagnostics; `hasBlockingAdmission` identifies uploading, admitting, and ambiguous phases for telemetry only and never disables Composer send, queue admission, or existing queue controls. Multiple client admissions may coexist; each owns its immutable request identity and resource capture. Upload, each idempotent POST attempt, and acknowledged reconciliation have independent bounded deadlines; failure removes only that shadow and preserves its captured Composer resources. Its acknowledged shadow remains visible through authoritative convergence or until the bounded reconciliation attempt settles. Targeted background scope paging reconciles the authoritative projection without status/catalog refreshes or global hydration/error updates. An acknowledgement reuses an already complete authoritative scope at its revision and skips a duplicate targeted GET. Authoritative rows win duplicate queue IDs, and a complete scope revision at or beyond the acknowledgement revision clears its acknowledged shadow, including worker-claimed or completed rows. Scope cache publication precedes pending cleanup, so exact-scope readers retain a readable authoritative scope through convergence. Runtime transport reset clears pending shadows, notifies every pending exact scope, and delayed work remains generation-scoped.

Full catalog reads page every changed scope before one monotonic commit. The commit compares the incoming catalog revision against the cached snapshot and every current scope revision, then preserves newer Query and descriptor references when an older result settles late. Targeted reconciliation commits only its captured scope and retains sibling descriptors and pages. Failed page sequences preserve the prior complete authoritative snapshot.

`queuedMessageChipsState.ts` owns the pure UI data contract for server queue chip state. It exports `ServerQueueOperationKind` (`edit | send | remove | reorder`), exact-scope pending-operation selectors, committed-ack-revision send shadows (`selectCommittedSendShadows`), and ordered optimistic projection helpers. Every client mutation enters the TanStack Mutation Cache immediately, so edit/remove hide their target, pending/committed send overlays leave the waiting row visible in a "Sending…" state (matching pending-admission "Queuing…"), and reorder replaces the visible authoritative order without waiting for the previous network write. Reorder requests retain every authoritative scope ID and move visible waiting IDs only through visible slots, so hidden tracking rows keep their server positions. The network mutations then drain serially by exact runtime generation and queue scope; another session has an independent lane. After a send mutation succeeds, `MessageQueueServerMutationResult.committedRevision` (from the action receipt, retained even when post-commit scope reload fails) keeps the same exact runtime generation/scope send overlay selected for "Sending…" UI ownership until the authoritative scope revision catches up, the runtime switches, or the success mutation is cleaned from the cache—so the chip stays visible between pending end and authoritative `manualDispatchRequested` without flashing Send back. Chips hide only after authoritative `sending`/`reconciling` (or removal/confirm). Client send-pending presentation times out after `SERVER_QUEUE_SEND_PENDING_TIMEOUT_MS` (8s) and restores clickable Send when stuck without reaching sending/reconciling/removal; a later pending send starts a fresh cycle. Legacy dispatch rows (`sending`/`reconciling`) use the same chip "Sending…" presentation and 8s client timeout while optimistic transcript paint is unconfirmed. The overlay never writes the revision-pinned Query cache, and a failed/aborted operation removes only its own intent so authoritative reconciliation restores the affected row. `isServerQueueItemDispatchPending` returns true for an authoritative `MessageQueueItem` whose `manualDispatchRequested === true` (manual Send POST acknowledged but the worker has not yet started) or whose status is `sending`/`reconciling`; `isServerQueueItemActiveAttempt` is narrower and returns true only after the POST boundary. Active attempts disable only their own Send and drag actions; Edit may restore the captured payload to the draft and Remove may discard the tracking row even though neither action can unsend an upstream POST. They do not globally disable waiting-row edit, remove, manual send, reorder, pending admission, or another client mutation; a waiting manual intent remains client-mutable and shows "Sending…" (not clickable Send) until authoritative `sending`/`reconciling`/removal, or until the 8s client timeout restores Send so the user can retry. Revision and row-version conflicts are internal convergence signals: the client reloads the exact scope and replays the same desired operation with a bounded retry. `MessageQueueItem.manualDispatchRequested` is optional and parsed strictly: a missing field reads as absent, `true`/`false` are accepted, and any other type is rejected as a malformed authoritative response.

The server observer leads once with an authoritative status+snapshot GET (via Query), applies scope pages when the catalog diverges, then waits for the next SSE tip. Each loop iteration leads with another GET and re-GETs after paging until the catalog revision is stable, so tips published while pages load or between unsubscribe and the next wait cannot leave a stale sending/reconciling chip after confirm-by-message. Tip waits use the max of the cached snapshot revision and every loaded scope revision. Shared `openchamberEvents` keeps a module-level latest revision watermark per tip domain (`session-index-changed` | `message-queue-changed` | `assistants-changed`); `waitForMessageQueueInvalidation` registers its listener first, then reads that watermark so a tip delivered while only peer domain listeners held the SSE open still resolves as `tip`. A 15s safety timeout returns `timeout` for silent frame drops / transport gaps and is treated like tip/ready (authoritative GET, continue). Runtime endpoint changes clear watermarks before reconnect so A→B→A and LAN/relay switches never inherit an old tip. Relay still uses the shared runtime SSE path. `start`/`stop` are ref-counted with a zero-delay deferred stop so React StrictMode cleanup+remount reuses the first observer. Cutover prefers the status written by `server.refresh()` and does not issue a second status GET when the Query cache is warm; worktree-order shares the same snapshot Query helpers. `remove` treats authoritative `not_found` as a committed delete after reloading the scope. Runtime changes abort its observer and isolate Query cache identity. The observer captures runtime generation for each snapshot, tip wait, upload, and mutation. Web, Electron, hosted mobile, and Capacitor use the server-capable route; `501` marks capability unsupported, and VS Code retains its legacy fallback. Active and paused server authority use the manual-send CAS endpoint; paused promotion moves the item to the queued head with a due time of now while the worker remains stopped, and resume dispatches that promoted head. A mutation conflict reloads only the mutated scope before one retry; sibling scope descriptors stay on their last loaded revision so unrelated queues do not render empty. After a committed mutation (including manual send), the client always reconciles that scope from the latest snapshot instead of pinning pages to the mutation revision, so a worker claim cannot regress descriptors into an empty chip list. A failed mutation still best-effort reloads the scope before surfacing the error. Scope advancement after a committed response preserves the original idempotent request as a single execution. Shadow and unsupported authority delegate to the explicit legacy callback. Server authority stays `shadow` and its worker stays paused throughout Phase 2. The v3 production queue remains authoritative until Phase 3 activation.

`message-queue-shadow-import.ts` hydrates the v4 runtime read-only and constructs stable scope/item ordinals, canonical payload hashes, snapshot hashes, and manifests without mutating the local ledger. It materializes or uploads canonical attachment payloads, creates a protocol-4 import, stages every payload, and seals the manifest. Payload tokens release through one `finally` path. `message-queue-cutover.ts` owns the headless external-store cutover lifecycle: probing, legacy-unsupported, server-active, server-paused, and blocked ownership; freezing, staging, activating, late-importing, complete, and error migration states. It freezes admission while shadow staging, calls injected quiesce/flush barriers, activates sealed shadow imports, and commits late imports after active or paused ownership. A lost commit response confirms through status epoch and manifest. Only HTTP 501 enables legacy ownership; transport and authorization failures remain blocked with backoff. Runtime switches abort the old flow and isolate the next transport. Phase 3 binds every cutover publication to the v3 ownership gate and mutation fence. The module starts quiescing; only HTTP 501 enables v3 dispatch and user mutations. Quiescing blocks new dispatch before begin and immediately before POST, waits for dispatch and reconciliation flights, resolves and atomically binds every unbound legacy scope, then flushes persistence and captures the final v3 ledger. A server-active or server-paused transport enters the retired transport set, so its bound scopes remain read-only while a newly selected HTTP 501 transport opens its own v3 queue. Existing sending rows retain internal confirmation and failure settlement before retirement.

Cutover refreshes are single-flight, and `start`/`stop` use the same deferred-stop pattern as the server runtime so StrictMode does not abort an in-flight first refresh. A committed import response completes directly without staging or committing again. Importer pending, degraded, and transient failures preserve the current shadow or server-authoritative source and retry with exponential backoff. Activation conflicts re-read authority, retain server ownership, prepare the current local snapshot, and append it as a late import.

- `message-queue-runtime-controller.ts` owns the v4 queue runtime snapshot,
  hydration state, mutation serialization, and scope-reference stability.
  `message-queue-runtime.ts` exposes a lazy default facade. Importing it and
  obtaining the facade perform zero storage, migration, hydration, or
  reconciliation work; explicit `hydrate()` opens that durable boundary.
  Every mutating call captures its runtime at the public API boundary; a queued
  serialized operation retains that capture through blob and metadata work.
  `message-queue-dispatch.ts` is the dependency-injected v4 dispatch boundary.
  It owns send acquisition, durable sending/reconciliation transitions, exact
  confirmation, and the pure one-head-per-scope scheduler planner.
  The v3 production queue remains authoritative until the Lane 4 atomic cutover.

- `queue-attachment-coordinator.ts` owns queue and send blob references. Queue
  references use `queueItemID`; temporary send references use `operationID` and
  monotonic BigInt-derived string acquisition tokens. Token-matched release owns send cleanup.
  Admission acquires queue references before persisting v4 metadata and rolls
  them back on a failed write. Removal persists metadata before releasing both
  reference classes; release failures enter its retryable cleanup ledger.
- The coordinator serializes every operation and validates runtime transport,
  generation, and currentness before commit. The v4 ledger is authoritative for
  queue desired references during hydration/reconciliation. Live reconciliation
  includes active send references; startup reconciliation begins with an empty
  send desired set and clears stale send ownership. Cleanup entries are discarded
  when the same queue or send reference becomes desired again. Composer sidecars
  remain immutable through queue transitions. Admission validates Composer image
  resource identities against attachment occurrence IDs; Session and Paste
  references currently have no attachment identity.
- A metadata write that completes as the runtime becomes stale still becomes the
  controller's durable baseline before the caller receives its `stale` result.
- Partial or corrupt v4 hydration enters a recovery-required read-only state.
  Valid rows from a partial snapshot remain visible, while every metadata or blob
  mutation waits for a complete authoritative hydrate. Disabled hydration reads
  and seeds the baseline while performing zero blob mutations and metadata writes.

- Queue ownership uses stable transport identity plus directory and session ID.
  The v3 ledger address (`queueScopeKey`) is exactly that tuple plus the delivery
  target. Runtime generation must never enter it: rows persist in `localStorage`,
  while generation only counts transport switches inside one process, so an
  A→B→A bounce (LAN⇄relay, host restore) would re-address rows that still belong
  to the same endpoint and strand them until a restart reset the counter. It
  stays on the owner as staleness metadata, and hydration re-keys every persisted
  row from its own owner, so rows stranded by an earlier encoding are recovered.
  Queue admission captures an OpenCode-compatible `msg_` message identity.
  Legacy migration constructs recovery metadata, then degrades every unbound
  attachment into a `legacy-unbound-data` issue before source validation, URL
  classification, or byte decoding; unbound rows store empty `attachments`.
  Single binding accepts one attachment-free unbound source row whose three IDs
  match the request. Bulk binding accepts the complete ordered source scope.
  Each binding persists one snapshot and prepends moved rows to the target scope.
  Unbound rows own no transport-scoped blob references, so binding performs zero
  blob retain or release operations.
  Runtime generation captures the active transport lifetime; delayed work validates
  that generation before committing to a child store or queue scope.
- Child-store async work captures its owning store and directory. Shared HTTP
  responses may serve concurrent requests, while each live child store commits
  only through its own current capture.
- Queue failures classify as pre-dispatch retry, ambiguous dispatched
  reconciliation, or definitive rejection. Reconciliation confirms through the
  response or HTTP records before a queued item is removed.
- Reconciliation keeps persistent `reconciliationChecks`, `reconciliationDeadlineAt`,
  and `reconciliationNextCheckAt`. In-flight checks own no timer; each miss writes
  the next persistent check time, which drives the single global scheduler wake.
Exhausted checks or a reached deadline resolve to editable `unresolved` items.
Auto-send never re-POSTs unresolved rows (ambiguous delivery), but terminal
`failed` and `unresolved` rows no longer block later dispatchable FIFO work. Explicit manual
Send may select any recoverable row, atomically promote it to the scoped head, and POST once; automatic dispatch retains FIFO order among dispatchable rows. Edit and Remove still
release the terminal state without another POST. `running` auto-review runs
block queue drain only when their stable `runtimeKey` matches the active runtime;
legacy records without a runtime key allow drain. Completed, stopped, and error
records allow drain.

- Definitive `failed` heads share the terminal manual-recovery contract with
`unresolved` heads. The v3 production scheduler auto-dispatches only `queued`
heads and due `retrying` heads with an authoritative scoped `idle` status;
`unknown`, `busy`, and `retry` statuses keep dispatch paused. Message completion
revisions wake the scheduler and never override live session status. A trailing
user or unknown-role message keeps an idle scope paused; a trailing assistant
trusts authoritative idle and does not wait for `time.completed`. Missing
message materialization preserves the idle path.
- Aborting a turn creates a transient queue-dispatch block keyed by the exact
  `(transportIdentity, directory, sessionID)` queue scope before the SDK abort
  request. The block preserves queued rows, releases early on authoritative
  server idle events (`session.idle` / `session.error` / `session.status` idle),
  falls back to a six-second timeout when idle is delayed or missing, rolls back
  only its matching token when abort fails, clears on runtime restore, and wakes
  the scheduler at expiry or early release. Manual dispatch remains available
  during this window.
- Status snapshots apply per session only when their request-start timestamp is
  newer than that session's observed status timestamp. Optimistic busy and
  rollback idle writes advance the observed timestamp, so an in-flight HTTP
  snapshot cannot overwrite either transition. Successful authoritative polls
  retain their directory snapshot timestamp.
- Message-sent confirmation precedes dependent queue side effects. A composer
  queue admission completes before it consumes inline drafts, body text, or
  attachments. New queue rows require a complete captured `sendConfig`
  (providerID+modelID); incomplete capture aborts admission and keeps composer
  resources. Local chat commands retain these composer resources across both
  successful actions and action failures. Immediate local commands (`/compact`,
  `/fork`, `/undo`, and `/redo`) consume only their command text before awaiting
  their action, clear the source session's legacy text draft synchronously, and
  preserve attachments, inline drafts, synthetic parts, linked context, and
  queue state. Legacy queue rows remain visible in their legacy scope until a
  manual dispatch path performs a safe bulk bind into the active bound scope.

Receipt-backed queue mutations replay the exact request once after an unavailable transport response. A failed post-commit scope read preserves the committed result (including `committedRevision` from the action receipt) and retained authoritative snapshot while the observer converges a later revision. Queue mutation errors use queue-specific copy; an exhausted unavailable replay reports unknown status.

## Session action rules

Session actions live in `session-actions.ts` and are the canonical place for SDK-calling session mutations that affect global session lists.

### Session history mutation serialization (revert / unrevert)

Revert visibility, the revert dock, user-message history, and slash undo/redo use transcript `messageOrder` (conversation position), not id lexicographic comparison. A missing revert target fails visible (show the loaded conversation) rather than hiding by id. `revertToMessage` / slash redo do not materialize a refetch into the live timeline. Editing a sent message may await per-message `materializeTranscriptMessage` only when an authored file part is slim or missing `url`, then restore from the re-read parts. `revertToMessage` and `unrevertSession` share a serial flight owned by `session-history-mutation-coordinator.ts`, keyed by `[transportIdentity, generation, directory, sessionId]`. Same-session revert and unrevert run in call order so concurrent HTTP cannot invert the server’s final marker; different sessions stay parallel. Each queued operation re-reads store state after the queue wait, re-validates runtime capture after every await, and must not publish marker/session/draft when the runtime is stale. A failed operation never blocks the next queued operation (tail releases in `finally`). Draft revision CAS rollback on remote failure is unchanged. `session-actions.ts` keeps domain operations only. `stageMessageEdit` accepts optional `{ directory, draftKey }` (defaults to primary `sessionDraftKey`) and returns an opaque `StageMessageEditHandle` whose `rollback()` CAS-restores the pre-stage draft or true absence (conflict keeps newer user edits); primary callers may ignore the handle. Primary composer edit commits keep `messageEditCommitting` painted while they abort any still-busy turn, wait for the session to report idle (OpenCode rejects `deleteMessage` with HTTP 409 while busy), call `commitMessageEdit` to delete the edited target and its old forward tail, then dispatch the replacement. Waiting during abort→idle is expected. A failed abort/wait/delete keeps the staged edit and old tail for retry; a failed replacement send after a successful delete leaves the draft text for an ordinary resend. `commitMessageEdit` accepts an optional directory override so Assistant continuous edit deletes against the correct child store, and an optional `preserveMessageId` so an already-echoed in-flight replacement (and anything after it in conversation order) is never a delete candidate. Its delete range is the live transcript `messageOrder` tail from the target — conversation position, not id lexicographic order — intersected with server-known ids from a membership-only snapshot. That snapshot is not materialized into the live timeline. Nothing is hidden up front: a row leaves the local store only after its own remote delete succeeds, so a failed abort / refetch / delete cannot leave the transcript out of sync with the server. Those local deletes now sweep every current-runtime canonical scope of the session (same broadcast contract as transcript SSE), so a dual-directory copy cannot keep a stale tail or durable ghost.

Rules:

1. If an action mutates session list membership or visible session metadata, update `useGlobalSessionsStore` there.
2. If an action targets a session by ID, resolve the **session's own directory**. Do not assume the current directory is correct.
3. Scope-sensitive session actions use `getAuthoritativeDirectoryForSession()`, which resolves worktree metadata, session attachments, sync metadata, and global session metadata.
4. `session-ui-store.ts` should delegate to `session-actions.ts` for these mutations instead of duplicating SDK calls.
5. `setCurrentSession()` announces a monotonic session-switch intent before directory resolution or store publication. Delayed visual/transition callbacks must validate that intent and silently discard stale work. Optional `skipMessageFetch` skips the same-tick transcript fetch for callers that own the subsequent load (fork).
6. On a real session id change, `setCurrentSession()` also calls `useUIStore.syncWorkspacePanelsForSessionSwitch()` so right-side workspace panels (context/subagent chat, file preview, git changes sidebar) hide when leaving a session and restore when returning. `openNewSessionDraft()` must call the same helper when clearing a real session for Welcome/draft, because it does not go through `setCurrentSession()`. Tab content remains directory-cached; only open/active visibility is session-scoped.
7. Edit staging restores the composer from the visible user-message snapshot captured at click time. Primary send keeps `messageEditCommitting` painted, aborts any still-busy turn, waits for idle, deletes the edited target and its old forward tail, then dispatches the replacement. OpenCode rejects `deleteMessage` while the session is busy, so the wait is required. Each local row drops only as its remote delete lands. Submit paints the target as "editing" instead of hiding it. A failed abort/wait/delete leaves the old tail and staged edit intact; a failed send after a successful delete keeps the composer draft for retry. Leaving the session disarms `stagedMessageEdit`.
8. Sidebar previous/next navigation follows the rendered sidebar order. `SessionSidebar` publishes pinned rows plus logically visible project rows to `session-navigation.ts`; keyboard and native-menu actions share that registry and update the explicit session Focus before committing current-session authority. Adjacent navigation concatenates those rings (pinned first) and wraps across both sections, never falling through to hidden project rows.
9. Global Mod+1…9 navigation is session-row based, not project based. `SessionSidebar` combines the currently revealed pinned rows with logically visible project rows, caps the visual order at nine, and publishes it through `sidebar-numbered-navigation.ts`. The numbered activation preserves the selected row's exact Pinned/Project Focus identity.
10. `optimisticSend()` inserts the optimistic user message and local `busy` status **before** the connection grace wait (`waitForConnectionOrThrow`). Long-idle reconnect must not leave the composer cleared / status busy while the chat list still shows the pre-send snapshot. Connection failure remains a pre-dispatch rollback of that optimistic row.
  11. `fetchMessagesForSession()` may early-return on a renderable repository transcript only when pagination boundary is known (`has-more`/`exhausted`) **and** repository request state allows reuse (clean ready, not error/dirty) **and** the enter-and-sync authority window is still fresh (last successful pull < 30s). An `unknown` boundary always performs one authoritative tail ensure even when user messages are already cached. A known hot cache outside the window goes through repository `ensureInitial` (reconcile-page, not reset). It always bypasses that cache for a live `busy`/`retry` session whose local tail is **not** already a user message (pre-send snapshot while status is busy). Ordinary busy sessions with an optimistic/confirmed trailing user row keep the early-return when request state is clean **and** the window is fresh, so rapid remounts do not force a refetch or loading flash. The cold pull itself goes through production transport → `http-page`; the hot revalidate shares Query single-flight / `authorityTailInflight`, assistant-tail parent recovery, and one atomic reconcile-page commit. A switched-away stale generation completion never commits (next visit reads unknown → ensure). Concurrent callers share the in-flight Query / coordinator / inflight promise.

Examples of global-store updates performed in `session-actions.ts`:

- `createSession()` -> `upsertSession(session)`
- `updateSessionTitle()` -> `upsertSession(result.data)`
- `requestSessionSmartTitle()` -> writes `titleRefresh.requestedAt`, then `upsertSession(result.data)` (server session-title runtime regenerates the title)
- `shareSession()` / `unshareSession()` -> `upsertSession(result.data)`
- `archiveSession()` -> `archiveSessions([id], archivedAt)`
- `unarchiveSession()` -> `updateSession({ time: { archived: 0 } })` then `upsertSession` into the active list
- `deleteSession()` -> optimistic `removeSessions([id])` then immediate server delete
- UI hard-deletes use `scheduleSessionDeletes()` so the server delete waits for a 10s undo window; `cancelScheduledSessionDeletes()` restores local state without calling the server. Pending deletion IDs keep global refreshes and aggregated live child-store sessions hidden until cancellation restores the snapshot or delete settlement clears the pending state.
- Archive success toasts use `showArchivedSessionsUndoToast()` (undo + open `ArchivedSessionsDialog` via `setArchivedSessionsDialogOpen`); delete success toasts use `deleteSessionsWithUndo()`. Neither expands the sidebar archived bucket by default.

### Fork transition and event isolation

OpenCode publishes one `message.updated` event per cloned message and one
`message.part.updated` event per cloned part while `session.fork` runs. The UI
must not materialize that complete copied history into the production Query
transcript (or any residual pure draft surface) as an unscoped full dump.

- Enter the shared fork transition view before dispatching the SDK request.
- Do not require the source session to already exist in a directory child
  store. Cold start may only have the session in the global index (or messages
  already loaded without a `state.session` row). Resolve the directory from
  current selection / worktree / global index, then hydrate the source session
  into the target directory store from the global snapshot or `session.get`
  before forking. Missing directory is a hard failure with user-visible toast.
- Suppress copied message/part events for the target session while the request
  is active.
- When the real session ID arrives, bind the loading shell to that session and
  select it immediately (`setCurrentSession` with `skipMessageFetch`, which
  writes the path route). Do not wait for `markForkSessionAsLatest`, transcript
  reset, or the bounded tail load. After the target is bound, navigating back
  to the source session stays fully interactive; the overlay follows the target
  only. The caller then owns `destructiveReset` + `fetchMessagesForSession()`.
- Restore composer text/attachments only while the user is still viewing the
  forked session. Leaving the fork path must not dump pending input onto the
  source conversation.
- Keep a short message-ID cutoff after the response so transport-buffered copy
  events cannot refill the complete history. Newer user/assistant events pass
  through normally.
- OpenCode `session.fork(messageID)` copies strictly before that message.
  Current-session `/fork` while idle — including a missing status entry, because
  `/session/status` omits idle sessions — passes `undefined` and keeps the full
  source history through the latest completed turn.
- A current-session fork during `busy` or `retry` (or a missing status whose
  transcript tail is still an open assistant) passes the first message after the
  latest user message. That user turn is included; in-progress assistant work is
  not. A live session with no user message after refresh is a hard failure.
- An explicit user-message fork passes that user message ID and restores its text and file parts.
- An explicit assistant-message fork passes the following source message ID; an assistant at the source tail passes `undefined` and retains the full history through that reply.
- A current-session fork preserves the composer's existing resources.

### New conversation orchestration

Direct and combined first-prompt file parts go through
`opencodeClient.buildMessageParts`. Local `data:` / `blob:` attachments upload
bytes first (`PUT /api/fs/prompt-attachments/:id`) and the prompt JSON keeps
only a host `file://` path. Upload failure is explicit and never silently
re-embeds the data URL. Queue admission already uploads local blobs through
`/api/openchamber/message-queue/attachments/uploads` and delivers
`attachmentID` / `server-path` locators.

Normal first prompts from an open draft use the optional runtime
`conversations.createWithPrompt` capability. Web and mobile send one
OpenChamber-owned request; the server creates the OpenCode session and admits
the first prompt. VS Code provides the same contract through its extension-host
bridge. Existing sessions, shell input, slash commands, explicit delivery
modes, and older runtimes keep the regular SDK sequence.

The client generates the message ID before the request. The server/runtime host
uses it as the bounded operation key, so reconnect retries reuse the in-flight
or completed operation instead of creating another session. ChatInput publishes
the stable-ID pending user-message presentation while it sets `draftEstablishing`,
before response-style and snippet preprocessing. The row contains the captured
visible text, primary and per-part attachments, synthetic parts, and agent mention.
`claimDraftSubmission` reuses that message identity and promotes the draft to
`draftSubmitting`. The shared MessageList renders the pending presentation while
create+prompt remains in flight, with the establishing status below it. On
success that same presentation is retained against the new session id until its
authoritative record lands, so the row never blinks out during the handover.
Definitive failure clears the pending row and restores the claimed draft input.

Send-path prep must not compete for Chromium's per-origin HTTP/1.1 sockets:
`fetchResponseStyleInstruction` reads an in-memory cache warmed by settings
bootstrap / Behavior saves; `expandText` expands from the loaded snippet
catalog locally when every `#token` resolves. Git discovery
(`primary-root` / `worktrees`) is capped at 2 concurrent network calls with a
short TTL + in-flight dedupe so sidebar fan-out cannot starve create/prompt.
Cold-start project lists use `GET /api/git/discover` (via
`discoverGitRepositories`) once from `SessionStartupCoordinator` to seed the
check/primary-root caches; on 501/network failure the client falls back to
the existing single-request path.

Before `createWithPrompt`, the client synchronously ensures the resolved
directory child store exists via `dirStoreForDirectory(dir, { bootstrap: false })`
so any message SSE that races the HTTP response can route into a live store
without bypassing the new-draft bootstrap gate (no full directory bootstrap).
After a successful response, commit session-directory routing
(`recordCreatedSession`), retain the sent row as presentation for the real
session id, then finalize / select (which starts the ordinary selection page
fetch) / fill-void busy / consume / notify. Combined success never fabricates
client user/assistant domain rows, never stamps `__openchamberOptimistic`, and
— this is the load-bearing part — **issues no confirmation request of its own**.
The send path costs exactly what it cost before this remediation existed.

Busy is a fill-void write on the captured directory store **after** finalize /
select: if `session_status` still has no key for the new session, write
`busy` + `observed_at`. The retained presentation is chat-view only, while
sidebar activity, queue gating and abort all read `session_status`, so without
this write the new session would read idle until its first status event. Any
status already observed came from the server after creation and outranks the
inference. `fetchMessagesForSession` judges an in-flight send only from the
last user row in the store (not UI retained state); the presence watch covers
the combined miss path.

Remediation is reactive, never speculative. `ensureSentUserMessagePresence`
waits locally (a child-store subscription, no network) for `messageID` to
appear with parts; SSE or the ordinary selection
page fetch normally delivers it well inside
`COMBINED_SEND_PRESENCE_GRACE_MS` (2s), and that path issues zero requests.
Only a real presence miss enters one bounded recovery pull
(`fetchRecentSendConfirmationRecords` + gap-fill materialize, about 12 attempts
at 500ms, inlined in `ensureSentUserMessagePresence`). Presence requires parts,
not just the row: a part-less record paints an empty bubble, which is the same
defect as an absent row.

The recovery pull is gap-fill only
(`SEND_GAP_FILL_SESSION_MERGE_STRATEGY`: insert-only messages, `skip-existing`
parts). By the time it runs, live SSE may own the tail, and an
upsert/replace page would replay an older snapshot over it — silently dropping
already-finished tool and reasoning parts and reverting `finish` / `time.completed`
on a streaming assistant row. Presence waiting and the pull are both
runtime-scoped to the draft claim (`isCurrent` / `claim.runtime`): a runtime
switch stops further network attempts and never materializes into the captured
old store (currentness is rechecked after fetch and before materialize). A
bounded miss or a single exception logs one structured warning
(sessionId / messageID / directory only; no user body); the retained row stays
visible. Fetch failure never clears existing store messages; reconnect recovery
remains the last-resort gap filler.

The retained presentation is what actually closes the original gap: the draft's
`pendingUserMessage` used to vanish with the draft at `setCurrentSession` while
the store could still be empty. `retainedPendingUserMessages` (session-keyed,
presentation only, never written into the sync store) keeps that row on screen
across the handover, and the transcript drops it through
`clearRetainedPendingUserMessages` once the same ID exists **with parts**. A row
that never materializes stays visible on purpose — a sent message is never
silently lost from the body. Non-empty pending/retained rows keep the composer
in working only until session status has clearly finished that send; a fresh
authoritative idle (`sessionStatusObservedAt` at/after newest pending
`time.created`) clears working while the retained presentation may still paint
until the same ID materializes with parts. Runtime switch clears the map; the
new runtime reads its own transcript from the store.

Prompt-phase ambiguous confirmed materialize keeps its existing
confirmation-record path (also gap-fill only). Create-phase failures restore the
draft and input. Prompt-phase failures keep the created session; ambiguous
delivery is confirmed by message ID and is never automatically re-submitted.
Direct-send and the durable queue remain on `promptAsync` until OpenCode exposes
a matching immutable admission contract (see P2 promptAsync admission gate
above).

While that first create+prompt flight is held, later composer submits for the
same draft do not open another session. `composer-send-manager.ts` records the
establishing draft identity **synchronously when the first create flight is
claimed** (before selection.flush / paint awaits), stages follow-ups as
client-only pending-admission chips (same "Queuing…" continuum as legacy/server
stageAdmission), and blocks `openNewSessionDraft()` so Mod+N cannot rotate the
draft mid-create. During establishing the composer stays editable and Send stays
enabled so Enter/button can stage chips despite the primary flight. Flight is
keyed by ChatInput surface ID so primary and secondary composers never block each
other. After the first prompt selects a real session, `composer-send-drain.ts`
takes those follow-ups and admits them into that session's server or legacy queue
with stable request/queue/message identities. Removing a client pending chip
restores its text/attachments into the composer; failed create clears establishing
state without starting another create.

Composer surfaces read one derived `ComposerSendPhase` (`flightKind`, `inFlight`,
`establishing`) instead of recombining flight booleans per call site, and every
submit entry point (button, Enter, form, preset, dictation) checks the same
manager claim before the flight gate. Event handlers read flight state from the
store at call time rather than from a render snapshot. Draft-open blocking is
owned solely by the manager; `openNewSessionDraft()` does not rotate identity
while `draftSubmitting` / `draftEstablishing` (or manager establishing) is active.


### New-session draft ownership (Phase 1 Lane 3b)

An open new-session draft carries a stable `draftID` derived by
`deriveNewSessionDraftID` after project/directory resolution: project id first,
then normalized directory, else a default bucket (`new-session:project:…` /
`new-session:directory:…` / `new-session:default`). Same project close + reopen
reuses that id so the durable input-store body and attachments survive; different
projects get different ids. Runtime isolation remains on
`DraftKey.transportIdentity`. Opening while `draftSubmitting` or
`draftEstablishing` is a no-op that keeps the in-flight identity. Close may clear
the UI `draftID` because reopen re-derives the same ownerID. When setting the
active draft key, if input-store already has that durable record, body and
attachments are preserved (no `clearAttachedFiles`); a fresh key still clears
attachments. That restored record includes the full Composer document sidecars
(`composerReferences` for session/paste/skill/command), file/directory/agent
mentions, synthetic parts, and durable attachment metadata (server file, image
URL, VS Code selection, etc.). Agent chip selection in ChatInput commits a
`kind: 'agent'` mention with a range that matches only `@agentName` (boundary
spaces excluded). Runtime session memory preserves the complete draft state,
including its identity, per runtime.

Submission claims capture the draft ID, token, UI draft snapshot, input runtime
capture, runtime-memory key, and the existing source record key/revision. The
claim CAS gates UI restoration with draft ID, token, and runtime capture; its
runtime memory uses the same claim identity so a switched-away runtime cannot
retain a submitting draft forever. A stale completion records its created remote
session while leaving the current runtime UI and any reopened draft intact.

Ownership finalization calls `input.finalizeDraftOwnership` only when the
claimed source exists. `consume` applies after a confirmed combined prompt or a
successful fallback route; `preserve` applies after standalone materialization,
permanent prompt failure, ambiguous unresolved delivery, and fallback route
failure. Pre-create failures retain the source record. Finalization reports
non-committed outcomes through diagnostics and does not reopen drafts or retry.

Lane 3b owns client-side draft identity and ownership finalization. Lane 4 owns
production queue admission and atomic queue cutover.

### Queue dispatcher execution invariants

`useQueuedMessageAutoSend.ts` owns the v3 dispatch flight registry keyed by the
exact scope, queue item, and operation identity plus one scope-level flight that lasts through POST promise settlement. Admission message IDs are
candidates. Before every real POST, v3 reads the current largest scoped `msg_`
message ID, rotates to a fresh ID above that floor, and durably enters `sending`
as one barrier. Ambiguous delivery retains that fresh ID for reconciliation;
pre-dispatch retry and manual terminal send rotate again. The v4 cutover requires
the same fresh-ID barrier before it becomes authoritative. Direct manual and
automatic dispatches share one POST flight; reconciliation queries retain their
separate scheduler flight. Payload acquisition returns a monotonic token; each non-confirmed path
releases its own token. Durable confirmation removes queue and send references
before one best-effort notification. The planner exposes one head and one
nearest wake per scope; it observes scope flights so confirmation before POST settlement never starts a following row. Lane 4 must preserve manual arbitrary-row promotion, scope single-flight, and automatic FIFO eligibility at cutover.
Each queued dispatch passes its verified bound-scope directory through the
session send target, optimistic route, and OpenCode request. Duplicate session
IDs retain their exact queue-owner directory across manual and automatic
dispatches.

Reconciliation persists `pending` next checks and durable `unresolved` terminal
states. Authoritative misses increment a safe-integer count; unavailable queries
preserve it while scheduling a bounded wake. Hydrated `sending` rows recover by
persisting `sending → reconciling` without a POST.

### Queue edit bridge (Phase 1 Lane 3c)

`message-queue-edit-bridge.ts` materializes one locked queue identity into a
target draft through injected queue and draft commit dependencies. It captures
matching queue/input transport generations before any owner call, validates a
complete root-occurrence attachment payload, then commits the draft before
removing the queue row. A durable draft always attempts removal, including a
runtime-stale draft completion. Queue removal reports `durableRemoval` from the
coordinator metadata commit: post-commit stale results remain durable, while
pre-commit outcomes retain the queue for retry. The default convenience entry
captures both runtimes at invocation and keeps module import lazy. One queue
identity shares one edit flight; distinct identities run independently. Every
bridge failure returns a stable diagnostic result without exposing draft text or
attachment values. Materialization holds an owner-level send reservation through
draft commit and queue removal. Dispatch acquisition, transition, and confirmation
honor that reservation; every bridge completion path releases it, while durable
removal releases its coordinator send ownership. Ordinary remove, reorder, bind,
and bind-many return `reserved` for a reserved identity. `removeEditReservation`
accepts the matching reservation token and runtime capture as the sole durable
remove capability. A matching coordinator release clears reservation ownership
for both committed and cleanup-failed outcomes because its send acquisition has
ended; stale keeps the reservation for its matching token. Owner throw handling
clears the local fence and reports cleanup diagnostics. Hydrate and disable
attempt old reservation release before rebuilding or fencing runtime state.

`message-queue-server-edit-bridge.ts` owns the server-authority edit path. It captures matching server and input runtime generations, reserves the exact queue row by revision and row version, downloads every canonical attachment through the authenticated queue content route, validates its occurrence tuple, MIME type, and byte size, then durably commits the draft. Edit-flight deduplication keys include server transport identity, runtime generation, scope ID, and queue item ID. One awaitable renewal flight serves heartbeat and pre-commit freshness; each acknowledgement must match the item, token, generation, and a strictly future expiry before draft commit. Attachment metadata above 50 MiB fails before download, and downloads preserve canonical order with four concurrent requests. Reserved removal uses the reservation generation and CAS values; a durable draft with a retained queue reports `queue-retained`. Runtime-stale work releases its reservation and never commits or removes. Server attachment paths remain server-owned and reach the UI only as downloaded `Blob` values.

### Shared worktree ordering

`worktree-order-sync.ts` reconciles the worktree display order with the
message-queue server. Local order and pending write intent persist by runtime for
startup continuity and unsupported-runtime fallback; server revisions remain
runtime memory. Server records are mapped by normalized project directory and
advance settled local order only with a greater project revision. Equal and older
records preserve the current paths. Pending local edits retain their optimistic
order while receiving a greater server revision, then write through per-project
latest-wins CAS flights. A pending project holds the greatest remote order in
runtime memory; an acknowledgement behind that revision resolves to the deferred
remote order, while a newer acknowledgement retains the local order. Observer recovery replays every persisted pending project,
including an empty order, and seeds non-empty local-only orders. Retry-classified
transport failures back off; unsupported and permanent failures stop the observer.
Transport retries reuse one request ID, revision-conflict retries use a new request
ID, and runtime changes abort both observers and writes.
Shared ordering covers worktree row order; expanded groups, selected sessions,
and other local navigation state retain their existing local ownership.

## The golden rule

When creating a draft in `handleDirectoryEvent`, **only clone the state fields the event will mutate**. Never spread all fields eagerly.

```typescript
// WRONG — clones everything, breaks referential equality for all subscribers
const draft = {
  ...current,
  session: [...current.session],
  message: { ...current.message },
  part: { ...current.part },
  permission: { ...current.permission },
  // ...
}

// RIGHT — only clone what this event type touches
const draft = { ...current }
switch (event.type) {
  case "message.part.delta":
    draft.part = { ...current.part }
    break
}
```

## Why this matters

Zustand skips re-renders when a selector returns the same reference (`Object.is`). If you spread `session: [...current.session]` but the event only modifies `part`, the `session` array gets a new reference. Every component using `useSessions()` re-renders for nothing.

During streaming, `message.part.delta` fires ~60 times/sec. Eagerly cloning all fields caused every subscriber in the entire app to re-render 60/sec — a 10x overhead. Targeted cloning reduced MessageList renders from ~1972 to ~296 per session.

## Event → field mapping

Keep this in sync with `handleDirectoryEvent` in `sync-context.tsx`:

| Event type | Fields to clone |
|---|---|
| `session.created/updated/deleted` | `session`, `permission`, `todo`, `part` |
| `session.diff` | `session_diff` (preview summary only: file/status/additions/deletions; no patch bodies — full patches load on demand via `GET /session/{id}/diff`) |
| `session.status/session.idle/session.error` | `session_status`, `session_status_observed_at`; `session.error` also writes `session_error_at`; `session.status` busy/retry may clear `session_error_at` |
| `todo.updated` | `todo` |
| `message.updated` | `message`, `part` when a loaded session observes a new assistant before its first part |
| `message.removed` | `message`, `part` |
| `message.part.updated/removed/delta` | `part` |
| `vcs.branch.updated` | (none — mutates `draft.vcs` directly) |
| `permission.asked/replied` | `permission` |
| `question.asked/replied/rejected` | `question` |
| `lsp.updated` | `lsp` |

## Adding a new event type

1. Add the case to the event reducer (`event-reducer.ts`)
2. Add a corresponding case to the switch in `handleDirectoryEvent` (`sync-context.tsx`) that clones **only** the fields your reducer writes to
3. If your event fires frequently (more than a few times per second), verify that unrelated components don't re-render — check with the stream perf counters

## Selector hygiene

Select leaf values, not containers:

```typescript
// WRONG — returns entire Map/object, new reference on any mutation
useDirectorySync((s) => s.permission)

// RIGHT — returns the value for one key, stable unless that key changes
useDirectorySync((s) => s.permission[sessionID] ?? EMPTY)
```

Same applies to `useStreamingStore` — select `.get(key)` not the Map itself.

## Store splitting pattern

### Why split

A single Zustand store with N properties means every subscriber's selector re-evaluates on every state change — even if the change is unrelated to what that subscriber reads. During streaming, `sessionMemoryState` updates ~60/sec. Before the split, all 68+ `useSessionUIStore` subscribers re-evaluated on each update. After splitting into focused stores, only `useViewportStore` subscribers (2-3 components) re-evaluate.

The optimization multiplies with targeted event cloning: fewer new references per event × fewer subscribers per store = dramatically less work per SSE frame.

### The stores

| Store | Owns | When it changes |
|-------|------|-----------------|
| `session-ui-store.ts` | Session selection, draft lifecycle, abort, worktree, SDK actions | Session switch, draft open/close |
| `voice-store.ts` | Voice connection/activity state | Voice toggle |
| `input-store.ts` | Pending input text, synthetic parts, attached files | User typing, file attach, revert/edit/fork |
| `selection-store.ts` | Per-session model/agent/variant memory (localStorage, last 150 sessions). History (latest user message) is the cross-client baseline; this store is same-client fallback when messages are not ready. Variant is persisted in Zustand state (`undefined` deletes the entry). Project-level agent/model defaults live in config-store (`lastSelectedAgentName`, `agentModelSelections`), not here. | Session switch restore, primary composer flush |
| `viewport-store.ts` | Scroll anchors, session memory state, sync status | Streaming, scroll, session switch |

### Rules for new UI state

1. **Never add to `session-ui-store`** unless it's session selection, draft lifecycle, or abort state
2. **Group by change frequency** — state that changes during streaming (viewport, memory) must not live with state that changes on user action (selections, input)
3. **Group by subscriber set** — if only 2 components read a value, it should be in a store that only those 2 components subscribe to
4. **Prefer a new store over growing an existing one** if the new state has different subscribers or change frequency
5. **Cross-store reads use `.getState()`** — actions in one store that need to read another store call `useOtherStore.getState()` (imperative, no subscription)

### Anti-patterns

```typescript
// WRONG — stuffing unrelated state into one store
const useEverythingStore = create(() => ({
  voiceMode: "idle",
  scrollAnchor: 0,
  selectedModel: null,
  pendingInput: "",
  // 20 more fields...
}))

// RIGHT — separate stores by concern + change frequency
const useVoiceStore = create(() => ({ voiceMode: "idle" }))
const useViewportStore = create(() => ({ scrollAnchor: 0 }))
const useSelectionStore = create(() => ({ selectedModel: null }))
const useInputStore = create(() => ({ pendingInput: "" }))
```
