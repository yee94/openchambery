# Session Sidebar Documentation

## Refactor result

- `SessionSidebar.tsx` now acts mainly as orchestration; core logic moved to focused hooks/components.
- Sidebar is now a single multi-project tree: an optional pinned + in-progress
  top section, then projects, then worktrees/archived groups, then sessions.
  Pinned sessions render only in the top section and are excluded from project
  groups. The shared `pinnedSessions.ts` module owns both top-section helpers:
  `derivePinnedSessions` for the pinned group and `listInProgressHomeSessions`
  for the unlabeled in-progress/unread group below it. Running and unread
  sessions still remain in their project groups — the in-progress rows are an
  additional lift, not a move. Mobile projects home uses the same contract
  together with `createSessionOwnershipIndex` for session→project assignment
  and `buildSessionTree(..., { omitPinnedSessions: true })` so
  pinned roots leave project/worktree lists.
  Parent/child attachment always runs on the full session list first; pinned
  roots are omitted from project groups only after children attach. Pinned rows
  stay flat (no expand chevron, no nested subagents). Children of pinned parents
  stay hidden only while the parent is pinned; unpinning restores the normal
  parent/child tree under Projects.
- The top section renders every pinned session plus unlabeled running and
  top-level-unread rows, and supports header collapse. Its title becomes
  pinned/in-progress when the in-progress group is non-empty. Web, desktop,
  VS Code, and mobile home share this contract; VS Code still has no global
  pinned group but does show the in-progress rows in this top section.
  Expanded project/worktree
   groups reveal 3 sessions by default from the already-fetched 20-session page;
   Show more reveals cached rows before loading the next 20-session page on demand.
   Once expanded past the default page, Show fewer is available alongside Show more
    so the list can fold back without loading every remaining row first. Always-visible
    sessions (busy/retry live status, plus fallback global busy/retry entries, plus the
    current viewing session) from the loaded snapshot remain visible beyond the folded
    boundary. That fold-boundary rule is owned by `hooks/useAlwaysVisibleSessionIds` and
    `selectVisibleSessionNodes` / `selectVisibleSessions`; the mobile sessions sheet,
    projects home, and status-bar group lists share the same contract. Project/worktree
    collapse toggles are unrelated — only the Show-more fold keeps those rows visible
    while the group is expanded.
- Project/worktree Show more first reveals already-fetched rows, then fetches the next 20-session page for its own directory at the local boundary.
- The mobile session tree shows 20 root sessions by default for projects without worktrees. Projects with worktrees show 5 sessions per root/worktree bucket by default; Show more and Show fewer use that bucket's default page size. Collapsing and reopening a project or worktree preserves its revealed session count until Show fewer is selected or the sessions surface closes.
- Mobile project, worktree, and session rows expose their matching sidebar actions through a touch-sized bottom action panel after a 500ms long press. Scrolling movement and pointer cancellation abort the gesture, and the triggering click is consumed. Dedicated mobile and the responsive Web sessions sheet share the same hold controller; Web session rows retain their desktop context menu, while project and worktree context menus open the touch action panel.
- Project rows retain the persisted project-registry order while session and worktree data hydrates. A successfully sent message promotes its owning project to the top, advancing both the registry order and the persisted manual order so the default manual sort keeps the promoted project first; ordinary activity and selection do not reorder the structural project tree. The promoted/dragged order is PUT to the server settings `projects` array, which is the cross-runtime order contract: settings sync rebases the local manual order onto the server order, so desktop, web, and mobile render the same project order.
- The Projects section header no longer shows a global syncing accessory. While a
  project's session directories are fetching, that project's folder icon swaps to a
  spinner. The expanded body shows localized "Loading sessions…" only when there is
  no usable snapshot; background refresh keeps the existing rows visible.
