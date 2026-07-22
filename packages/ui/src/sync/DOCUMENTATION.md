# Sync architecture, event handling & store update rules

## Scope

This document covers the current client-side session/data architecture in `packages/ui/src/sync` and the rules for updating stores safely.

There are **two distinct session data scopes** in the UI:

1. **Directory-scoped sync stores**
   - Owned by the sync layer child stores created in `sync-context.tsx`
   - Source for per-directory live session/message/part/permission/question state
   - Backed by SSE / directory-scoped polling
   - Read via hooks like `useSessions()`, `useDirectorySync()`, `getSyncSessions()`, `getDirectoryState()`

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

- Use the **directory sync stores** for per-directory live session/message state
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

`worktreeTopologySync.ts` owns renderer-level worktree catalog reconciliation. It starts from `AppEffects`, remains shared through a realm ref-count, and skips VS Code. Event-stream ready envelopes, topology changes, registry topology changes, and deduplicated unknown session directories force per-project catalog enumeration. Successful empty results authoritatively clear that project, failed reads preserve its prior catalog, and only added worktree directories start global session synchronization. Unknown-directory suppression begins only after every registered project completes successfully for its recovery epoch; failures retain bounded retry and lifecycle/runtime changes discard stale work.

| Layer / Store | Owns | Scope |
|---|---|---|
| child directory stores in `sync-context.tsx` | `session`, `message`, `part`, `permission`, `question`, etc. | One directory |
| `session-ui-store.ts` | Session selection, draft lifecycle, abort prompts, worktree metadata, SDK-facing action entrypoints | App UI state |
| `useGlobalSessionsStore.ts` | Global active sessions, global archived sessions, `sessionsByDirectory` | All opened project/worktree session lists |
| `viewport-store.ts` | Scroll anchors, session memory, loading indicators | App UI state |
| `input-store.ts` | Legacy pending input state plus keyed draft metadata, hydration, persistence state, and DraftKey-scoped legacy attachment views | App UI state |
| `input-draft-metadata-store.ts` | Validated durable draft metadata, legacy staging, migration markers | Browser storage |
| `selection-store.ts` | Model/agent/variant selections | App UI state |
| `voice-store.ts` | Voice state | App UI state |

### Keyed draft metadata

`input-store.ts` owns memory-first validated `DraftRecord` state keyed by transport identity and draft owner. `DraftRecord` stores textarea-visible text, Composer Session/Paste sidecars, and attachment metadata; per-occurrence `AttachedFile` views, missing blob occurrence IDs, and attachment hydration/persistence state remain runtime memory. `packages/ui/src/composer/use-composer-controller.ts` projects the active `DraftKey` record into ChatInput and commits document plus file/agent mentions through `setDraftComposerState` as one revision. Primary session and new-draft keys retain their durable shape; an explicit `surface` owner isolates a secondary ChatInput surface. Persistence enablement controls the durability lane while memory editing remains available. Composer ranges use UTF-16 offsets, and durable sidecars validate sorted non-overlapping ranges, unique IDs, bounded per-reference and cumulative Paste payloads, and stable Session IDs. Blob put and draft-reference retain complete before a snapshot containing that metadata enters the durability lane; quota and storage failures preserve editable memory views for explicit retry. Removal and replacement persist metadata before releasing old blob references. `moveDraftWithAttachments()` retains destination references, moves metadata, persists, then releases source references; synchronous `moveDraft()` remains URL-only. Hydration isolates transport generation, key epoch, and record identity, so delayed blob reads cannot replace newer attachment views. Disabled persistence keeps drafts and attachment views in memory without IndexedDB work. Legacy session drafts import into the migration's claimed transport; legacy Composer envelopes become visible text plus validated sidecars, and the legacy `new` record remains staged until `claimLegacyNewDraft()` receives its destination key. Queue admission and send ownership transfers remain outside this store.

The legacy composer attachment view uses in-memory buckets keyed by runtime `DraftKey`, with an independent unowned bucket. Session selection activates its bucket; every legacy attachment mutation and delayed FileReader completion remains scoped to its captured source key. A clear or replacement invalidates reads for that same bucket.

