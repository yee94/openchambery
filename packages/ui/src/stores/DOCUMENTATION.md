# UI Stores

## Purpose

`packages/ui/src/stores` contains app-level Zustand stores for persistent UI state, runtime state, and feature caches.

Not all state in the UI belongs here.

Use a store when state is:

- shared across distant parts of the app
- needed outside a single component subtree
- cache-like and keyed by runtime identity (for example directory, branch, session id)
- updated imperatively from multiple surfaces

Do not put high-frequency local component state here just because it is convenient.

## Architecture

There are multiple store categories in this directory.

### Feature cache / query stores

These are the most performance-sensitive.

- `useGitStore.ts`
- `useGitHubPrStatusStore.ts`
- `useFilesViewTabsStore.ts`

These stores act like centralized keyed caches. UI should consume narrow slices from them instead of re-fetching the same data in multiple places.

TanStack Query owns runtime-scoped pull server state. Every query key begins with
the runtime transport identity; `queryKeys.scoped()` appends feature arguments
such as directory, and `queryKeys.quota()` appends the provider. A runtime
transport identity change clears the Query client, so cached data never crosses
runtime transports.

`fileQueries.ts` owns runtime-scoped directory, search, content, and stat pull
state. Its keys include transport, normalized path scope, resource, and behavior
options. `MobileFilesSurface` uses this baseline while retaining navigation,
route, drafts, raw asset auth, and mutations locally.
`DiagramView` keeps initial diagram reads in the content Query while retaining XML editing and its serial save queue locally.
`planQueries.ts` owns resolved plan reads. Its aggregate Query resolves target paths or the ordered session repo/home candidates using the authoritative optional-read `exists` contract. `PlanView` owns the editable draft and serial save queue; successful saves update the matching file-content and plan aggregate snapshots.

`agentQueries.ts` and `commandQueries.ts` own their official SDK catalogs, then
resolve OpenChamber-owned scope metadata with one bounded batched runtime request.
Keep this batch boundary to prevent catalog-sized metadata request fanout during cold
startup. `useAgentsStore` and `useCommandsStore` own selection, drafts, and mutation
actions.

Agent, command, and installed-skills queries use transport identity plus configuration directory.
Composer consumers pass the effective session, worktree, or draft directory explicitly so discovery,
highlighting, and send-time slash classification share the same query scope. Settings consumers retain
the active project configuration directory.
Metadata failures retain the prior complete query snapshot for that key; the
failed refresh leaves that snapshot available. `useAgentsStore` owns agent
selection, drafts, and mutation actions while `agentQueries.ts` owns agent server
state and metadata enrichment. `useConfigStore` retains SDK agent ownership.

`mcpQueries.ts` owns MCP configuration lists and official runtime status by
transport identity and normalized directory. `useMcpConfigStore` retains
selection, drafts, and configuration mutations; `useMcpStore` retains runtime
diagnostics and connection/OAuth mutations. Every mutation captures transport
and directory before dispatch, then refreshes the matching Query keys.

`githubAuthQueries.ts` owns GitHub authentication status by transport identity.
Auth refreshes retain the prior complete snapshot on failure, while
`useGitHubAuthStore` provides only imperative refresh and cache-write actions.
PR status watchers keep their specialized visible-consumer lifecycle in
`useGitHubPrStatusStore`.

Skills Catalog sources and source pages belong to TanStack Query. Their keys use
transport identity, configuration directory, and source ID for source pages.
`useSkillsCatalogStore` owns source selection and scan/install mutation state.
Skills mutations capture their directory and transport before dispatch. Successful
mutations refresh the matching installed-skills query and invalidate matching
Catalog queries after OpenCode is ready. The installed-skills query is the sole
owner of the installed list; `useSkillsStore` retains selection, drafts, detail
reads, and mutations. Concurrent reads and mutation refreshes for one transport
and configuration directory share the same TanStack Query flight.