- Runtime session index cold start first hydrates through TanStack Query SWR + a
  runtimeKey-scoped client cold-start snapshot (stale paint only), then the
  authoritative SQLite-backed `GET /session-index`, then asks the runtime-owned
  Web Server to refresh the newest 20 root sessions for every persisted project
  root and known worktree directory. Server SQLite + GET remain authoritative:
  a failed GET keeps the last good seed rows; a successful empty snapshot can
  clear them. The browser never fans out project `session.list` calls. The
  server uses one preemptible background lane; selected-session detail/message/
  children requests abort that lane, run first, and let the directory resume
  afterward. Git/worktree discovery is not part of session startup. Archived
  sessions remain a separate lazy path.

  When the session-index API is unavailable (501), the coordinator falls back to
  the existing SDK-backed global session list; unsupported `null` must not be
  treated as an authoritative empty success that wipes the client seed.
- Cached starts use OpenCode's `start` timestamp filter and merge only sessions
  changed since the last successful sync, and only when that directory already
  has at least one cached root summary. An empty cached directory is not
  incrementally eligible, so a later refresh can rediscover historical roots
  whose `time.updated` is older than `lastSyncedAt`. SQLite separately tracks
  the last incremental and last full reconciliation times; a full newest-20
  pass also runs at most once per 24 hours to remove sessions deleted or
  archived while the app was closed.
- `SessionStartupCoordinator` owns that pass before `SessionSidebar` mounts its
  normal orchestration. Hydrate of the SQLite session-summary index starts
  immediately (does not wait for settings) so the last snapshot can fill the
  sidebar before OpenCode finishes initializing. Directory planning and the
  background root refresh still wait for registered settings hydration, then
  read the latest persisted project paths so an initially empty renderer store
  cannot release the startup barrier early. After starting the server job, the
  UI observes SQLite revisions through OpenChamber tip events + GET. When SQLite
  has rows the startup logo releases as soon as those rows land in the store;
  validation continues with cached rows visible. A first run with an empty index
  waits until hydrate settles and OpenCode init (or the blocking root sync)
  completes; sidebar code must not start another hydrate or list cycle.
- Project collapse state controls presentation only; Electron session-summary
  refresh targets come from the persisted project index, so no collapse/re-expand
  gesture is required to make a project appear.
- Renderer-level worktree catalog reconciliation runs after event-stream ready,
  topology changes, and deduplicated unknown session directories. The sidebar
  consumes that catalog and retains `oc.worktreeMap` as its cold-start snapshot.
- Each project menu provides a session-sync action. It refreshes the project's
  root and known worktree directories through the Electron server-owned index
  queue, while Web and VS Code use the bounded SDK refresh fallback.