`input-draft-durability-coordinator.ts` owns serialized draft durability. `input-store.ts` keeps memory-first records and submits scoped candidates through the coordinator; blob materialization, references, metadata ordering, rollback, release cleanup, and move transfers stay behind that boundary. Hydration seeds the coordinator once after migration, persists every touched snapshot, flushes durability before completion, and replays locally dirty keys after the durable baseline is available. Disabled persistence keeps editable memory records and blocks durable admission until re-enabled.

Text and Composer-state bursts use one per-store 40ms latest-wins persistence window. Memory revisions publish synchronously and persistence reports `saving`; flush drains the window before coordinator flush. Attachment, ownership, move, delete, retry, and other durability barriers absorb a pending Composer request for their keys and persist the latest complete record immediately. Disable clears pending timers and preserves dirty memory for a later enabled persistence pass.

Committed draft snapshot and ownership actions use per-key CAS epochs plus a captured runtime generation. The durability lane validates candidate currentness before every blob, cleanup, or metadata operation and validates it again before metadata persistence. A metadata-committed action adopts its durable draft or tombstone keys independently after post-write epoch changes; runtime-stale completions clear attachment views, missing-ref IDs, hydration, and both persistence maps in one publication while preserving newer memory records. Ownership finalization evaluates source and destination epochs independently, so one durable source tombstone can coexist with a newer destination record. Revision increments require positive safe integers, including delete tombstones.

## Session list rules

### Directory-scoped session list

Use the directory-scoped sync store when the UI needs the live session list for the **current directory**.

Examples:

- current chat/session switching
- per-directory session/message bootstrap
- session/message/part SSE updates

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

`useCurrentSessionEntity(sessionID)` owns current-session entity resolution for the desktop Header and mobile Header. It prioritizes the matching cross-directory live session, then the matching global active session. A resolved entity remains available for two seconds during a brief source gap; clearing or changing the session ID immediately clears that fallback.

Renderable messages and session identity are independent completeness signals. Missing session identity keeps `session.get` eligible even when the message prefetch TTL is current, blocks prompt submission while preserving the mounted primary Composer and its editable draft, and receives a bounded current-view retry. The subagent read-only prompt banner requires the current directory's confirmed session entity to carry `parentID`; loading, missing, cached cross-directory, root, and generic read-only states never display it. Parent navigation derives its target identity from the authoritative child `parentID`; a cached parent entity enriches its title and directory.

`scoped-session-status.ts` owns exact `(directory, sessionID)` status reads and subscriptions. A missing child-store snapshot reads as `unknown`; a successful directory status snapshot with no matching entry reads as `idle`. Its registry subscription rebinds when a requested directory store appears, and status listeners ignore parts plus other session IDs.

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
session-index flow after registered settings hydration, restores the SQLite snapshot,
refreshes each known root/worktree directory through the bounded scheduler,
writes one transaction batch, then releases normal global and directory
bootstrap. A runtime that reports the capability as unsupported uses the
existing bounded SDK-backed path. A successful
empty root page replaces stale index rows; a failed page preserves its last
good cache.

Every global session-index asynchronous entry captures the runtime generation
and transport identity. Snapshot hydration, startup sync, persistence, and
tip-driven snapshot reloads commit only while that capture remains current.

Password-gated runtimes force a fresh settings hydration after authentication
and keep the app tree behind the auth gate until persisted project paths have
been applied. This prevents a pre-authenticated `401` settings request from
becoming the cached startup result consumed by the session coordinator.

## Session message loading

### Context panel session transcripts