`useQuotaStore` keeps UI settings and rendered provider results. Runtime reset
clears quota results, fetch state, errors, and active refresh generations.
Provider refreshes commit independently, so successful providers remain visible
when another provider fails; the store reports the failed provider error.

### UI state stores

Examples:

- `useUIStore.ts`
- `useDirectoryStore.ts`
- `useFeatureFlagsStore.ts`
- `useUpdateStore.ts`

These stores coordinate visible app state, navigation, selected tabs, dialogs, and lightweight feature flags.

`useUIStore` keeps context-panel tab *content* directory-scoped (`contextPanelByDirectory`), but the *open* state of the right workspace (context panel for subagent/file preview/diff, plus right sidebar git/files) is session-correlated. `syncWorkspacePanelsForSessionSwitch()` captures the previous session snapshot into in-memory `sessionWorkspacePanelById` and restores the next session (or closes panels when there is no snapshot). Callers that leave a real session must invoke it: `setCurrentSession()` on session id change, and `openNewSessionDraft()` when clearing the current session for Welcome/draft (it does not go through `setCurrentSession`).

Exact tool patches selected from `edit`, `multiedit`, and `apply_patch` rows live in the transient `contextToolDiffByDirectory` map. Edit-style rows retain one file, while an `apply_patch` row retains every renderable file from that invocation. The persisted tab keeps only its target path, turn message, and focus line; regular diff navigation, scope changes, tab close, and runtime switches clear the transient patches.

ContextPanel chat navigation stays component-local and is keyed by normalized
directory plus tab ID. It owns its anchor/current/stack and retained transcript
view metadata; `useUIStore` owns tab content, active tab, close, and reorder.
Panel navigation preserves the primary session selection in `session-ui-store`.
Web and Electron store up to four panel transcript views within a 48 MiB local cache;
the cache is runtime-scoped through each view's geometry key and is cleared for
all nested views when its tab closes.

`configCatalogQueries.ts` owns the safe Provider catalog and raw Agent catalog by transport
identity plus normalized project configuration directory. New OpenChamber hosts always use the safe
projection from `GET /api/config/catalog/providers` via `runtimeFetch`, with directory and AbortSignal
propagation. Older OpenChamber hosts that answer 404 or 501 use one compatibility read through the
official SDK's `/api/config/providers` network path; its raw response is parsed immediately into the
safe DTO. The Provider DTO admits only provider/model display and capability fields;
the parser constructs each field, drops unknown keys, bounds collections, and accepts
partial catalogs with invalid individual entities removed. TanStack Query owns the sole
network retry policy, infinite freshness/retention, exact invalidation, and single-flight.
`useConfigStore.ts` owns project-scoped UI projections, selection, and mutation
orchestration. It applies the Provider DTO allowlist again when projecting Query
results into the store. TanStack Query is the sole SWR cache for Provider/Agent
catalogs and is memory-only — `config-store` localStorage persistence must never
write `providers` / `agents` / `defaultProviders`. Persisted selection and settings
carry transport identity; legacy catalog blobs and catalogs from another runtime
are discarded on rehydrate while unrelated user settings remain available. Runtime
endpoint reset clears Provider and Agent snapshots, directory scopes, defaults, and catalog
selection state. Reset and same-device LAN⇄relay rebinds must assign
`catalogTransportIdentity` from `getRuntimeTransportIdentity()`, never from `runtimeKey`;
`runtimeKey` is the stable device/instance id shared across transports, while catalog loaders
discard writes whose transport fingerprint does not match the active one. The persisted allowlist excludes credential fields, catalog snapshots, and unknown keys; migration
rewrites legacy envelopes through that allowlist. Partial Provider refreshes retain an existing
complete in-memory snapshot while cold partial snapshots remain available. Provider and Agent loads capture
runtime generation and transport identity before every commit, trace, error log, and loading
cleanup, so an earlier runtime lifetime cannot republish catalog state after a switch. Refresh
failures retain the previous in-memory snapshot.