- Each session context menu provides a transcript refresh action ("Sync
  messages"). It fetches an authoritative OpenCode tail and replaces that
  session's visible transcript only after the fetch succeeds. Failure keeps the
  prior transcript. Busy/retry sessions disable the action. This is not the
  project session-list sync.
- The native tray consumes the sidebar/global cache and lightweight global status; it does not trigger a delayed all-project session-list fanout.
- Mounting active or archived session rows creates only lightweight child-store
  subscriptions (`bootstrap: false`). Routed live status/permission events still
  update those rows, while config/path/session bootstrap remains owned by the
  active chat instead of fanning out across every visible sidebar directory.
  Selecting a session never fetches its children; child sessions are loaded only
  when the user expands the parent tree control. Sessions with a `parentID` are
  never promoted to project roots — if the parent is missing, archived
  differently, system-owned (e.g. scheduled-task), or pinned-and-omitted, the
  child stays hidden instead of leaking into the main list.
- Tray status is event-first. Its startup/reconnect compensation waits for an
  established OpenCode connection, coalesces overlapping refreshes, and queries
  at most two directories concurrently; the 30-second poll is only a missed-event
  safety net.
- An idle global-session store always triggers a priority refresh, including after a runtime endpoint reset; the status therefore cannot remain idle after the sidebar's one-time mount effect has already run.
- `NavRail` is no longer part of sidebar/navigation flow.
- Project headers now own root sessions directly; there is no separate rendered `project root` subgroup.
- Active/hover rows use Codex-style inset neutral chips (`SIDEBAR_ROW_*`); light mode
  uses a soft wash (hover ~3.5%, active ~6%) so cream themes stay airy, while dark keeps
  a slightly deeper wash (hover 8%, active 11%) so the two states still read apart. Nested
  rows indent via padding *inside* the chip so hover/active wash stays full-width
  (reserved left gutter). Depth 1
  uses the folder icon column (`16 + 6`) so all project sessions share one vertical line under the
  parent folder *name*. Deeper levels (subagent) add ~one UI-label font size (`14px`) each.
  Worktree/archived group headers reuse the same folder chip chrome (hover wash + depth-1
  nest pad) so they share one vertical line with sibling folders; their direct sessions/folders
  keep that same depth so worktree items align with surrounding project items. Subsession
  expand chevrons align to the folder-icon column and stay hidden until row hover (unless
  always-show-actions). They render only when the session has loaded children or the
  persistent session index has confirmed that it has at least one child.
  Pinned rows stay flat: no subsession chevron and no nested children.
- Session rows are single-line (no inline timestamp); details (title, relative time, folder/project,
  branch) open in an immediate floating hover card. A shared `TooltipProvider`
  (`delay=0`, `closeDelay=150`, `timeout=600`) groups row tips so adjacent handoff
  is instant; per-row tooltips do not nest their own Provider. Pointer click keeps
  focus for Enter-to-rename, but row `mouseleave` blurs so `:focus-within` does not
  stick hover chrome after the card dismisses.
- A session title button focused by an explicit mouse click enters inline rename
  on Enter. Keyboard or programmatic focus does not arm this shortcut, and blur
  clears the mouse-focus authorization.
- Compact relative times use `common.relative.*Compact` i18n keys.
- Row action icons (pin, archive/delete) use title-matched `h-3.5` glyphs with `gap-1` spacing; the title
  reserves right padding on hover so icons own their space — no fade veil behind them.
  The former three-dot overflow menu is a direct archive control; hold Shift to hard-delete
  (archived buckets always show delete). Rename/share/folder and other actions remain on the
  row context menu.
- Session busy/unread/question status is a trailing shrink-0 marker on the right of the title
  (highlighted `question` icon while an ask-tool question is pending, ContextUsage-style
  track+arc ring while busy, info-colored unread dot when idle+unseen). Pending questions
  outrank the busy spinner because the session is waiting on the user. It owns its own
  gutter so long titles truncate before it, and hides instantly on row hover (no
  opacity/padding transition) when hover/always-visible row actions take that edge.
- Archived groups are collapsed by default and support bulk deletion at group/folder level.
- Session rows support compact inline dates in minimal mode and simplified metadata in default mode.
- Session-row visual selection is published through a narrow row-only Focus store before authoritative navigation. Focus includes the render scope (`pinned` or `project`) plus session/project identity, so duplicate representations never both receive the Active background or satisfy the wrong paint barrier.
- Previous/next-session navigation consumes ordered snapshots published from the rendered sidebar model and cycles one combined ring: visible pinned rows first, then the logically visible project rows in sidebar order, wrapping across both sections. Rows hidden by pinned/project/group/folder collapse or the group's Show more boundary are excluded, while always-visible (busy/retry + current viewing) rows retained beyond that boundary remain keyboard targets.
- Global Mod+1…9 navigation numbers the first nine logically visible session rows from top to bottom across Pinned and the expanded project tree. Container headers never consume a number; duplicate Pinned/Project representations remain distinct Focus rows. Holding the platform primary modifier for 500ms reveals compact shortcut chips only on those rows; each chip occupies only its intrinsic width and replaces row quick actions until release. Releasing the modifier, window blur, or page hide clears the hints immediately.
- Every session navigation announces a monotonic intent revision. A later sidebar, keyboard, deep-link, or switcher intent invalidates an older pending sidebar commit, including ABA sequences such as A -> B -> A.
- Project/group/folder ancestors are auto-expanded at most once for each navigation intent. Explicitly collapsing the project that owns the focused session remains respected during later hydration or persistence refreshes.
- Chat LRU visibility follows the authoritative selection synchronously: cache hits reveal the retained Activity immediately, while misses show an explicit skeleton. Constrained surfaces retain two 16 MiB views; geometry cache reuse keys on complete runtime, directory, and session identity; active-view estimates alone record cache size and trigger trimming. A newly rendered Activity enters the bounded LRU only after its DOM commit, so interrupted keyboard switches cannot evict a reusable view.
- New extractions in latest pass reduced local effect/callback bulk further:
  - project session list builders
  - folder cleanup sync
  - sticky project header observer

## VS Code grouping

- VS Code uses the **same grouped project tree** as web/desktop (project headers + folders + pinned-first ordering), not a separate flat list. Each open VS Code workspace folder is a project header.
- VS Code groups strictly **by open workspace**: `useSessionGrouping` funnels every non-archived session into the project's root group and emits **no per-worktree subgroups** (worktrees aren't registered in VS Code). `getSessionsForProject` buckets sessions to a workspace by exact directory match, so only sessions whose directory is an open workspace folder appear.
- VS Code passes `hideDirectoryControls` (clean workspace headers, no worktree/close chrome) and no longer passes `showOnlyMainWorkspace`/`sharedSessionsOnly`. Folders and pinning therefore work natively, scoped to the workspace root.
- VS Code still renders no global pinned group and no leading New Session/Scheduled/Assistants buttons, but does render the shared top section's unlabeled in-progress rows (busy/retry or top-level unread) above the project tree.