- Web and Electron ContextPanel chat tabs render an in-realm strict-read-only transcript through the root `SyncProvider`. They read the same directory-scoped live stores as the primary chat and do not create an independent sync lifecycle.
- Browser and preview iframe surfaces retain their existing ownership and bridge behavior.
- The direct `?ocPanel=session-chat` embedded entry remains available for compatibility, while ContextPanel chat rendering always selects the in-realm transcript.
- A panel transcript's domain identity is the normalized `(directory, sessionId)` target. Its geometry/view identity is `JSON.stringify([runtimeKey, surfaceId, normalizedDirectory, sessionId])`; `surfaceId` is scoped to normalized `(directoryKey, tabId)`. Keep these identities separate when changing viewport restoration or retained-view behavior.
- Nested panel navigation is local to the `(directoryKey, tabId)` surface. It accepts same-directory targets, maintains anchor/current/stack metadata, and never writes the primary `setCurrentSession()` selection.
- ContextPanel retains a bounded panel-local `React.Activity` cache of three transcript views and 32 MiB. The active view is touched, hidden views pause effects, estimate callbacks update their matching view, and closing a tab removes every retained nested view for that tab.
- Context panel transcript capabilities are strict read-only: nested-session navigation is available within the panel directory; composer, session mutation, and primary-selection ownership remain outside the surface. Once a viewed session is authoritatively confirmed as a child session, its fixed read-only execution footer remains mounted through temporary session-identity gaps and resets with the panel view identity.
- Cover planner, navigation, geometry key, cache touch/estimate/close, render-mode, and viewed-session behavior in `components/layout/contextPanelSessionSurface.test.ts`.

- The imperative session-selection path and the reactive `useSync()` path share
  one app-wide single-flight request keyed by runtime, directory, session,
  requested limit, and pagination cursor. They must not issue duplicate tail
  requests during a React mount or provider remount, and a smaller concurrent
  request must not satisfy a larger request.
- Session materialization coalescing is scoped to the owning directory store.
  A remounted `SyncProvider` must start its own commit path even when the
  runtime, directory, and session ids match an old in-flight request; transport
  single-flight can still share the HTTP response, but the new store must not
  reuse a promise that only commits into a detached store.
- Initial history is a 16-message tail page on mobile surfaces and a 30-message
  tail page on Web, Electron, and VS Code. The imperative selection path and
  reactive sync path resolve the page size from one runtime-aware helper, so
  both share the same transport flight. A failed first load retains its requested
  page size; retries never degrade into an unbounded `limit=0` history read. An assistant-only
  partial tail fetches up to eight missing parent user messages by exact message
  ID, then commits the merged records; it never expands to a 100/150-message
  page while searching for a turn boundary. Loading failures are subscribable
  and preserve the prior ready records for retry.
- Message loading status is runtime-scoped. Reactive request de-duplication is
  local to the owning directory-store lifecycle, so a remounted provider still
  commits a shared transport response into its own store.
- Older history is user-driven pagination (`loadMore`) only. Each request loads
  a 30-message page across all surfaces.
- Composer session mention search filters every loaded global active-session
  summary across projects, while the empty menu keeps three recent suggestions.
  Opening the mention menu performs no referenced-session fetch. Selecting a
  session lazily materializes its bounded identity and message snapshot in its
  owning directory before inserting the durable reference. Sending reads that
  bounded owning-directory message/part snapshot and adds a size-limited hidden
  context part. The textarea stores visible Session labels plus DraftRecord
  sidecars containing stable Session IDs. Sending resolves each sidecar at the
  send boundary into stable Session identity and visible sent text
  `@<session title>`.
- A rejected shared request is removed from the coordinator so the next
  explicit/reactive attempt can retry; failure must never be cached as an empty
  authoritative history.
- Reconnect recovery may poll lightweight status for multiple active sessions,
  but it materializes `session.get + session.messages` only for the currently
  viewed session. Background busy/incomplete sessions wait until selection and
  continue receiving live events without fetching their bodies.
- A bounded bootstrap may omit a selected session. `ensureSessionRenderable()`
  accepts an explicit target directory for this exact materialization path. It
  creates that directory child store with `bootstrap: false`, uses that
  directory's scoped SDK client for `session.get` and message reads, and commits
  identity plus materialized messages only into that target store. Message TTL
  readiness and session identity remain independent: a ready message page with
  missing identity still performs the exact identity read.
- The client stall timer starts before SSE response headers arrive. Transport
  activity includes SSE comments and heartbeats, iterator events, and every
  WebSocket message frame. A transport stale watchdog reconnects after this
  activity expires; quiet heartbeat streams remain healthy.