`catalogTransportIdentity` must equal `getRuntimeTransportIdentity()` — the
`direct:` / `relay:` transport fingerprint — not `runtimeKey`. `runtimeKey` is the
stable paired-device/instance id and stays the same across LAN⇄relay; Provider/Agent
loaders compare against the transport fingerprint, so writing `runtimeKey` into
`catalogTransportIdentity` silently drops catalog results after a transport switch
while the rest of the app looks connected. Both `resetAppForRuntimeEndpointChange`
and `reconnectAppForTransportSwitch` in `runtimeEndpointReset.ts` must keep that
fingerprint in sync. On the parser side, empty-string `release_date` is treated as
absent (common upstream placeholder) and must not force `partial: true` when the
providers/models themselves are valid. When Host catalog routes are missing,
Relay/mobile clients can still receive SPA HTML for `/api/config/catalog/providers`;
fix that against the Host process that holds the relay claim before debugging the
UI gate.
Settings bootstrap defaults are read through `settingsBootstrapQueries.ts` by
runtime transport identity from the dedicated `GET /api/config/settings/bootstrap`
safe projection. Provider and Agent loads across configuration
directories share its infinite-freshness Query snapshot, and the response-style
send-path cache is partitioned by transport and warms from that same snapshot.
Confirmed settings saves capture their originating transport and patch that exact
snapshot through the allowlisted DTO parser; failed loads and saves retain the prior
Query or Store snapshot. Full Settings synchronization keeps its short-lived cache,
in-flight request, debounce batch, and hydrated diff scoped to the same captured
transport. The Behavior surface loads the response-style bootstrap and AGENTS.md
independently; each editor remains read-only until its authoritative source succeeds.

`ChatInput` subscribes directly to the active `agents` snapshot for permission
auto-accept visibility. It derives the selected agent's prompt capability locally,
so this UI decision adds no server request.

### Session / project coordination stores

Examples:

- `useProjectsStore.ts`
- `useGlobalSessionsStore.ts`
- `useSessionFoldersStore.ts`
- `useSessionFocusStore.ts`

These stores coordinate persistent project/session metadata across multiple views.

`useWorktreeOrderStore.ts` persists worktree display order and pending write
intent in runtime-scoped partitions. Server revision maps stay transient because
the sync layer owns runtime reconciliation. Worktree order is shared across
surfaces; expansion, selection, and session navigation state remain locally owned
by their respective stores.
Server responses advance a project's transient revision only. Equal and older
revisions preserve the current authoritative paths; pending local intent retains
its local paths while recording a newer server revision. Pending resolution always
clears its matching intent while retaining the greatest observed revision. A
pending project keeps its greatest remote order in transient runtime memory; an
older mutation acknowledgement applies that deferred order, while a newer
acknowledgement retains the local order and clears the deferred record.

`useSessionFocusStore.ts` is intentionally transient and narrow. It records the
exact sidebar attention identity (`recent` or `project`, session, and project)
separately from the authoritative current session. Shortcut navigation and row
Active styling must read this identity instead of inferring origin from duplicate
session data.

`useGlobalSessionsStore.ts` distinguishes bounded display snapshots from the full
retention catalog. Sidebar active/archived loads are directory-keyed, capped, and
deduplicated. `fullCatalogSessionIds` and `fullCatalogGeneration` update only after
one complete active+archived catalog result; retention cleanup consumes that snapshot.
Directory refreshes preserve it, failed catalog loads preserve the prior snapshot,
and runtime switches clear it. Initial loading and background refreshing are separate
sets so an in-flight refresh never hides an existing session snapshot.
Pending session deletions are runtime-memory UI orchestration state. Their IDs filter
session-index snapshots, directory refreshes, direct upserts, pagination, archived
refreshes, and aggregated live child-store sessions throughout the undo window;
cancellation or delete settlement clears the matching IDs, and runtime switches clear
the complete set.