## File summaries

### Components

- `SidebarHeader.tsx`: Optional session-search field only (action toolbar removed).
- `GlobalSearchButton.tsx`: Shared command-palette trigger. Electron with a configured logo renders it in the fixed (non-scrolling) sidebar brand row while open; otherwise it sits next to the titlebar collapse control (web parity, including logo-less Electron).
- `TitlebarLeftControls.tsx`: Persistent Web brand and sidebar-toggle controls, plus Electron global search when the sidebar is collapsed or no logo is configured.
- `SessionSidebar.tsx` desktop brand header: When a logo/wordmark is configured, Electron renders brand + search above `SidebarProjectsList` (`shrink-0`, outside the scroll region). Empty brand config reserves no row and leaves search in the titlebar. Sidebar brand text is transport-scoped in localStorage (`useSidebarBrandStore` via `createRuntimeScopedJSONStorage`) so packaged multi-window local and remote hosts do not share a wordmark.
- `SidebarTopBar.tsx`: Desktop titlebar strip with preserved window-drag regions beneath the persistent titlebar controls.
- `SidebarDisplayModeMenu.tsx`: Project collapse/expand overflow menu; rendered in the Projects section title row beside the add-project action.
- `SidebarPinnedSessions.tsx`: Global top-section renderer for pinned sessions plus the unlabeled in-progress/unread rows below them.
- `SidebarFooter.tsx`: Static footer with icon-only settings and shortcuts actions, plus optional update button.
- `SidebarProjectsList.tsx`: Main scrollable tree renderer for projects, root sessions, worktrees/groups, and empty/search states.
- `SessionGroupSection.tsx`: Renders a single worktree/archived group, collapse/expand, folder subtree, and group-level controls.
- `SessionNodeItem.tsx`: Renders one session row/tree node with inline metadata, menu actions, minimal/default variants, and nested children.
- `ConfirmDialogs.tsx`: Shared confirm dialog wrappers for session delete and folder delete flows.
- `sortableItems.tsx`: DnD sortable wrappers for project and group ordering plus project-row action affordances.
- `sessionFolderDnd.tsx`: Folder/session DnD scope and wrappers for dropping/moving sessions into folders.
- `sessionNavigationModel.ts`: Flattens the rendered project/group/folder model into ordered shortcut targets, then filters them against project/group/folder collapse and Show more state so project-scoped shortcuts use only logically visible rows. Also owns `selectVisibleSessionNodes` / `selectVisibleSessions` for the compact Show-more fold (first N, then append always-visible ids past the boundary).
- `hooks/useAlwaysVisibleSessionIds.ts`: Shared running (busy/retry + uncovered fallback) and always-visible (running ∪ current viewing) session-id sets for PC sidebar and mobile session lists.
- `sidebar-numbered-navigation.ts` (sync): Publishes the global first-nine visible session target order consumed by Mod+1…9, with revision-safe responsive remount cleanup.
- `sessionOwnership.ts`: Resolves session directories once into shared project/worktree ownership and folder-scope indexes.
- `manualProjectSessionSync.ts`: Builds deduplicated manual session-index sync directories from the project root, current selection, and freshly refreshed worktree catalog.

### Hooks