- A viewed `busy` or `retry` session records message and part domain activity.
  Fresh transport with no such activity for 60 seconds triggers one directory
  recovery per minute. Recovery reuses reconnect materialization, so only the
  viewed session receives `session.get + session.messages(30)`.
- Domain activity and recovery revisions resolve only from an event's explicit
  session identity or an indexed message identity. Orphan materialization keeps
  its active-session fallback without affecting domain health or recovery
  freshness. Recovery captures a monotonic per-session live revision and skips
  its session/message commit when a newer live event arrives before HTTP settles.
- Recovery replaces fetched-tail message metadata with the authoritative server
  snapshot, including completion, finish, and token fields. Local messages
  outside the bounded tail remain intact, and part merging retains live streaming
  fields until an authoritative completed part arrives.
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

`messageQueueQueries.ts` owns server queue catalog, revision-pinned scope pages, and capability reads through TanStack Query. Queue query keys start with transport identity; scope pages contain at most eight items and fetch every `nextOffset` under the first-page revision. Failed page sequences retain the prior complete scope snapshot. `message-queue-server-runtime.ts` is a headless attachment surface with exact-scope reads only. Successful status, catalog, and scope reads write their transport-scoped Query keys. Descriptor state and stable scope snapshots bind their captured transport identity, and a direct identity read clears them before a delayed runtime-switch callback runs. `getScope()` reads a stable complete current-scope reference from Query data. A successful empty catalog clears queue scope cache, and removal of one catalog scope clears every revision key for that transport and scope; failed polls and failed later pages preserve prior complete data. Local attachments upload bytes, server attachments retain their canonical server path and authoritative byte size, and VS Code attachments close server admission. SSE revision tips (`openchamber:message-queue-changed`) arrive through the shared `runtimeFetch` streamed-response transport, including Relay tunnels, then trigger a snapshot GET; only scopes with a changed revision are page-loaded, with abortable exponential backoff on failures. Its lazy singleton performs no fetch or storage work at import; AppEffects starts it, installs one ref-counted runtime-switch observer, and releases both on cleanup. `useMessageQueueServerScope()` subscribes to its exact scope and returns capability, authority, import state, hydration, scope items, and actions. Available active authority selects server mode directly; `canActivate` remains the Phase 3 activation gate. Shadow and unsupported states expose legacy mode. Phase 2 keeps v3 production authority and auto-send active.

Server admission publishes an exact-scope, headless pending shadow synchronously before attachment upload. The shadow is outside TanStack Query and carries only display-safe admission fields plus an uploading, admitting, ambiguous, or acknowledged phase. `hasPendingAdmission` includes every shadow for visibility and diagnostics; `hasBlockingAdmission` includes uploading, admitting, and ambiguous phases. A durable POST acknowledgement ends interactive input blocking, while its acknowledged shadow remains visible through authoritative convergence. Targeted background scope paging reconciles the authoritative projection without status/catalog refreshes or global hydration/error updates. An acknowledgement reuses an already complete authoritative scope at its revision and skips a duplicate targeted GET. Authoritative rows win duplicate queue IDs, and a complete scope revision at or beyond the acknowledgement revision clears its acknowledged shadow, including worker-claimed or completed rows. Scope cache publication precedes pending cleanup, so exact-scope readers retain a readable authoritative scope through convergence. Runtime transport reset clears pending shadows, notifies every pending exact scope, and delayed work remains generation-scoped.

Full catalog reads page every changed scope before one monotonic commit. The commit compares the incoming catalog revision against the cached snapshot and every current scope revision, then preserves newer Query and descriptor references when an older result settles late. Targeted reconciliation commits only its captured scope and retains sibling descriptors and pages. Failed page sequences preserve the prior complete authoritative snapshot.