Electron cache refresh uses two timestamps per directory. Recent restarts query
the Electron Web Server, which performs `session.list(start=lastSyncedAt)` and
merges changed summaries into SQLite;
`lastFullSyncedAt` enforces a periodic full newest-page reconciliation so
offline deletes/archives cannot remain indefinitely.

Directory session loads also wait on the runtime-keyed OpenCode readiness
coordinator. Concurrent directories share one health-probe chain, so a cold
OpenCode process is not hit by parallel `session.list` calls. A runtime reset
invalidates both the directory requests and the matching readiness generation.
Cold directory refresh starts at three concurrent requests because each request
initializes directory-scoped OpenCode config and plugins. Successful completions
raise concurrency toward seven; timeout or overload feedback drops it to three
and then one. A failed readiness probe also enters a short runtime-scoped
cooldown, so queued directories share the same failure instead of starting a
new health-probe chain each time.

On Electron, `useGlobalSessionsStore` is also the UI owner for the SQLite
session-index startup state. The root coordinator restores summaries first and
then starts one server-owned background job. A low-priority long poll applies
new SQLite revisions and updates `startupSyncProgress`; it must not issue
per-directory OpenCode requests from the renderer. Do not add a second
session-summary cache to browser storage or a sidebar-local startup refresh.
Every global session-index asynchronous entry captures runtime generation and
transport identity, then applies its result only while both still match. This
covers snapshot hydration, startup sync, persistence, and long-poll revisions.

## Git / PR Stores

The Git and PR stores are the most important stores to understand before editing this directory.

### `useGitStore.ts`

`useGitStore` is a centralized per-directory Git compatibility cache for status,
log, identity, diffs, and branch Query mirrors. TanStack Query owns runtime-scoped
branches, remotes, and persisted branch startup snapshots through `gitBranchQueries.ts`.

Core model:

- top-level keyed by `directory`
- each directory entry contains:
  - repo detection
  - status
  - branches
  - log
  - identity
  - diff cache
  - per-directory loading flags
  - freshness timestamps

Important properties:

- `directories: Map<string, DirectoryGitState>` owns status, log, identity, and diff state
- branches/remotes Query keys contain transport identity plus normalized directory;
  branches use 30-second SWR freshness and infinite retention
- `fetchBranches()` delegates to the branches Query and mirrors successful results into
  the legacy store with their transport identity; Query owns persisted startup snapshots
- branch startup snapshots use version 2 transport-plus-normalized-directory keys; the
  former directory-only payload migrates once to the first reading transport, while
  malformed and unsupported payloads are ignored
- branch mutations use exact Query refresh before status refresh; Query observers
  share a single in-flight request for one runtime and directory
- loading state is per-directory, not global
- `ensureStatus()` and `ensureAll()` are the preferred entry points for consumers
- in-flight dedupe exists for status and `ensureAll()`
- diff data is separately cached and capped with size + count limits

### `useGitHubPrStatusStore.ts`

`useGitHubPrStatusStore` is a centralized PR cache keyed by `directory::branch`.

Core model:

- each entry stores:
  - current PR status payload
  - loading / error state
  - whether initial status was resolved
  - refresh timestamps
  - watch count
  - runtime params
  - resolved identity

Important properties:

- `ensureEntry()` initializes a key lazily
- `setParams()` attaches runtime context
- `startWatching()` / `stopWatching()` are for true live PR consumers only
- `refreshTargets()` supports one-shot multi-target bootstrap without turning on live watching
- persisted cache is for page refresh continuity, not for broad background syncing

## Ownership Rules

These rules are important. Breaking them tends to reintroduce idle CPU churn, stale UI, or rerender fanout.

1. No broad `directories` or `entries` subscriptions in normal UI components.
2. No root pollers for Git or PR.
3. No broad idle sweeps across many directories.
4. Prefer store `ensure*` methods over direct runtime API calls from views.
5. Visible consumers should drive refresh. Hidden consumers should not.
6. Header should not depend on PR store.
7. Closed sidebar should not create live PR work.
8. File tree Git status should update only when the file tree is visible.