- `hooks/useSessionActions.ts`: Centralizes session row actions (select/open, rename, share/unshare, archive/delete, confirmations).
- `hooks/useSessionSearchEffects.ts`: Handles search open/close UX and input focus behavior.
- Session bodies are loaded only for the selected session. The sidebar does not
  prefetch neighboring/recent session messages because those background pages
  compete with the active chat during cold start and rapid navigation.
- `hooks/useSessionGrouping.ts`: Builds grouped session structures and search text/filter helpers.
- `sessionTree.ts`: Pure parent/child forest builder for project grouping (pinned roots and their descendants omitted).
- `hooks/useSessionSidebarSections.ts`: Composes final per-project sections and group search metadata for rendering.
- `hooks/useProjectSessionSelection.ts`: Resolves active/current project-session selection logic and session-directory context.
- `hooks/useGroupOrdering.ts`: Applies persisted/custom group order with stable fallback ordering; archived groups are reorderable.
- `hooks/useArchivedAutoFolders.ts`: Maintains archived auto-folder structure and assignment behavior.
- `hooks/useSidebarPersistence.ts`: Persists sidebar UI state (expanded/collapsed/group order/active session) to instance-scoped storage (`oc.inst.{runtimeKey}.*`) + desktop settings. Project registry order and `projectSortOrder` are also instance-scoped so two mobile hosts do not share one list. Session pin membership is derived from the server session-index snapshot (`pinnedSessionIds` plus in-window `time.pinned`), not localStorage.
- `hooks/useProjectRepoStatus.ts`: Tracks per-project git-repo state and root branch metadata.
- `hooks/useProjectSessionLists.ts`: Reads live and archived project buckets from the shared ownership index.
- `hooks/useSessionFolderCleanup.ts`: Cleans stale folder session IDs by reconciling known sessions/archived scopes.
- Folder and session-order cleanup consume the store's complete-catalog ID snapshot (`fullCatalogSessionIds` + generation). Pinned IDs come from the session-index snapshot and need no local prune. Bounded directory snapshots only drive visible rows.
- Session order is keyed by each group's `folderScopeKey` and bound to the activity/member snapshot captured at drag time. Later activity or membership changes restore natural sorting; visual rows, navigation, and sortable items consume the same scope-local rule.
- `sessionSortableOrder.ts` derives visible sortable IDs and the shared scope-local comparator from the rendered folder tree, collapsed/search state, Show-more slice, and order activity snapshot. Reordering stays within one folder or the ungrouped scope; folder drops own cross-folder moves.
- `hooks/useStickyProjectHeaders.ts`: Tracks which project headers are sticky/stuck via `IntersectionObserver`.
- Visibility performance (`isVisible` prop): desktop passes `isSidebarOpen`, mobile
  passes `mobileLeftDrawerVisible`. When false, the session row tree unmounts and
  speculative work stops (live session/status aggregates, sticky headers, PR
  enrichment, search listeners, archived auto-folders, project repo status). The
  outer sidebar chrome stays mounted so UI state and authoritative session-index
  refresh remain available for an immediate reopen (mobile always-mount for
  issue #1695 is preserved at the layout shell).
- Structural vs recency: global `upsertSession` and live-list equivalence ignore
  pure `time.updated` churn so ownership/grouping memos do not rebuild on every
  streaming tick. Title/parent/archive/directory/share/metadata still invalidate.
  Row activity continues to come from the session-keyed live status channel.
- Directory child-store eviction uses a soft `MAX_DIR_STORES` plus a 30s grace
  window and microtask-coalesced eviction so expanding a project with many
  worktrees cannot thrash still-mounting directories.

### Types and utilities

- `types.ts`: Shared sidebar types (`SessionNode`, `SessionGroup`, summary/search metadata).
- `activitySections.ts`: Persisted top-section storage/helpers for the current `recent` session list.
- `sessionFocusReconciliation.ts`: Repairs the explicit Pinned/Project focus identity after sidebar metadata or visibility changes without changing the authoritative current session.
- `utils.tsx`: Shared sidebar utilities (path normalization, sorting, dedupe, archived scope keys, project relation checks, text highlight, labels, compact/default date formatting, nest-indent padding helpers).