`queuedMessageChipsState.ts` owns the pure UI data contract for server queue chip state. It exports `ServerQueueOperationKind` (`edit | send | remove | reorder`), `ServerQueueOperationIdentity`, `selectPendingServerQueueOperation`, `applyPendingServerQueueOperation`, and `isServerQueueItemDispatchPending`. `selectPendingServerQueueOperation` matches an operation to an exact `(transportIdentity, directory, sessionID, scopeID)` scope; a runtime switch or different session never inherits another scope's pending operation. `applyPendingServerQueueOperation` is a pure reorder over authoritative item references: `send` moves the existing target reference to position 0, `reorder` reorders existing authoritative items to match `queueItemIDs` (preserving pending admission rows and any unlisted authoritative items after the reordered subset), and `edit`/`remove` return the original array reference unchanged. It never recreates items, reuses existing object references, and returns the original array reference when the target is missing or the order is already the requested order so React skips re-rendering. The TanStack Mutation Cache owns card async-operation pending state and shows the overlay; the overlay never writes the revision-pinned Query cache, and a failed/aborted operation removes its overlay so the authoritative scope is restored. `isServerQueueItemDispatchPending` returns true for an authoritative `MessageQueueItem` whose `manualDispatchRequested === true` (manual Send POST acknowledged but the worker has not yet started) or whose status is `sending`/`reconciling`; pending admission rows are handled separately by the component through `isMessageQueuePendingAdmissionItem`. `MessageQueueItem.manualDispatchRequested` is optional and parsed strictly: a missing field reads as absent, `true`/`false` are accepted, and any other type is rejected as a malformed authoritative response. `canSendServerQueuedMessage` returns false while `manualDispatchRequested` is true so a manual dispatch keeps its card loading across the POST acknowledgement until the worker begins the attempt.

The server observer leads with an authoritative snapshot GET, applies scope pages when the catalog diverges, then waits for the next SSE tip only after the cache already matches. Tips published while paging are recovered by the next leading GET rather than a missed wait. `remove` treats authoritative `not_found` as a committed delete after reloading the scope. Runtime changes abort its observer and isolate Query cache identity. The observer captures runtime generation for each snapshot, tip wait, upload, and mutation. Web, Electron, hosted mobile, and Capacitor use the server-capable route; `501` marks capability unsupported, and VS Code retains its legacy fallback. Active and paused server authority use the manual-send CAS endpoint; paused promotion moves the item to the queued head with a due time of now while the worker remains stopped, and resume dispatches that promoted head. A mutation conflict reloads only the mutated scope before one retry; sibling scope descriptors stay on their last loaded revision so unrelated queues do not render empty. After a committed mutation (including manual send), the client always reconciles that scope from the latest snapshot instead of pinning pages to the mutation revision, so a worker claim cannot regress descriptors into an empty chip list. A failed mutation still best-effort reloads the scope before surfacing the error. Scope advancement after a committed response preserves the original idempotent request as a single execution. Shadow and unsupported authority delegate to the explicit legacy callback. Server authority stays `shadow` and its worker stays paused throughout Phase 2. The v3 production queue remains authoritative until Phase 3 activation.

`message-queue-shadow-import.ts` hydrates the v4 runtime read-only and constructs stable scope/item ordinals, canonical payload hashes, snapshot hashes, and manifests without mutating the local ledger. It materializes or uploads canonical attachment payloads, creates a protocol-4 import, stages every payload, and seals the manifest. Payload tokens release through one `finally` path. `message-queue-cutover.ts` owns the headless external-store cutover lifecycle: probing, legacy-unsupported, server-active, server-paused, and blocked ownership; freezing, staging, activating, late-importing, complete, and error migration states. It freezes admission while shadow staging, calls injected quiesce/flush barriers, activates sealed shadow imports, and commits late imports after active or paused ownership. A lost commit response confirms through status epoch and manifest. Only HTTP 501 enables legacy ownership; transport and authorization failures remain blocked with backoff. Runtime switches abort the old flow and isolate the next transport. Phase 3 binds every cutover publication to the v3 ownership gate and mutation fence. The module starts quiescing; only HTTP 501 enables v3 dispatch and user mutations. Quiescing blocks new dispatch before begin and immediately before POST, waits for dispatch and reconciliation flights, resolves and atomically binds every unbound legacy scope, then flushes persistence and captures the final v3 ledger. A server-active or server-paused transport enters the retired transport set, so its bound scopes remain read-only while a newly selected HTTP 501 transport opens its own v3 queue. Existing sending rows retain internal confirmation and failure settlement before retirement.