## Message queue ledger

`message-queue-ledger.ts` owns the JSON-safe v4 durable queue contract under
`openchamber_message_queue_ledger_v4`. Its parser accepts only plain DTOs,
bounded strings and collections, durable URL locators, and blob IDs; runtime
`File`, `Blob`, bytes, `data:` and `blob:` values remain outside metadata.
Attachment references and recovery issues carry complete display metadata.
Local, server, and VS Code sources have mutually exclusive path fields, and
the parser enforces canonical scope keys plus global queue, operation, and
message identity uniqueness. Shared limits bound scopes, rows, attachments,
issues, content, and legacy byte decoding. Queue items may carry a validated
Composer sidecar. `content` remains the canonical projection and legacy fallback;
`composerDocument` owns semantic delivery after strict durable-document parsing
and exact queue-canonical equality validation.
`composerMentions` is a bounded authored file/agent identity sidecar for the transition through v3 and v4 queues. Skill and image identity stays with Composer reference strategies.
Detailed reads preserve raw metadata, normalized valid rows, parse issues, and
degraded scope keys. Compatibility reads report partial metadata as corrupt, so
only a complete snapshot becomes authoritative. Queue, operation, and message
IDs remain globally unique across scopes. Repository persistence deep-clones
admitted snapshots, coalesces concurrent flush waiters, and cancels pending work
when durability is disabled while an active write completes.
The canonical scope key uses the v3 encoding. Persisted sending work normalizes
to reconciling during migration/hydration. The ledger sink serializes writes and
reports unavailable, quota, corrupt, serialization, and cancelled outcomes.

`message-queue-migration.ts` imports the v3 Zustand envelope only while v4 is
absent. It assigns deterministic IDs, retains bound data-URL bytes before the
v4 commit, records attachment migration issues, and preserves the legacy payload
for degraded migrations. Attachment issues take terminal unresolved ownership;
legacy retry, ambiguous, definitive, and unresolved states map to strict v4
state shapes. Partial or corrupt v4 metadata enters recovery-required mode and
performs zero migration mutation. Existing v4 metadata remains authoritative.

The v3 message queue physically partitions entries by
`transportIdentity + directory + sessionID`. Queue item identity has three
separate IDs: `queueItemID` identifies the ledger row, `operationID` identifies
one send operation, and `messageID` begins as an admission candidate. Each real
v3 POST reads the scoped maximum `msg_` ID, rotates to a fresh ID above it, and
persists that ID with `sending` through one barrier. Stable flights use scope,
queue item, and operation. Ambiguous dispatch keeps its fresh ID for
reconciliation; pre-dispatch retries and manual terminal sends rotate again. The
v4 cutover requires this same fresh-ID barrier. States progress through queued, sending, reconciling, retrying,
failed, and confirmed removal; persisted `sending` entries hydrate as
`reconciling` because delivery status requires confirmation.

Sending and reconciling items remain immutable while dispatch ownership or
delivery status is unresolved. The v3 auto-send owner tracks dispatch flights
by exact scope, queue item, and operation identity plus one scope-level flight through POST promise settlement. The message ID matches the current attempt during confirmation and reconciliation; live `sending`
heads outside that registry recover into reconciling (same as v4). Queued heads and due
retrying heads auto-dispatch only with an authoritative scoped `idle` status.
Failed and unresolved entries are terminal queue states and require explicit
manual Send, Edit, or Remove. Manual Send may select any recoverable row, atomically promote it to the scoped head, and dispatch it with a fresh identity; automatic dispatch remains FIFO. A scope with sending or reconciling work accepts no second dispatch. Reconciliation persists
its check count, deadline, and `nextCheckAt`; in-flight requests own no timer,
while the global scheduler wakes once at the earliest persisted next check. A
max-check or deadline terminal result becomes unresolved and triggers no auto
POST.
Legacy migration preserves known bound owners and places unresolved entries in
an unbound legacy scope until an explicit bulk send bind at the dispatch boundary. Cutover resolves every legacy session through authoritative session-directory state, plans every binding before one atomic apply, then flushes the fully bound snapshot for v4 migration. A missing directory leaves every legacy scope in place and keeps cutover blocked. Queue UI selects one scope or one item at a time; it
avoids broad ledger subscriptions, cross-scope scans in render paths, and
selector allocations that amplify queue updates.