Cutover refreshes are single-flight. A committed import response completes directly without staging or committing again. Importer pending, degraded, and transient failures preserve the current shadow or server-authoritative source and retry with exponential backoff. Activation conflicts re-read authority, retain server ownership, prepare the current local snapshot, and append it as a late import.

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
Auto-send never re-POSTs unresolved heads (ambiguous delivery). Explicit manual
Send may select any recoverable row, atomically promote it to the scoped head, and POST once; automatic dispatch retains FIFO head selection. Edit and Remove still
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
  request. The block preserves queued rows, lasts two seconds, rolls back only
  its matching token when abort fails, clears on runtime restore, and wakes the
  scheduler at expiry. Manual dispatch remains available during this window.
- Status snapshots apply per session only when their request-start timestamp is
  newer than that session's observed status timestamp. Optimistic busy and
  rollback idle writes advance the observed timestamp, so an in-flight HTTP
  snapshot cannot overwrite either transition. Successful authoritative polls
  retain their directory snapshot timestamp.
- Message-sent confirmation precedes dependent queue side effects. A composer
  queue admission completes before it consumes inline drafts, body text, or
  attachments. Local chat commands retain these composer resources across both
  successful actions and action failures. Immediate local commands (`/compact`,
  `/fork`, `/undo`, and `/redo`) consume only their command text before awaiting
  their action, clear the source session's legacy text draft synchronously, and
  preserve attachments, inline drafts, synthetic parts, linked context, and
  queue state. Legacy queue rows remain visible in their legacy scope until a
  manual dispatch path performs a safe bulk bind into the active bound scope.

## Session action rules

Session actions live in `session-actions.ts` and are the canonical place for SDK-calling session mutations that affect global session lists.

Rules:

1. If an action mutates session list membership or visible session metadata, update `useGlobalSessionsStore` there.
2. If an action targets a session by ID, resolve the **session's own directory**. Do not assume the current directory is correct.
3. Scope-sensitive session actions use `getAuthoritativeDirectoryForSession()`, which resolves worktree metadata, session attachments, sync metadata, and global session metadata.
4. `session-ui-store.ts` should delegate to `session-actions.ts` for these mutations instead of duplicating SDK calls.
5. `setCurrentSession()` announces a monotonic session-switch intent before directory resolution or store publication. Delayed visual/transition callbacks must validate that intent and silently discard stale work.
6. On a real session id change, `setCurrentSession()` also calls `useUIStore.syncWorkspacePanelsForSessionSwitch()` so right-side workspace panels (context/subagent chat, file preview, git changes sidebar) hide when leaving a session and restore when returning. `openNewSessionDraft()` must call the same helper when clearing a real session for Welcome/draft, because it does not go through `setCurrentSession()`. Tab content remains directory-cached; only open/active visibility is session-scoped.
7. Edit staging restores the composer from the visible user-message snapshot captured at click time; commit refetches authoritative messages to determine the deletion range.
8. Sidebar previous/next navigation is scope-aware. `SessionSidebar` publishes the Recent order plus logically visible project rows to `session-navigation.ts`; keyboard and native-menu actions share that registry and update the explicit session Focus before committing current-session authority. Project-origin navigation is restricted to the current expanded project and never falls through to hidden rows or another project.
9. Global Mod+1…9 navigation is session-row based, not project based. `SessionSidebar` combines the currently revealed Recent rows with logically visible project rows, caps the visual order at nine, and publishes it through `sidebar-numbered-navigation.ts`. The numbered activation preserves the selected row's exact Recent/Project Focus identity.

Examples of global-store updates performed in `session-actions.ts`:

- `createSession()` -> `upsertSession(session)`
- `updateSessionTitle()` -> `upsertSession(result.data)`
- `shareSession()` / `unshareSession()` -> `upsertSession(result.data)`
- `archiveSession()` -> `archiveSessions([id], archivedAt)`
- `unarchiveSession()` -> `updateSession({ time: { archived: 0 } })` then `upsertSession` into the active list
- `deleteSession()` -> optimistic `removeSessions([id])` then immediate server delete
- UI hard-deletes use `scheduleSessionDeletes()` so the server delete waits for a 10s undo window; `cancelScheduledSessionDeletes()` restores local state without calling the server. Pending deletion IDs keep global refreshes and aggregated live child-store sessions hidden until cancellation restores the snapshot or delete settlement clears the pending state.
- Archive success toasts use `showArchivedSessionsUndoToast()` (undo + open `ArchivedSessionsDialog` via `setArchivedSessionsDialogOpen`); delete success toasts use `deleteSessionsWithUndo()`. Neither expands the sidebar archived bucket by default.

### Fork transition and event isolation

OpenCode publishes one `message.updated` event per cloned message and one
`message.part.updated` event per cloned part while `session.fork` runs. The UI
must not materialize that complete copied history into the directory store.

- Enter the shared fork transition view before dispatching the SDK request.
- Do not require the source session to already exist in a directory child
  store. Cold start may only have the session in the global index (or messages
  already loaded without a `state.session` row). Resolve the directory from
  current selection / worktree / global index, then hydrate the source session
  into the target directory store from the global snapshot or `session.get`
  before forking. Missing directory is a hard failure with user-visible toast.
- Suppress copied message/part events for the target session while the request
  is active.
- When the real session ID arrives, select it and load the normal bounded tail
  page through `fetchMessagesForSession()`.
- Keep a short message-ID cutoff after the response so transport-buffered copy
  events cannot refill the complete history. Newer user/assistant events pass
  through normally.
- A current-session fork during `busy` or `retry` targets the latest user
  message. The active assistant message remains outside the forked history.
- An explicit user-message fork passes that user message ID and restores its text and file parts.
- An explicit assistant-message fork passes the following source message ID; an assistant at the source tail passes `undefined` and retains the full history through that reply.
- A current-session fork preserves the composer's existing resources.

### New conversation orchestration

Normal first prompts from an open draft use the optional runtime
`conversations.createWithPrompt` capability. Web and mobile send one
OpenChamber-owned request; the server creates the OpenCode session and admits
the first prompt. VS Code provides the same contract through its extension-host
bridge. Existing sessions, shell input, slash commands, explicit delivery
modes, and older runtimes keep the regular SDK sequence.

The client generates the message ID before the request. The server/runtime host
uses it as the bounded operation key, so reconnect retries reuse the in-flight
or completed operation instead of creating another session. Claiming a draft
submission sets `draftSubmitting` and yields one frame so the chat surface can
paint a full-screen establishing page (same visual pattern as fork transition)
until a real session ID is returned. ChatInput also sets `draftEstablishing`
before its response-style / snippet network preamble (composer text is already
cleared) so the empty draft dialog is not left on screen while those awaits
run; `claimDraftSubmission` clears `draftEstablishing` when the real claim
takes over, and failed sends clear it via restore.

Send-path prep must not compete for Chromium's per-origin HTTP/1.1 sockets:
`fetchResponseStyleInstruction` reads an in-memory cache warmed by settings
bootstrap / Behavior saves; `expandText` expands from the loaded snippet
catalog locally when every `#token` resolves. Git discovery
(`primary-root` / `worktrees`) is capped at 2 concurrent network calls with a
short TTL + in-flight dedupe so sidebar fan-out cannot starve create/prompt.

After success, commit the real session to directory routing, global session
state, selection state, and the optimistic shadow map. If SSE delivered the
message first, preserve that authoritative object and skip optimistic insertion.
Create-phase failures restore the draft and input. Prompt-phase failures keep
the created session; ambiguous delivery is confirmed by message ID and is never
automatically re-submitted.

### New-session draft ownership (Phase 1 Lane 3b)

An open new-session draft carries a stable `draftID`. Opening from closed state
creates a UUID, an idle repeated open retains that UUID and submission token,
and opening during submission creates a fresh UUID with a reset token sequence.
Close clears the ID. Runtime session memory preserves the complete draft state,
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
| `session.diff` | `session_diff` |
| `session.status/session.idle/session.error` | `session_status` |
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
| `selection-store.ts` | Per-session model/agent/variant choices | Model/agent picker |
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