## Selector Rules

Use leaf selectors.

Good:

- `useGitStatus(directory)`
- `useGitBranches(directory)`
- `useGitBranchLabel(directory)`
- `useGitRepoStatusMap(directories)`
- `usePrVisualSummaryByKeys(keys)`

Bad:

- `useGitStore((state) => state.directories)` in feature components
- `useGitHubPrStatusStore((state) => state.entries)` in feature components
- render-time scans over every PR entry for a single project/group badge

Why this matters:

- Zustand reruns selectors on every `set`
- rerenders are avoided only if the selected result stays referentially stable
- broad subscriptions magnify fanout even when only one directory changed

## Performance Rules

### 1. Preserve references for unaffected entities

If directory `A` changes, directory `B` should keep the same derived reference where possible.

### 2. Keep loading state per entity

Do not add new global `isLoadingWhatever` flags for keyed cache work.

### 3. Avoid hidden work

If a surface is not visible, it should not keep refreshing Git/PR state.

Examples:

- `PullRequestSection` may watch a PR while visible
- `SessionSidebar` may bootstrap missing PR data for expanded visible groups
- hidden sidebar should not watch PRs

### 4. Prefer one-shot event hints over polling

Example already in use:

- successful mutating tools emit a centralized Git refresh hint through `sessionEvents`
- visible `GitView` / `DiffView` consume the hint and refresh current-directory status

This is preferred over background polling.

### 5. Treat `diffStats` carefully

`GitStatus.diffStats` may be omitted by light status fetches.

Rules:

- do not erase richer existing `diffStats` with a lighter payload
- if a UI surface requires per-file `+/-` stats, it must ensure a full enough status payload exists

### 6. Keep diff cache bounded

Diff cache has explicit limits because large repos can otherwise blow up memory.

Do not raise limits casually.

## Refresh Model

### Git

Expected model:

- `GitView` / `DiffView` ensure current-directory Git state when visible
- explicit Git actions refresh status/branches/log as needed
- successful file-mutating tools can issue a one-shot Git refresh hint
- no root-level background Git polling

### PR

Expected model:

- `PullRequestSection` is the only true live PR watcher
- `SessionSidebar` may do one-shot bootstrap for expanded visible project/worktree groups if PR info is missing
- no live PR work for header
- no background PR sweeps outside visible demand

## Known Intentional Fallbacks

There is still one explicit fallback path worth knowing about:

- `SessionSidebar` may call `checkIsGitRepository(...)` during initial worktree/project discovery when store state is not populated yet

This is currently acceptable as a narrow bootstrap fallback.

Do not widen it into a polling or broad refresh system.

## When Editing These Stores

Before changing store shape or selectors, ask:

1. Is this keyed by the right identity (directory, branch, session, root)?
2. Will this force unrelated consumers to rerender?
3. Should this be visible-demand-driven instead of background-driven?
4. Is there already a store cache for this data?
5. Am I duplicating fetch ownership in a component when it should live in a store action?

## Validation Checklist

After meaningful Git/PR store changes, verify manually:

1. Idle desktop app stays quiet on draft/chat screen.
2. Git view still loads status, branches, log, identity.
3. Diff view still opens the correct file and stays in sync.
4. Worktree sessions still show branch labels in header.
5. Expanded sidebar projects/worktrees can show PR state without requiring prior selection.
6. Hidden surfaces do not reintroduce live background work.
