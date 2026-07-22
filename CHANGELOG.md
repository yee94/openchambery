# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

## [1.16.55] - 2026-07-23

- **Android sharing:** hand shared text and links from the native Android share sheet into the Assistant composer after the app opens, with durable inbox storage and localized confirmation copy.
- **Assistant composer:** add mobile share draft handoff so incoming shared content can populate Assistant conversations instead of staying in the native receiver screen.
- **Relay mobile history:** reduce relay mobile session history pages to five messages to keep tunneled conversation loads smaller while preserving direct mobile and desktop page sizes.

## [1.16.54] - 2026-07-23

- **Provider startup snapshots:** persist one bounded safe Provider catalog snapshot for the active configuration directory, seed the cold Provider TanStack Query from that complete snapshot on rehydrate, and keep partial and Agent catalogs memory-only.
- **Session drafts:** force-refresh Providers when opening a new session draft or switching its target, and apply default model/agent selection only for the latest completed draft activation.
- **Config store persistence:** sanitize persisted agent/model selections and Provider default entries, bound persisted catalog size, and migrate the config-store schema to version 2.

## [1.16.53] - 2026-07-22

- **Assistants:** add cross-instance Assistant workspaces with continuous and stateless modes, session binding, managed or project workspaces, share-operation polling, and a Settings surface for create/edit lifecycle.
- **Assistant UI:** reuse the shared chat shell for Assistant conversations, with desktop list navigation, mobile chip selection, emoji avatars, onboarding that routes into Settings, and per-device share welcome guidance.
- **Mobile sharing:** deliver Share Sheet and Direct Share content into Assistant inboxes on iOS and Android, with native confirmation screens, draft promotion, stable operation IDs across retries, and iOS intent donations for suggested recipients.
- **Message queue:** admit Assistant-targeted queue items with captured provider/model/agent config, wake the server runtime after successful admits, and tighten queued-message edit/remove eligibility.
- **Composer:** improve session-mention handling, message display normalization, and trigger-icon rendering across Assistant and chat surfaces.
- **Dependencies:** upgrade `@opencode-ai/sdk` to 1.18.4.

## [1.16.52] - 2026-07-22

- **Runtime switching:** bind catalog transport identity to the active transport fingerprint instead of the stable runtime key so provider and agent reloads survive LAN⇄relay swaps without being silently discarded.
- **Composer commands:** render slash-command references with the shared trigger-icon overlay in composer highlighting so command chips match Session and Skill references visually.
- **Composer icons:** anchor legacy and temporary attachment citations to full-size trigger icons instead of compact in-trigger glyphs for consistent chip alignment.
- **Provider catalog:** treat empty upstream `release_date` values as absent and reject blank or whitespace-padded provider display names during catalog parsing.

## [1.16.51] - 2026-07-22

- **Unified updates:** route Web, CLI, VS Code, Capacitor mobile, and Desktop version checks through the EdgeOne update service, with platform-specific mobile downloads and Electron metadata that keeps signed installers on GitHub Releases.
- **Release automation:** publish the EdgeOne release manifest from the completed GitHub Release workflow so every successful release becomes visible to all clients automatically.
- **Private relay package:** move the self-hosted Relay server and CLI into the dedicated `@openchamber/relay-server` package with updated packaging, lifecycle, hardening, and end-to-end coverage.
- **Composer references:** add durable inline reference detection, rendering, history, and adapters for authored resources across input highlighting, messages, drafts, and queued delivery.
- **Configuration catalogs:** add bounded provider and settings bootstrap contracts with runtime-scoped queries and matching Web and VS Code bridge implementations.
- **Git branches:** add branch query caching and startup snapshots so branch selectors and Git views share current repository state with fewer repeated requests.
- **Runtime switching:** reset endpoint-scoped caches and state consistently across Web, Desktop, VS Code, and mobile surfaces when the active runtime changes.
- **Reliability:** strengthen configuration, persistence, response-style, session bootstrap, and Git-store validation with focused regression coverage.

## [1.16.50] - 2026-07-21

- **Private relay:** add the self-hosted `openchamber-relay` server for Layer 1 remote access, with CLI packaging, Docker deployment, health/readiness endpoints, and end-to-end routing coverage.
- **Private relay packaging:** move the self-hosted Relay server and CLI to `@openchamber/relay-server`; `openchamber-relay` remains the command name and installs from the new package.
- **Queued messages:** accept canonical Composer sidecars with Paste and Session reference labels while validating their serialized content against queue-canonical admission.

## [1.16.49] - 2026-07-21

- **Message editing:** restore the composer from the visible user-message snapshot captured at click time so edits still work when the directory store has not hydrated that message yet.
- **Sidebar:** simplify the Recent header equalizer menu to project collapse and expand actions, removing the in-menu display-mode toggle and sessions-settings shortcut.
- **Localization:** rename the sidebar equalizer labels across all supported locales to match the project expand/collapse actions.

## [1.16.48] - 2026-07-21

- **Session forking:** resolve explicit assistant-message fork points to the following source message ID so forks retain history through the selected reply without restoring composer input.
- **Command palette:** keep the search field transparent so it inherits the palette surface while retaining its border and focus ring.

## [1.16.47] - 2026-07-21

- **Session references:** hydrate the target conversation before inserting an `@session` mention, show a localized failure toast when the reference cannot be materialized, and share one session-mention candidate filter across autocomplete surfaces.
- **Worktree bootstrap:** add authoritative compensation polling after the initial seed so missed ready events still settle bootstrap state and background watchers recover cleanly.
- **Sidebar scrolling:** keep archived-session virtual rows aligned with the sidebar scroll container when the archived section mounts inside the shared list.
- **Localization:** add translated copy for session-reference load failures across all supported locales.

## [1.16.46] - 2026-07-21

- **Directory mentions:** support `@folder` mentions in the composer with persisted `directory` mention kind, autocomplete hits that keep directory intent, and delivery that sends OpenCode `application/x-directory` attachments through send and queued-message paths.
- **Directory attachments:** show the shared folder glyph for directory attachments and mentions in composer chips and message file rows, detecting OpenCode directory mime and trailing-slash path markers.
- **Keyboard shortcuts:** add `Mod+\` as a default alias for toggling the review panel alongside the existing shortcut.

## [1.16.45] - 2026-07-21

- **Localization:** translate Today, Yesterday, and Yesterday-with-time date labels in Simplified and Traditional Chinese locale dictionaries.

## [1.16.44] - 2026-07-21

- **Searchable pickers:** unify search-field chrome across command, select, and dropdown pickers with the shared bordered `Input` look, consistent padding, and dense `h-8` search rows in model, agent, branch, and command-palette surfaces.
- **Popup positioning:** keep shared `Select` and `DropdownMenu` popups inside the viewport with default collision padding and shift-based collision avoidance instead of flipping off-screen.
- **UI documentation:** document the required select and searchable-picker contract in shared UI primitives so new pickers stay visually and behaviorally consistent.

## [1.16.43] - 2026-07-21

- **Chat thread icon:** replace the session-reference glyph with a compact overlapping double-bubble `chat-thread` icon across chat mentions, headers, context tabs, and sidebar actions.
- **Sidebar polish:** align project-group status colors with branch tinting, tighten footer icon buttons to match titlebar toggles, and improve pinned-session and loading-spinner contrast.
- **Context file opens:** require authoritative optional-read existence headers so missing files no longer open as empty editor tabs.
- **Runtime CORS:** expose `x-openchamber-file-exists` to packaged clients so optional file reads can distinguish empty files from missing paths.

## [1.16.42] - 2026-07-21

- **Draft branch selector:** reuse the Git sidebar searchable branch selector for new conversations, with project-root and worktree targets listed at the bottom.
- **Branch switching:** when picking a branch in a draft conversation, choose between checking out in the current directory or opening an isolated worktree for that branch.
- **Worktree drafts:** add branch-scoped worktree draft creation so existing branches can spawn dedicated worktrees without generating a new branch name.
- **Draft target switching:** clear create-time draft locks after worktree bootstrap so project root (e.g. main) remains selectable once the new worktree appears.

## [1.16.41] - 2026-07-21

- **Queued attachments:** allow the `X-Message-Queue-Content-Length` header through runtime CORS preflight so packaged clients can send explicit upload size metadata with queued attachment requests.

## [1.16.40] - 2026-07-21

- **Worktree bootstrap:** replace client polling with live OpenChamber worktree-bootstrap status events, with updatedAt ordering so delayed HTTP seeds cannot overwrite newer ready or failed states.
- **Git workspace:** subscribe GitView to the shared bootstrap store and seed status once on open instead of polling every 500ms.
- **Session status sync:** remove periodic `/session/status` polling from sync and tray surfaces; reconnect and bootstrap now take one authoritative snapshot that also covers idle-to-busy transitions missed while the stream was down.
- **Queued attachments:** accept server-side upload storage keys in queue attachment locators, send explicit upload content-length headers, and tolerate missing download length headers when validating attachment size.
- **VS Code:** forward worktree bootstrap status events into agent and session webviews so worktree readiness stays in sync without polling.

## [1.16.39] - 2026-07-21

- **Runtime SSE transport:** add a shared fetch-based SSE consumer that works through encrypted relay responses, replacing browser `EventSource` for OpenChamber event tips.
- **OpenChamber events:** isolate listener failures, tighten revision validation, and reconnect cleanly across runtime endpoint changes and heartbeat timeouts.
- **Relay sync:** deliver message-queue revision tips over tunneled SSE with abort-aware stream cleanup and UTF-8-safe event parsing.
- **Queue worker dispatch:** reserve eligibility before claiming queued messages, defer ineligible candidates with bounded timeouts, and keep lease generation aligned with runtime authority fencing.
- **Session undo toasts:** truncate long archive and delete undo messages on narrow layouts instead of overflowing the toast row.
- **CI:** use the public npm registry in the lockfile instead of the Tencent mirror that caused intermittent desktop build failures.

## [1.16.38] - 2026-07-20

- **Event-driven sync:** replace session-index and message-queue long-polling with SSE revision tips so clients refresh snapshots only after authoritative changes or stream reconnects.
- **Queue dispatch:** let authoritative idle sessions dispatch queued messages as soon as the trailing assistant turn arrives, instead of waiting for `time.completed` metadata that added a visible drain gap.
- **Git discovery:** cap concurrent primary-root and worktree discovery requests, dedupe in-flight lookups, and share the same network gate with runtime-backed Git bridges.
- **Snippet expansion:** expand `#hashtag` references in the composer through a shared snippet registry with alias resolution, prepend/append blocks, and cycle protection.
- **Response style:** cache response style settings locally so queued and auto-send prompts can inject style instructions without a settings round trip.
- **Message queue runtime:** tighten transport capture checks, scope hydration, and invalidation handling across server-backed queue surfaces.

## [1.16.37] - 2026-07-20

- **Mobile tool diffs:** support multiple tool patches in the mobile diff navigator, adjusting `PendingMobileChangesDiff` to handle arrays of patches and updating the UI to display the complete tool-patch set.
- **Diff patch utilities:** extract shared patch-path extraction and multi-patch resolution into `diffPatchUtils`, with coverage for multi-file edits and `apply_patch` tool calls.
- **Global search placement:** add the global-search button alongside session-title controls on mobile and desktop, maintaining a consistent title-bar layout across surfaces.
- **Session revision data:** align context-panel and diff-view presentation with the authoritative session snapshot to keep show-revision and navigation state consistent.
- **Test coverage:** extend tool navigation, patch handling, session-UI store, and diff-view test suites for the multi-patch and revision-resolution paths.

## [1.16.36] - 2026-07-20

- **Queued model routing:** resolve each session's selected agent, provider, model, and variant when admitting queued messages, then preserve that captured configuration through manual and automatic delivery.
- **Queue consistency:** share one send-configuration resolver across server-backed admission, legacy queue admission, and queued auto-send fallback paths.
- **Message history:** load older conversation history in consistent 30-message pages across desktop, VS Code, Web, and mobile surfaces.
- **Dispatch contract coverage:** verify that queued OpenCode prompts forward the exact model, agent, variant, message identity, directory, and parts payload.

## [1.16.35] - 2026-07-20

- **Mac queue dispatch:** separate durable OpenChamber runtime identity from the upstream OpenCode endpoint so queued messages continue automatically after the active turn completes.
- **Queue delivery confirmation:** retain asynchronously accepted prompts in reconciliation until an exact message event or authoritative lookup confirms delivery, preventing premature queue removal and missing chat messages.
- **Queued attachments:** allow the scoped upload token and SHA-256 headers through packaged-client CORS preflight so local attachments can enter the server-backed queue.
- **Session and mention recovery:** resolve exact session references across directories and keep file-mention delivery aligned with the owning runtime and session.
- **Desktop lifecycle:** force-close remaining local HTTP connections during shutdown so app replacement and relaunch complete cleanly.
- **Navigation and Git:** refine command-palette placement and project results, and show the total pending commit count on Git sync actions.

## [1.16.34] - 2026-07-20

- **Queued-message delivery:** make manual queue sends bypass busy-session settlement checks while retaining availability and durable dispatch fencing.
- **Queue reliability:** preserve manual dispatch intent across retries, wait for OpenCode readiness with the correct adapter contract, and generate OpenCode-compatible ascending message IDs so sent items appear in the current chat order.
- **Session recovery:** materialize exact sessions and messages from their owning directory when bounded bootstrap data omits the active session, restoring Send and Queue actions across older and cross-directory sessions.
- **Session deletion:** keep deleted sessions hidden throughout the undo window and reconcile authoritative session lists without resurrecting pending deletions.
- **Navigation surfaces:** improve command palette, sidebar top bar, and context-panel session behavior with consistent retained-session state and responsive dialog presentation.

## [1.16.33] - 2026-07-20

- **Server-backed message queue:** add durable SQLite-backed queued messages with per-session ordering, concurrent delivery across sessions, retries, idempotent dispatch, restart recovery, and automatic migration from existing client queues.
- **Queued attachments:** persist queued-message attachments on the server with filename and MIME metadata, upload limits, secure storage, cleanup, and delivery recovery.
- **Queue synchronization:** synchronize queue edits, deletion, reordering, delivery state, and worktree lifecycle across Web, Electron, VS Code, hosted mobile, and Capacitor mobile clients.
- **Worktree topology:** persist custom worktree ordering, reconcile created and deleted worktrees with queued-message state, and restore known worktree directories during startup recovery.
- **Tool diff navigation:** open the exact file patch from `edit`, `multiedit`, and `apply_patch` tool calls across desktop, Web, and mobile diff surfaces.
- **Session streaming reliability:** improve SSE and WebSocket response timeouts, heartbeat tracking, empty-chunk handling, reconnect behavior, and recovery for busy sessions whose content stream has stalled.
- **Session reconciliation:** refresh stale message metadata from authoritative snapshots while preserving earlier local history and actively streaming message parts.
- **Desktop lifecycle:** gracefully stop the embedded OpenChamber server during Electron quit, restart, and update installation.

## [1.16.32] - 2026-07-19

- **Responsive Web sessions:** add 500ms long-press action sheets for project, worktree, and session rows in the mobile Web sessions panel, with project sync and creation actions, worktree creation and confirmed deletion, plus session pin, share, and archive actions.
- **Touch selection:** cancel holds during scrolling or pointer cancellation, consume the generated click, suppress native touch callouts, and continuously clear browser text selection while an action sheet is open so session titles no longer retain a blue selection highlight.
- **Mobile interaction ownership:** move the shared long-press controller into the UI primitives layer so dedicated mobile and responsive Web surfaces use the same gesture thresholds and cleanup behavior.
- **Subagent banner:** keep agent and model on one row on narrow screens, and use a smaller shared type size for the read-only prompt message and metadata.

## [1.16.31] - 2026-07-19

- **Composer IME:** keep native composition ownership over textarea value, selection, and atomic-reference correction until `compositionend`, preventing iOS marked text from becoming a native blue selection.
- **Session identity:** show the subagent read-only prompt banner only after the current directory confirms a session `parentID`; keep loading, missing, root, cached cross-directory, and generic read-only states free from false subagent banners.
- **Context transcripts:** derive read-only subagent presentation from the directory-scoped authoritative session entity in retained context-panel transcripts.
- **Mobile sessions:** clear pending long-press timers and click suppression when the sessions sheet unmounts, with coverage for quick taps, movement cancellation, reset, and context-menu closure.
- **iOS dependencies:** refresh the locked GoogleUtilities pods from 8.1.1 to 8.1.2.

## [1.16.30] - 2026-07-19

- **Mobile chat:** preserve mobile worktree, project filter, and expanded group state across session-sheet refreshes; improve parent-session navigation and read-only prompt behavior.
- **Composer document:** add strict durable-document parser with serialization, equality validation, resource descriptions, and queue-canonical representation for v3/v4 message queues.
- **Composer mentions:** confirm authored file/agent mentions through the entire queue pipeline — admission, payload dispatch, ledger serialization, v3 migration, draft edit bridge, and attachment coordinator — with UTF-16 boundary validation and strict range enforcement.
- **Chat composer:** integrate confirmed file/agent mention passing from input to queued message creation; add send-plan and delivery modules for steerable queue dispatch.
- **Composer input:** preserve IME and native dictation edits when textarea reconciliation keeps the browser value and selection unchanged; apply text correction only when Session or Paste reference ranges cross the browser edit boundary.
- **Prompt availability:** separate read-only prompt guidance from submission blocking with shared availability rules and focused coverage.
- **UI event handling:** migrate cross-surface callbacks to stable `useEvent` handlers across mobile, multirun, session dialogs, integrations, and theme synchronization.
- **Composer highlighting:** render image-aware inline attachment icons and keep highlighted reference ranges aligned with composer edits.
- **Mobile session actions:** add long-press project, worktree, and session action surfaces with movement cancellation, click suppression, rename, pin, share, archive, delete, and clipboard flows.
- **PermissionCard:** refactor with structured metadata views via JsonSummaryView, i18n labels for Replace All, response format, Allow Once, and Always Agree; normalize metadata keys for consistent field display.
- **i18n:** add permission-card locale entries across all 11 supported languages.
- **Session reliability:** preserve session view state, reconcile stale directories from the authoritative index, and replay turn-diff navigation when context tabs reopen.
- **Queue reconciliation:** improve queue reconciliation, scope queued-message abort blocking to runtime and directory, and add reconciliation test coverage for ambiguous-dispatch edge cases.
- **Sidebar and navigation:** refine session navigation model with worktree state carry-over, improve session group section pinned-session handling, and add navigation model tests.
- **Unicode and metrics:** add unicodeMetrics utility with UTF-16 surrogate-pair boundary detection and text character-width analysis.
- **Foundation:** add session-prefetch cache, current-session entity hydration, sync store refinements, and planned infrastructure for streaming input-store integration.
- **Electron and developer tooling:** remove developer-only help log from queue worker, prune surplus Electron README note, and add composer delivery benchmarks.

## [1.16.29] - 2026-07-19

- **Mobile chat:** add session mentions with autocomplete, bounded conversation context injection, and persistent large-paste references with expansion, highlighting, and deletion controls.
- **Diff review:** add direct file and turn diff surfaces across mobile sheets, iPad panels, and context panels, with changed-line navigation and improved patch metadata handling.
- **Scheduled tasks:** add project-scoped daily, weekly, one-time, and cron scheduling with timezone support, model and agent selection, manual runs, status events, concurrency limits, retries, and partial-failure isolation.
- **Scheduled-task automation:** add the `scheduled_task` OpenCode tool with permission prompts, managed capability bridging, authoritative session validation, and persisted task mutations.
- **OpenCode startup:** improve managed and external process ownership, HMR recovery, capability identity rotation, failed-child cleanup, onboarding availability polling, and manual startup retry.
- **Model selection:** add a reusable mobile model picker with provider and model search, favorites, recents, metadata, variants, filtering, and shared support across chat, agents, and scheduled tasks.
- **Chat and session reliability:** scope queued-message abort blocking to runtime and directory, improve queue reconciliation, preserve session view state, and replay turn-diff navigation when context tabs reopen.

## [1.16.28] - 2026-07-18

- **Mobile projects:** connect the new-project action in the mobile draft project picker to the mobile directory explorer so users can create or add a project from the composer.
- **Mobile directory explorer:** consistently use the mobile overlay from mobile session surfaces and separate directory navigation from quick-add controls for reliable touch interaction.
- **Mobile composer:** align highlighted mirror text with textarea typography, spacing, wrapping, and line height so highlighted input and the caret stay synchronized across wrapped lines.

## [1.16.27] - 2026-07-18

- **Mobile sessions:** keep session-sheet presentation progress anchored to the initial touch so rightward opening, leftward cancellation, and renewed rightward opening follow the same distance while threshold haptics remain stable.

## [1.16.26] - 2026-07-18

- **Mobile sessions:** require clear reversal intent before cancelling a session-sheet presentation to reduce release-direction jitter.
- **Release integrity:** validate the complete artifact inventory through the draft Release ID so the final publication gate can inspect every asset before publishing the tag.

## [1.16.25] - 2026-07-18

- **Mobile sessions:** preserve the session window's rendered elements, scroll position, project filter, expanded worktree groups, and pagination state across presentations while continuing to refresh authoritative session data.

## [1.16.24] - 2026-07-18

- **Shared data layer:** migrate agents, commands, installed skills, MCP, GitHub authentication, plugins, skills catalogs, files, and plans to runtime-scoped TanStack Query caches with cancellation, retries, request sharing, bounded freshness, and stale-result protection.
- **Configuration isolation:** key configuration data by runtime transport and normalized directory, preserve complete snapshots across refresh failures, clear caches on runtime changes, and refresh only the affected scope after mutations.
- **Settings and stores:** make Query the owner of server-backed configuration state while stores retain selection, drafts, mutation progress, and diagnostics; update Settings search and configuration pages to consume the same authoritative snapshots.
- **Commands and skills:** batch agent and command metadata reads, resolve cold-cache slash commands before sending, and use the effective session, worktree, or draft directory consistently for composer highlighting, autocomplete, starter chips, skill links, and send-time command classification.
- **Plan editor:** add directory- and runtime-scoped plan resolution with explicit missing-file handling, per-document revisions, serial saves, pending-write flushes, retryable failures, stale-completion rejection, and cache updates after successful writes.
- **Diagram editor:** move diagram reads into the shared file cache, keep file switches isolated, update cached content after successful writes, and preserve the editor baseline when a save fails or returns an unsuccessful result.
- **Files and mobile:** unify directory listing, search, file content, and file status queries across shared and mobile surfaces; distinguish empty files from missing optional files and prevent older directory requests from replacing current results.
- **Mobile interaction:** add progressive previous/next session feedback while swiping across chat, signal the commit threshold with native haptics, and provide light haptic feedback for enabled button presses in Capacitor apps.
- **MCP and integrations:** unify MCP configuration and live status queries across Settings, dropdown, and mobile surfaces; scope connect, disconnect, OAuth, and configuration refreshes to their runtime and directory while surfacing status failures clearly.
- **Plugins, skills catalogs, and GitHub:** add shared authentication snapshots, resilient catalog pagination and deduplication, bounded source requests, registry normalization, and mutation-driven cache invalidation across Settings and picker dialogs.
- **Web and VS Code parity:** add batched configuration metadata routes, project-directory forwarding for agents, commands, skills, catalogs, and files, plus an optional-read contract across the Web server, VS Code bridge, and local filesystem proxy.
- **Routing and chat reliability:** keep valid session deep links stable after startup, reconcile stale session directories from the authoritative index, close text-selection menus synchronously during session switches, and refine composer leader-key hints.
- **Mobile windows:** add a shared motion and stacking system for top, bottom, left, and right overlays, with edge-aware dismissal, nested-scroll ownership, final-frame settlement, focus management, and near 1:1 touch tracking.
- **Mobile sessions:** group sessions by project root and worktree with branch labels, bounded expansion and remote pagination, add worktree creation, close the panel consistently after navigation, and reduce the header-swipe opening distance to 35% of the viewport.
- **Localization:** detect supported browser language preferences at startup, including regional Traditional Chinese and Portuguese variants, while preserving explicit locale selections.
- **Runtime compatibility:** generate WebView-compatible UUID v4 identifiers for drafts, queued messages, folders, plans, todos, remote instances, and connection metadata when the native random UUID API is unavailable.
- **Release integrity:** keep GitHub Releases in draft until the complete Desktop, Android, VSIX, blockmap, and update-manifest inventory passes validation, including a combined dual-architecture macOS update manifest.

## [1.16.23] - 2026-07-18

- **Git workspace:** streamline branch, sync, history, stash, stage, and revert controls with pinned headers and aligned actions across tree and flat change views.
- **Async workflows:** add runtime-scoped query caching, cancellation, pagination, stale-result protection, and cache resets across web, desktop, mobile, and VS Code surfaces.
- **Chat and navigation:** restore composer focus after model or agent selection, refine queued-message controls and terminal shortcuts, improve message forking, and remove citations when attachments are deleted.
- **Session reliability:** hide temporary SmartFetch secondary sessions from live and indexed session lists while preserving pagination and clearing existing summaries.
- **Files and integrations:** improve mobile file browsing, GitHub issue and pull request search, scheduled tasks, diagrams, PWA detection, server text-to-speech, provider state, and quota refresh behavior.

## [1.16.22] - 2026-07-17

- **Mobile composer:** tighten queued, reverted, and auto-review controls with smaller typography and denser spacing while preserving touch targets.
- **Mobile context:** replace the session metadata app icon with a live context-usage progress ring while preserving the existing metadata panel interaction.
- **Message actions:** show pending feedback and prevent duplicate revert or fork actions in message controls and the timeline.

## [1.16.21] - 2026-07-16

- **Sessions:** add undoable archive and delete actions with a recovery window, plus archived-session browsing and restore controls.
- **Sidebar:** refine pinned sessions, project pagination, archive/delete actions, and modifier shortcut hints across desktop and mobile.
- **Chat and queues:** improve queued-message delivery, attachment deduplication, draft presets, and session-title continuity.
- **Mermaid:** add smoother pan and zoom controls, source copying, and SVG download support.
- **Reliability:** reduce startup and background request storms, improve runtime recovery, and pause hidden or inactive polling work.

## [1.16.20] - 2026-07-16

- **Sidebar:** refine Mod+1…9 shortcut hints into compact inline chips that replace row actions while the modifier is held.

## [1.16.19] - 2026-07-16

- **Sessions:** add undoable archive and delete actions with a 10-second recovery window, plus an archived-session manager for browsing and restoring sessions.
- **Sidebar:** simplify pinned session rows, improve project pagination with Show more/Show fewer controls, and streamline archive/delete actions across desktop and mobile.
- **Queued messages:** improve delivery ordering, message ID generation, persistence flushing, retry handling, and reconciliation across runtime changes and directory-scoped sessions.
- **Chat composer:** prevent duplicate pasted images, deduplicate optimistic attachments, and add expandable attachment and draft-preset layouts.
- **Mermaid:** add smoother pan, wheel zoom, pinch zoom, copy-source, and SVG download controls.
- **Session titles:** improve topic continuity, language selection, fork-title refreshes, and protection for manually renamed sessions.
- **Files and workspace:** align folder icon treatments across mobile, sidebar, file, and changes views, and refine the web sidebar brand layout.
- **Localization:** add translated copy for archived sessions, undo actions, pagination, and related settings across supported languages.
- **Documentation:** refresh the project overview in English and Chinese with current product screenshots.

## [1.16.18] - 2026-07-16

- **Startup reliability:** remove the permission-control visibility probe that queried OpenCode during composer mount, preventing startup request storms when the managed server is still initializing.
- **Runtime requests:** coalesce health, upgrade-status, and other idempotent reads by runtime, transport, and credential generation, with short failure cooldowns for unavailable OpenCode instances.
- **Embedded chats:** pause hidden iframe initialization and background recovery work; keep upgrade checks on the primary app surface.
- **Files:** pause external-change polling for inactive editor tabs and avoid repeated hidden `fs/stat` traffic.
- **Desktop:** fix an Electron `Illegal invocation` crash caused by unbound native timer calls in the delayed upgrade check.

## [1.16.17] - 2026-07-16

- **Chat:** new session send now shows a full-screen establishing page immediately (like fork), instead of keeping the draft composer visible during combined create+prompt.
- **Fork:** cold-start fork no longer fails silently — source sessions are resolved from the global session index or `session.get` when the directory child store hasn't hydrated yet.
- **Keyboard:** first Esc now shows "Press Esc again to abort" in the status row; the abort prompt is visible on every layout including expanded input and desktop.
- **Keyboard:** `Ctrl+C` (customizable) clears the composer and any queued messages without interfering with text selection copy.
- **Compact:** `Ctrl+X C` compact command no longer fixes a `normalizeCandidatePath` unbound-method error.
- **Sessions:** workspace panels (right sidebar + context panel) now restore their per-session state when switching conversations.
- **Sessions:** improved sidebar session tree deduplication and pinned session handling.
- **Status bar:** moved changed files and pending changes into a unified popover, cleaning up the status row layout.

## [1.16.13] - 2026-07-16

- **Queued message delivery:** generate OpenCode-compatible `msg_` message identifiers, migrate queued legacy identifiers, and route terminal session events through their directory-scoped status stores so consecutive queued messages dispatch after the active response settles.

## [1.16.12] - 2026-07-15

- **Composer and queue reliability:** persist drafts and attachment blobs across restarts, migrate queued messages to a transport- and directory-scoped ledger, and reconcile queued sends safely after runtime changes.
- **Message editing and delivery:** preserve the original message when opening it for editing, replace a staged turn together with its later messages on confirmation, classify send failures precisely, and emit sent notifications only after server confirmation.
- **Attachments:** support large data-URL attachment payloads through OpenChamber session routes and coordinate attachment cleanup across drafts and queued messages.
- **Chat navigation and feedback:** open changed files at the selected diff line and provide deduplicated streaming haptics for assistant text, reasoning, and tool activity on mobile.
- **Session behavior:** refresh forked-session titles after their first completed exchange and improve cross-store session lookup and fork diagnostics.
- **Runtime compatibility:** ensure Node development servers rebuild `better-sqlite3` for the active Node ABI after Electron builds, avoiding native-module load failures.

## [1.16.11] - 2026-07-14

- **Release:** rebuild the current desktop, mobile, and VS Code artifacts from the `1.16.10` codebase.

## [1.16.10] - 2026-07-14

- **Session index:** persist live activity timestamps and session status, ingest realtime session events, and preserve ordering across refreshes and restarts.
- **Session loading:** improve cross-runtime session recovery, runtime endpoint resets, lazy chunk recovery, and Electron refresh diagnostics.
- **Reliability:** expand session-index, event-reducer, global-session, and sync regression coverage.

## [1.16.9] - 2026-07-14

- **AI summaries:** restrict Provider/model selection to callable summary models and clarify the behavior controlled by each prompt editor.
- **Custom API:** validate persisted custom OpenAI-compatible settings and cover save-to-call behavior without exposing API tokens.

## [1.16.8] - 2026-07-14

- **AI summaries:** add dedicated summary settings for provider, custom OpenAI-compatible models, credentials, and prompts for commit messages and session titles.
- **Sessions:** surface live cross-project activity in the sidebar and improve project navigation, ordering, and directory exploration.
- **Settings:** improve metadata, search, defaults, localization, and responsive settings layout across supported languages.
- **Editor:** expand file-extension language detection and cover the mapping with regression tests.

## [1.16.6] - 2026-07-14

- **AI summaries:** configure provider or custom OpenAI-compatible models, API credentials, and separate prompts for commit messages and session titles.
- **Global configuration:** discover and edit only configuration files available on the current runtime, including `.json` and `.jsonc` variants.
- **Projects:** the new-project directory dialog closes its source menu before opening, promotes Add Project to the primary footer action, and keeps already-added folders navigable so their child projects remain accessible.
- **Cross-runtime settings:** desktop and VS Code persist the current global configuration selection and refresh small-model configuration after changes.

## [1.16.5] - 2026-07-14

- **Session titles:** auto-refresh now keeps naming the overall feature/subject across follow-ups and wrap-up turns like commit/push, instead of retitling from the last housekeeping message.
- **Keyboard shortcuts:** the Ctrl+X leader chord no longer lets Chinese/Japanese IME composition leak letters into the composer.
- **Composer:** model/provider menus return focus to the chat input after Esc/Enter.

## [1.16.4] - 2026-07-14

- **Composer:** streamline the input toolbar and add the `/goal` system command. Active goals now use a compact, removable outline target state.

## [1.16.3] - 2026-07-14

- **Global configuration:** saving OpenCode, oh-my-opencode-slim, and oh-my-openagent raw configuration now parses the JSON request body correctly.

## [1.16.2] - 2026-07-14

- **Session recovery:** clients now reconcile stale running state after disconnects or OpenCode restarts without letting incomplete historical messages keep the composer loading.
- **Subagent recovery:** task cards stop their loading state when authoritative parent or child session status confirms interruption, while preserving the original tool history for diagnostics.
- **Status polling:** periodic reconciliation follows live busy or retry sessions only, reducing repeated status requests caused by historical incomplete messages.

## [1.16.1] - 2026-07-14

- **Performance:** large session sidebars stay responsive while chats stream, including setups with many projects, worktrees, and sessions. Opening a long chat after an empty or aborted agent turn also no longer repeatedly loads larger portions of its history.
- Chat: an optional Prompt Navigator adds a marker rail beside desktop chats; hover to preview prompts, click to jump between them, or assign a shortcut in Keyboard Shortcuts settings (thanks to @makeittech).
- Chat: shell-mode command cards now update their status and output while the command runs, with syntax highlighting for the command and output.
- Chat/Subagents: task cards now track the correct subagent when several run at once, preventing one subagent's activity or "Open subtask" action from pointing to another session.
- Chat/Subagents: "Open subtask" now works for nested subagents inside the side-panel chat, with a Parent action to return to the previous subagent (thanks to @ameshkov).
- Sessions: temporary project lookup failures no longer remove worktree groups from the sidebar.
- Small Model: custom OpenAI-compatible providers now use the base URL and API key from OpenCode configuration (thanks to @ameshkov).

## [1.16.0] - 2026-07-13

- **Session goals:** arm the new target button in the composer and your next prompt becomes a [goal](https://docs.openchamber.dev/session-goals/) — the session keeps working toward it on its own, with an independent small-model audit checking each finished turn, until the objective is verifiably complete, blocked, or over its optional token budget. The loop runs on the server, so it continues with the app closed and survives restarts. A goal strip above the composer shows progress with pause/resume; goals can also start from the plan-implement dialog, from scheduled tasks ("Run as goal"), or with the new "Craft a Goal" starter and `/craft-goal` command. While a goal runs, per-turn "ready" notifications are replaced by a single notification when it settles.
- **Usage:** OpenCode Go usage tracking is here, and Codex quota windows now show the correct reset times.
- **Remote access:** connecting over the relay got much faster — the app no longer waits for a stale local address to time out before trying the relay (previously up to ~20 seconds on a phone away from home). When your computer gets a new local IP, paired devices now learn the new address over the relay and quietly move back to the local network on their own — no re-pairing. The phone's launch screen shows which device it is connecting to.
- Remote access: running several OpenChamber instances on the same machine no longer makes paired devices land on a random one of them — only one process per machine serves the relay now. This was behind intermittent "Unable to reach server" errors on paired phones.
- Permissions: per-session auto-accept now lives on the server — sessions keep auto-accepting tool calls while the app is closed and after a server restart, subagent sessions inherit the setting, and it can be enabled on a draft before the first message (thanks to @bashrusakh for the draft fix).
- Chat: subagent sessions can now be prompted directly — open a subagent from the context panel and send it follow-up messages (off by default, available in settings).
- Chat: queued messages now send when the session is already idle instead of waiting forever in some cases, pending agent questions stay answerable after a server restart, and session renames no longer flicker back to the old title (thanks to @bashrusakh).
- Files: the file viewer has a markdown preview toggle (thanks to @greghaynes).
- Sidebar: projects can be sorted by different modes with a direction toggle, pinned sessions survive refreshes, and the file tree stays expanded while it refreshes (thanks to @bashrusakh).
- Command palette: projects are included in the fuzzy search alongside sessions and files (thanks to @bashrusakh).
- Settings: chat visual settings are grouped into labeled sections, and a new editor font size setting for the code editor (thanks to @bashrusakh).
- GitHub: PR and issue context now resolves against the source repository in fork workflows (thanks to @bashrusakh).
- Agents: saving agent settings from the UI no longer drops custom YAML frontmatter fields (thanks to @bashrusakh).
- Notifications: session errors and subagent completions now notify reliably across desktop, web, and mobile.
- Editor: "Open in" now recognizes VS Code Insiders.
- Windows: paths no longer mismatch on drive letter casing, which could split one project into duplicates (thanks to @bashrusakh).
- Mobile: the sessions sidebar opens instantly instead of taking many seconds on some devices (thanks to @tomzx).
- Mobile: renaming a saved instance no longer breaks its connection — the stored access token was getting lost on edit.
- Mobile: on Android 15 the app no longer draws under the status bar.
- Security: requests that spoof local host headers to look like same-machine traffic are rejected.
## [1.15.29] - 2026-07-13

- **Cross-device session sync:** preserve the event directory for remotely created sessions and surface global busy or retry activity in the session list before a directory store is subscribed.

## [1.15.28] - 2026-07-13

- **Mobile haptics:** mark a newly opened native app as foreground immediately so streaming and toast feedback work from the first launch after installation.

## [1.15.27] - 2026-07-13

- **Mobile haptics:** refresh visible streaming text every 20ms, provide matching light haptic feedback, and trigger the same feedback whenever an in-app toast appears.

## [1.15.26] - 2026-07-13

- **Command autocomplete:** pressing Enter on a skill only inserts it into the composer so arguments or context can be added first; system and OpenCode commands still run immediately.

## [1.15.25] - 2026-07-13

- **Per-agent model memory:** when OpenChamber settings do not override the default session model, new sessions and agent switches restore each agent's last user-selected model and variant instead of falling back to OpenCode defaults.

## [1.15.24] - 2026-07-13

- **Global configuration:** add a dedicated editor for OpenCode, oh-my-opencode-slim, and oh-my-openagent configuration, with safe save and restart flows across web, desktop, and VS Code runtimes.
- **Session and project navigation:** refine sidebar grouping, bulk actions, folder controls, session focus, project controls, and startup state for a faster, more consistent workspace experience.
- **Files, diffs, and comments:** improve change-list controls, file and diff navigation, inline-comment actions, and code-selection affordances.
- **Composer attachments:** render attachment citations consistently and remove their corresponding files whenever citation text is deleted with character, selection, or word deletion.
- **Visual polish:** refresh settings, controls, typography, keyboard hints, authentication, and mobile layout details across the application.

## [1.15.23] - 2026-07-13

- **Project icon styling:** use the project icon itself across chat, mobile, scheduled tasks, multi-run, project settings, and sidebar surfaces, with a cleaner shared visual treatment.
- **Session sidebar focus:** preserve keyboard focus after selecting a session row, remount rows correctly when they move between sidebar contexts, and select the full session title when rename begins.
- **macOS ARM64 app build:** produce a directly runnable Apple Silicon `OpenChamber.app` bundle for local desktop use.

## [1.15.22] - 2026-07-12

- **Sidebar pinned sessions:** replace the central "Activity" section with per-directory pinned sessions that persist across restarts, reducing session list noise and keeping important conversations visible.
- **Sidebar focus and navigation:** simplified focus reconciliation and numbered-navigation scoping let keyboard-driven session switching and numbered shortcuts share one recent/visible session row order.
- **Session-title express refresh:** set `requestedAt` on the session when in-browser generation starts so that reconnects don't retry the same request; the server routes explicit sidebar requests through the same generation flow without depending on the background throttle or the settings gate.
- **Mobile status bar:** session counter popover respects multi-run and file-review sessions.

## [1.15.21] - 2026-07-12

- **Tool row layout:** each tool and reasoning block use a stable flow-root wrapper with padding that works consistently in grouped and sequential tool rows, replacing fragile margin collapsing on mobile and desktop.
- **Smart-title reliability:** sidebar requests set a pending flag and persist errors to session metadata; the server immediately arms generation on explicit requests and clears transient state on failure.
- **Small-model introspection:** the settings picker verifies provider API availability before listing candidates, and `/api/small-model` returns an async provider list.
- **Router deeplink resilience:** deep-linked sessions wait for the global startup index; missing or unresolvable sessions redirect home after a timeout.
- **Assistant status i18n:** add full Polish, Portuguese, and Ukrainian translations for async status messages.

## [1.15.20] - 2026-07-12

- **Tool output styling:** align file and Git path labels with the shared secondary tool-description color across progressive and completed tool rows.

## [1.15.19] - 2026-07-12

- **Cross-runtime session startup:** Web, Electron, and mobile restore project session summaries from the shared SQLite index, while background synchronization stays bounded and session panels avoid redundant global history requests.
- **Session forks:** show a dedicated transition while OpenCode copies a conversation, suppress duplicate fork events, and open the fork from one bounded initial message page.
- **Mobile generation controls:** keep stop controls in the composer, simplify the status row, and preserve streaming haptics with the visible response lifecycle.
- **Authentication startup:** dismiss the initial loading layer when authentication or network recovery needs to present an interactive screen.

## [1.15.18] - 2026-07-12

- **Native haptics:** synchronize feedback with visible streaming updates. Thinking vibrates once when its UI first appears, while assistant text vibrates once per rendered text update; fixed-interval pulses are removed.
- **Mobile generation controls:** keep the stop action available inside the collapsed composer while the current response is running.

## [1.15.17] - 2026-07-12

- **Mobile message queue:** refine the queued-message card with tighter padding, smaller type and icons, denser rows, a shorter scroll region, and compact corners while preserving the established desktop layout.

## [1.15.16] - 2026-07-12

- **Mobile session picker:** consolidate phone session selection into the slide-up panel. The existing top-left folders button and session deep links open it, while a right swipe across more than half the conversation provides a gesture shortcut.
- **Mobile session navigation:** horizontal swipes switch conversations only when they begin on the collapsed or expanded composer; vertical gestures and conversation content retain their native scrolling and interaction behavior.
- **Mobile session status:** running conversations use the shared busy ring, unread conversations use the desktop information marker, and completed conversations no longer show an idle status dot.
- **Mobile generation controls:** the conversation status row exposes the shared stop action while generation is active, and Android back navigation returns from a child conversation to its parent.
- **Mobile input feedback:** streaming output drives continuous light native haptics, touch controls use immediate scale feedback, and the mobile keyboard Send key submits the composer while Shift+Enter inserts a line break.

## [1.15.15] - 2026-07-12

- **Mobile session navigation:** swipe across the conversation in any direction to move between newer and older sessions, and swipe right across the header to open the project and session list without relying on Android system-edge gestures.
- **Mobile session controls:** running sessions use the same server-backed busy state and spinning status ring as desktop; visible rows and collapsed project, worktree, or child-session groups can stop their active work directly.
- **Mobile touch feedback:** buttons and interactive rows respond immediately on touch-down, with disabled, nested, drag, and reduced-motion behavior handled consistently.
- **Native haptics:** Android and iOS clients provide a light, throttled haptic pulse while the visible conversation is streaming, and stop when the stream ends or the app moves to the background.
- **Message recovery:** failed sends and slash-command operations restore composer text, attachments, queued messages, synthetic parts, and inline drafts without overwriting content entered while the request was pending.

## [1.15.14] - 2026-07-12

- **Mobile new conversations:** parse JSON bodies for the OpenChamber create-with-first-prompt endpoint, restoring New Chat creation over direct and relay connections.
- **Task status:** simplify task rows, keep semantic list markup, and center the active task without moving keyboard focus when the status panel opens.

## [1.15.13] - 2026-07-12

- **New conversations:** normal first prompts are now orchestrated by the OpenChamber server, which creates the OpenCode session and admits the first message through one authenticated runtime operation.
- **Remote reliability:** relay disconnects no longer cancel in-flight conversation setup. Message-ID idempotency deduplicates reconnect retries and preserves partial create/prompt outcomes without duplicate sessions or messages.
- **Mobile feedback:** submitting a new conversation immediately shows an establishing state and locks duplicate input; failures restore the draft and message for retry.
- **Mobile sessions:** swiping left across chat content opens the Sessions sheet while edge session switching, vertical scrolling, controls, and horizontal code scrolling retain their gestures.
- **Mobile copy:** the Sessions sheet preserves the authored `New Chat` capitalization.
- **Cross-runtime parity:** Web, Electron, relay clients, and VS Code share the same create-with-prompt result contract, including explicit create, prompt, conflict, unavailable, and ambiguous-delivery recovery states.
- **Task status:** the expanded task list highlights and focuses the active task with clearer status, priority, progress, and scrolling behavior.

## [1.15.12] - 2026-07-12

- **CI:** enforce all-platform builds (desktop + Android + iOS) on every release tag.

## [1.15.11] - 2026-07-12

- **Release:** fix version bump and changelog to trigger desktop + Android build pipeline.

## [1.15.10] - 2026-07-12

- **Mobile i18n:** unify all mobile "new session" copy to "New Chat" across 10 locales.
- **Sidebar i18n:** capitalize section titles "recent" → "Recent", "projects" → "Projects", "syncing sessions" → "Syncing sessions…".

## [1.15.9] - 2026-07-12

- **Desktop updates:** macOS checks `yee94/openchamber` Releases directly, detects newer versions correctly, and opens the matching Release for manual installation instead of incorrectly reporting that the app is up to date.
- **Release links:** desktop, mobile, VS Code, install, documentation, and release workflow links now consistently target `yee94/openchamber`.
- **Release automation:** tag releases build macOS, Windows, Android, and VS Code artifacts without starting an iOS/TestFlight build. npm publishing is explicitly skipped when no npm credential is configured.

## [1.15.8] - 2026-07-12

- **Mobile (new layout):** overflow menu leads with New session; the composer-side `+` new-chat button is removed. Attach uses a paperclip icon, and the expanded composer top handle spacing is tighter.
- **Chat chrome:** mobile info/status chips align icon stroke and meta type with tool rows; assistant header badges use slightly tighter mobile type.

## [1.15.7] - 2026-07-12

- **Android updates:** the Capacitor client now checks `yee94/openchamber` GitHub Releases directly, reads the latest stable release version and notes, and uses the uploaded APK asset as its update download URL.

## [1.15.6] - 2026-07-12

- **Chat message actions:** clearer medium-stroke icons on send and reply (shared size), with a coordinated footer — actions and duration/time meta share color, grouped spacing, slightly smaller meta type, and left-aligned chrome on mobile.

## [1.15.5] - 2026-07-12

- **Session sidebar:** only sessions with verified SubAgent children show an expansion chevron. Electron persists child-session membership in its SQLite index, updates it immediately while a delegation is created or removed, and reconciles it in the background after launch without delaying the sidebar.
- **Markdown:** horizontal rules now use balanced spacing and a subtler theme-aware divider.

## [1.15.4] - 2026-07-11

- **Deep-link projects:** `openchamber://new-session?directory=…` now reuses the matching project or worktree, and registers an unmatched directory as a project before its first session is created. Sessions opened this way reliably appear in the project sidebar without duplicate project entries.

## [1.15.3] - 2026-07-11

- **Android release:** publish the signed Android APK and AAB alongside this release, so the mobile client is available from GitHub Releases.

## [1.15.2] - 2026-07-11

- **Session startup performance:** Electron restores each project's latest session summaries from its own SQLite index, then refreshes OpenCode incrementally instead of rebuilding the full sidebar on every launch.
- **Foreground responsiveness:** session-index work now runs as a single server-owned background job. Conversation content, children, and message mutations preempt it, so selecting a session no longer waits behind project-wide refreshes.
- **Startup experience:** a first run shows deterministic global loading progress; cached starts show the prior sidebar immediately and apply SQLite updates through a low-priority long poll.
- **Request reduction:** project lists are capped to the newest 20 root sessions, history uses cursor-driven "Show more" pagination, and session children load only when a user expands a parent session.
- **Reliability:** runtime-transition bursts, readiness races, stale async writes, repeated tray/sidebar refreshes, and duplicate session/message loads were consolidated or cancelled safely.
- **Session and chat rendering:** removed neighbor-session/history prefetch work that was not user initiated, tightened directory-level request deduplication, and preserved existing snapshots on transient failures.

## [1.15.1] - 2026-07-11

- **Desktop releases:** GitHub Releases and update metadata now publish from `yee94/openchamber`.
- **macOS packaging:** desktop artifacts use ad-hoc signing with no Apple Developer account or notarization requirement; macOS updates are installed manually, while Windows retains in-app automatic updates.
- **Release automation:** manual GitHub Actions releases can publish desktop artifacts without npm or mobile signing credentials, validate version consistency, and preserve dry-run releases as drafts.

## [1.15.0] - 2026-07-10

- **Remote access:** a new [private relay](https://docs.openchamber.dev/private-relay/) lets you reach your instance from anywhere — no open ports and no third-party tunnel, over an end-to-end-encrypted tunnel. It turns on by itself when you pair a device over it and turns off once no paired device uses it (thanks to @yulia-ivashko).
- **Mobile:** the native iOS and Android apps open for testing — join the [iOS public beta on TestFlight](https://testflight.apple.com/join/5ek6GU1E) or grab the Android APK from the [latest release](https://github.com/yee94/openchamber/releases/latest). Connect by scanning a QR code from "Add a device" on your server; the app then moves between your local network and the private relay on its own — leaving home carries the open session onto the relay and coming back returns it to Wi-Fi, no re-pairing. Saved instances show a live Connected status with the active transport, iPad gets a split layout with a persistent sessions sidebar and a resizable Changes/Files sidebar, and the app checks for OpenChamber updates itself (Android shows a download toast).
- **Pairing:** a redesigned ["Add a device"](https://docs.openchamber.dev/connect-devices/) dialog asks where you'll use the device — Anywhere (relay with local network preferred at home), Home network only, or This computer only — then shows a large scannable QR code with a copyable link, and closes itself once the device connects. Links are single-use expiring codes redeemed on connect instead of embedding a long-lived token in the QR (thanks to @yulia-ivashko).
- Devices: the "Connect to this server" list now shows each paired device with a live status — Connected · Local network or Relay — and a platform badge (iOS, Android, macOS, Windows, Linux). Re-pairing or re-entering the password on the same device updates its existing entry instead of adding a duplicate.
- Devices: a paired phone or desktop names the connection after the server's hostname; the name typed when creating the link labels the device in the server's list.
- Desktop: saved servers keep every transport their pairing link carried — the app connects directly on your network and falls back to the relay away from it, including when opening a server in a new window and when restoring the connection after a restart.
- Desktop: the header dropdown (instance / usage / MCP) was restyled with cards — usage grouped per provider, hosts showing a colored status line with ping and the active host highlighted, and MCP servers in one card. Host statuses persist between openings instead of flashing "Unknown", and switching to an already-checked host is immediate.
- Desktop: the servers list in Settings shows live per-server reachability, and importing a pairing link is the primary way to add a server.
- Desktop: Windows builds can launch at login and minimize to the system tray (thanks to @achcyano).
- Chat/Tools: every tool call now expands to show its input, result, and errors, including MCP, plugin, and custom tools; Read and Skill stay compact links to their files. JSON results open in a new navigable summary view with linked URLs and expandable nested data, alongside tree and raw JSON views.
- Chat/Tools: expanded file-edit and patch results now include per-file buttons to open the diff or jump to the first changed line in the file editor.
- Chat/Thinking: reasoning parts stay separate and in chronological order instead of merging into one block, and collapsed previews no longer show empty trailing HTML comments.
- Projects: each project can now set its own default model (thanks to @makeittech).
- Diff/Chat: added a Last turn mode to the Diff view, and latest-turn changed-file chips in chat now open that snapshot while older turn chips stay read-only.
- Chat: Mermaid diagrams now have zoom controls (thanks to @c-w-xiaohei).
- Chat: code blocks can show line numbers that stay aligned while streaming, and a new Wrap Code Block Lines setting (Settings → Chat) controls long-line wrapping.
- Chat: with Sticky User Header enabled, user messages no longer float over earlier messages in long conversations.
- Chat: if sending a message times out or loses the connection after OpenCode accepted it, the app now keeps the sent message instead of rolling it back as failed.
- Mobile: selecting local files from the composer now attaches the picked files even if the composer switches between compact and expanded layouts while the file picker is open.
- Browser: links clicked inside an embedded browser tab now keep the tab on the navigated page instead of remounting the frame.
- Context Panel: raw message rows now keep token and time columns aligned without showing shortened message IDs.
- UI: closing the right sidebar after resizing no longer leaves stale width constraints behind.
- Server: remote clients with non-ASCII project paths connect again (thanks to @FanFan4204).

## [1.14.1] - 2026-07-07

- Chat: finished agent replies can now show a short recap and a suggested next message, with separate settings for each and a Small Model setting for choosing the utility model used for those helpers.
- Notes/Todos: adding selected chat text to notes now uses the Small Model to summarize it automatically.
- Voice: read-aloud can now use the Small Model to summarize long text before speaking it.
- Git/GitHub: commit message and pull-request generation now use the Small Model from setting instead of sending message to chat.
- Chat: the timeline dialog can now load older messages when the current session history has not all been fetched yet.
- Chat: file references with line ranges like `src/file.ts:10-20` are now clickable in messages (thanks to @Catan).
- Git/Diff: opening a changed file now jumps to the first changed line instead of the start of the diff hunk.
- Mobile: the composer stays focused more reliably when the keyboard opens, and the dictation transcript grows the composer like typed text.
- Mobile: iOS PWA safe areas, keyboard overlays, and app-resume connection checks were tightened up.
- Desktop: password-protected instances opened from desktop or a browser no longer take the mobile-only unlock path.
- VSCode: favorite models now stay saved after restarting the extension (thanks to @Catan).
- VSCode: closing Settings returns to the previous extension view instead of always showing the sessions list (thanks to @Catan).

## [1.14.0] - 2026-07-05

- Voice: voice input was rebuilt around live streaming transcription — the composer mic shows a live transcript with a volume meter and timer while you speak, and a recording can be cancelled, inserted, or inserted and sent; failed transcriptions keep their audio so you can retry or accept the partial text.
- Voice: local speech-to-text works out of the box — models (Parakeet for English and 25 European languages, Whisper for a lighter multilingual option) download on demand from a new picker in Settings → Voice, or any OpenAI-compatible Whisper endpoint can be used instead; a configurable shortcut (mod+alt+v by default) toggles dictation.
- Voice: read-aloud can now use a local Kokoro voice (11 English voices), and long replies start speaking after roughly a sentence instead of waiting for the whole message.
- Voice: the Voice settings page was simplified — a single read-aloud toggle owns the playback options, and a new "Enable voice input" toggle hides the composer mic entirely.
- Mobile: the composer collapses into a compact input bar while the keyboard is closed, with a round new-session button beside it (hidden on the new-session screen); tapping the bar expands it and opens the keyboard, and the mic starts voice input straight from the compact bar.
- Mobile: the model and agent selectors moved into a row above the message text, the attachment menu and the new-session project/branch pickers open as bottom sheets with search, and a drag handle above the composer swipes it into a fullscreen editor — swiping down shrinks it back or dismisses the keyboard.
- Mobile: long conversations now load older history with a button at the top of the chat, which disappears once everything is loaded; loading older messages keeps your scroll position steady on all platforms.
- Mobile: the branch/worktree picker on the new-session screen lists all worktrees right after a cold start, and the GitHub connection status is recognized without re-running the connect flow.
- Mobile: opening the web app in a phone browser against a password-protected instance shows the password unlock page again (regressed in 1.13.9).
- Mobile: returning to the app no longer briefly flickers the session list.
- Mobile: continued polish ahead of the native app release — the chat and composer ride the keyboard in one smooth motion (including in long conversations), bottom sheets enter cleanly while the keyboard dismisses, the text cursor stays in place when the keyboard opens, starter suggestions on the new-session screen step aside while the keyboard is up, and switching instances no longer leaves the previous instance's sessions in the sessions list.
- UI: lists across the app were moved to one virtualization engine, so long lists scroll more consistently.
- Mobile: the slash-command, file/agent, skill, and snippet autocompletes were tuned for touch — they can grow up to the top of the chat area, the keyboard-hint footer and description lines are gone, row icons line up, list scrolling no longer bounces the page behind, and picking a command keeps the keyboard open.
- Mobile: in phone browsers the composer now keeps itself above the keyboard on the new-session screen and in the fullscreen editor, and opening the app shows the logo while it connects instead of flashing an unreachable-server error.
- Chat: the stop button now aborts sessions running in a different project or worktree than the currently open one — previously those aborts silently did nothing.
- Desktop: a local instance with a UI password and LAN access no longer gets stuck on "Auth required" and an unreachable-server screen (the app's client tokens are now reliably recognized as local, including for 0.0.0.0-bound servers).
- Desktop: the app prefers your own OpenCode install again — the bundled CLI is used only when no OpenCode is installed anywhere on the machine.
- Windows: OpenCode installed via npm now launches from paths with spaces (such as C:\Program Files\nodejs), binary paths pasted with surrounding quotes work, and discovery also checks the system-wide npm prefix and Scoop's shims — in the web/desktop app and the VS Code extension.

## [1.13.9] - 2026-07-02

- Mobile: added the native iOS and Android app projects ahead of the mobile app release, with continued polish for saved connections, password unlock, QR-code connection scanning, push notifications, iOS widgets, app resume, and native layout details.
- Desktop: the app can now use a bundled OpenCode CLI, or you can choose your own CLI path in settings.
- Desktop: added a Keep awake setting for the upcoming desktop app release to prevent the computer from sleeping while the app is running.
- Desktop: you can now specify optional custom headers when adding a remote OpenChamber instance to the desktop app, including for Cloudflare Access-style setups; settings and environment variables can still override them, and the bundled CLI can be replaced by setting a direct OpenCode CLI path.
- Desktop: SSH remote instances with a saved UI password now open directly after the tunnel connects instead of showing the unlock screen again.
- Chat: fixed edge cases where late-loading tool content, subagent content, or streaming Thinking blocks could pull the conversation away from the latest message or fight manual scrolling.
- Chat: embedded JSON examples in messages no longer render as generated-result cards.
- Sync: chat state now recovers after idle reconnects instead of leaving sessions stuck in a stale busy state.
- VSCode: clearing optional agent fields now removes them from agent config instead of saving `null` values.
- VSCode: the extension no longer picks OpenCode desktop app installs when looking for the standalone OpenCode CLI.

## [1.13.8] - 2026-06-29

- Startup: launching the app no longer hangs for around 20 seconds before you can open a session, load a diff, or send a message — GitHub pull request status checks no longer tie up the connection to the server during startup.
- OpenCode: when a separate OpenCode is already running (the TUI, `opencode serve`, or a daemon on the default port 4096), the app now starts its own server instead of attaching to it. This fixes the "OpenChamber could not finish initialization" error and stops the app from opening or closing your separate OpenCode when it starts and quits. Connecting to an external OpenCode now requires setting `OPENCODE_HOST`, `OPENCODE_PORT`, or `OPENCODE_SKIP_START`.
- Chat: a new Follow-up behavior setting (Settings → Chat) controls what happens when you press Enter on a message while the agent is still responding — Steer inserts it into the agent's current turn, or Queue holds it until the turn finishes. Replaces the previous queue-mode toggle (thanks to @bashrusakh).
- Sessions: deleting a worktree group from the sidebar, or permanently deleting an archived session that has subagent sessions, now removes those subagent sessions too instead of leaving them behind (thanks to @bashrusakh).
- Sessions: clicking a session inside a worktree group no longer briefly jumps the selection to the project's first session while the sidebar data catches up (thanks to @bashrusakh).
- Sync: a connected but quiet session (for example an agent running a long tool call) no longer triggers repeated background refreshes every ~15 seconds (thanks to @tomzx).

## [1.13.7] - 2026-06-28

- Chat: with tool calls (such as Bash and Edit) shown expanded by default, scrolling no longer twitches, and slow scrolling no longer jumps past several messages.
- Mobile: in long conversations, older messages now load before you reach the very top, and fast scrolling no longer leaves blank gaps where messages briefly disappear until you scroll back.
- Mobile: the model and agent buttons in the composer are now borderless and cleaner, show the provider logo next to the model name, and shorten long names with an ellipsis; in the model picker the thinking-variant control is plain text with a chevron and each row's controls line up.
- Mobile: interface labels (the model and agent selectors and other small labels) are back to their previous size after 1.13.6 shrank them too much.
- Providers: the Add provider form stays open while provider data refreshes or a model is picked in the background, instead of snapping back to an existing provider.
- CLI: `openchamber update` works again after a missing helper broke the command.

## [1.13.6] - 2026-06-28

- Chat: scrolling in conversations now stays steady while sending, queueing, streaming, switching sessions, and loading older messages.
- Chat: selecting a user-installed skill from the slash command menu now invokes the skill and injects its content, instead of inserting the skill name as plain text.
- Context Panel: chat tabs now use the session title and mark the open chat as seen while you are viewing it.
- Desktop/macOS: the Dock icon can now show a badge count for chats with unseen activity, with a new Appearance setting to turn it off.
- Context Panel: Browser and Preview tabs no longer accumulate duplicate auth tokens in their URLs after reloads or navigation.

## [1.13.5] - 2026-06-27

- CLI: global web installs no longer crash on startup when tunnel commands load ngrok capabilities.
- CLI: `openchamber update` works again, and tunnel start paths no longer fail when using managed-local config prompts, multi-instance port selection, or auto-started servers.
- GitHub/Usage: fork upstream detection and Google quota checks no longer fail because of missing server helpers.

## [1.13.4] - 2026-06-27

- UI/Localization: added Japanese interface translations and Japanese documentation (thanks to @yuchi0531).
- Chat: queued messages can now be reordered by dragging them in the queue (thanks to @makeittech).
- Chat: sending a message now closes an open question prompt instead of leaving stale question UI in the composer (thanks to @tomzx).
- Chat: conversations pinned to the bottom no longer jiggle or double-scroll after sending, and revisiting older sessions snaps to the latest message without a smooth-scroll delay.
- Reviews: the Review changes dialog can now run an automatic review loop, with a chat banner for opening or stopping the linked review sessions.
- Models: the model picker now remembers provider group expansion and custom ordering, and Shift+Delete removes a recent model from recents (thanks to @makeittech).
- Shortcuts: the model-selector shortcut can now be customized (thanks to @makeittech).
- Agents: agent edits against an external OpenCode server no longer show a saved-state update when the save did not succeed (thanks to @makeittech).
- Providers: the add-provider form no longer loses the selected provider during background provider refreshes (thanks to @IbrahimKhan12).
- Worktrees: messages sent to new worktree sessions now wait until the worktree session is ready instead of racing ahead (thanks to @bashrusakh).
- Git: commit and pull-request generation from a draft session now starts from the created chat session instead of a temporary draft (thanks to @bashrusakh).
- CLI: startup and status commands now check the live server port before treating an existing process as the active OpenChamber server.

## [1.13.3] - 2026-06-24

- Chat: selecting a user-installed skill from the slash command menu now invokes the skill instead of inserting the skill name as plain text (thanks to @IbrahimKhan12).
- Chat: pasted text containing `@` no longer opens file mention autocomplete unexpectedly (thanks to @charpeni).
- Chat: code blocks in user messages now preserve characters like `<` and `->` instead of escaping them inside the code block (thanks to @bashrusakh).
- Chat: switching sessions and loading older messages no longer causes the conversation to jump backward or oscillate around the current scroll position (thanks to @herjarsa).
- Chat: Arrow Up opens prompt history again when the cursor is at the start of the composer.
- Sessions: new sessions now stay attached to the selected project or current workspace directory instead of sometimes appearing under a stale project (thanks to @bashrusakh).
- Sessions: pinned sessions and folder rows no longer disappear from the sidebar after an empty session-list refresh (thanks to @bashrusakh).
- Agents: agent settings now include thinking variant, temperature, and top-p controls, and clearing temperature or top-p now removes the override (thanks to @bashrusakh).
- Settings/Models: per-model visibility and sibling model selections now stay saved after changes (thanks to @attilaszasz).
- Settings/Skills: the skills catalog refreshes after catalog settings change (thanks to @gokulkgm).
- Providers: disconnecting a provider from settings now works for the selected provider (thanks to @bashrusakh).
- Git: Git identities can now enable SSH commit signing.
- Git: pushing from the Git view now syncs first, reducing rejected pushes when the branch needs to update.
- Usage: MiniMax M3 and Token Plan usage now handle the provider's latest API response format (thanks to @baruchvitorino).
- VSCode: font size and padding preferences now apply inside the extension webview (thanks to @Sin991114).
- Startup: managed OpenCode server processes left behind by a previous crash are cleaned up on the next start.
- CLI: stale server PID files are checked more carefully so unrelated processes are not mistaken for an OpenChamber server.
- Files: downloads and file names with non-Latin characters now handle those characters correctly in headers (thanks to @FanFan4204).
- Mobile: subagent chevrons no longer overlap long session titles, and session grouping now matches the exact workspace directory (thanks to @weixiang1862, @lilyzhaun).

## [1.13.2] - 2026-06-18

- Chat/Performance: long conversations and large session lists now stay smooth and responsive while a response is streaming (thanks to @bashrusakh).
- Chat: the end of a streamed response is no longer occasionally cut off — messages now always settle on their complete text (thanks to @IbrahimKhan12).
- Chat: paragraphs in assistant messages now have proper spacing instead of collapsing into a single block (thanks to @foundryseven).
- Files: HTML, image, and PDF previews no longer cycle to "authentication required" every ~50 seconds (thanks to @bashrusakh).
- Startup: the app starts faster by no longer waiting on default OpenCode config, while your manual and per-directory model selections are preserved.

## [1.13.1] - 2026-06-17

- Chat: inline math delimiters no longer incorrectly treat currency amounts like `$50` as LaTeX math expressions — only `$$...$$` display math and `\(...\)` inline math are recognized.
- Chat: pinned welcome starters now appear immediately when a new draft session opens, without needing to open the add dialog.
- Chat: clicking a Mermaid diagram in a chat message now opens a fullscreen pan/zoom preview.
- Chat: code-block highlighting now runs off the main thread, preventing UI freezes when rendering code-heavy responses.
- Chat: the context usage indicator now shows as a circular progress ring with the same color thresholds, visible in all workspace headers.
- Chat/UI: embedded chat views and context panel previews now consistently match the current theme.
- Chat/Mobile: the session status button now responds more reliably to taps on Android.
- Scheduled Tasks: the task editor dialog now supports Cron expressions with inline validation, quick-example chips, and a preview of the next four upcoming runs (thanks to @tomzx).
- Files: syntax highlighting in the file editor, Plan View, and Skills page now uses Shiki for broader language support.
- Agents: deleting a built-in agent no longer creates a disable override — the agent stays as-is and shows a clear explanation instead of silently disappearing.
- Agents: deleting an agent now shows an error toast when the definition is missing, instead of failing silently.
- Startup: providers and agents now load faster by avoiding the full provider catalog on initial load.
- Right Sidebar: switching between sidebar tabs is less likely to re-render unrelated content (thanks to @bashrusakh).
- Sessions: the app no longer crashes on startup when there are many sessions in folders.
- Notifications: desktop notifications no longer show duplicate alerts, and reasoning text is excluded from notification bodies.
- Security: self-hosted instances now include noindex headers and a robots.txt to block search engine crawlers.
- CLI/Installer: the installer now requires Node.js 22 and handles version detection failures with clearer guidance.
- Reliability: session list loading handles Windows paths and concurrent requests more steadily, and duplicate health-check URLs are removed from diagnostics.

## [1.13.0] - 2026-06-15

- Security: LAN and remote browser access now require a UI password before the server will start.
- Desktop: if LAN access was enabled without a password, the app now starts locally and asks for a password before turning LAN access back on.
- Chat: file paths inside fenced code blocks are now clickable, including line and column targets (thanks to @robertoberto).
- Chat: context breakdowns now show message previews and cache hit rates (thanks to @robertoberto, @raz123).
- Chat/Performance: long conversations now use virtualized rendering to keep large histories responsive.
- Chat: custom-answer question textareas resize more steadily while typing (thanks to @bigcoder84).
- Chat/Input: tab-completing a mention no longer changes the selected agent (thanks to @Quat3rnion).
- Chat/Input: Arrow Up moves the cursor inside multi-line drafts again instead of always opening prompt history.
- Chat/Mobile: collapsed tool cards now keep their tool icon visible, and reasoning/tool text no longer clips descenders.
- Files: added dedicated PDF files previews mode.
- Files: added an optional docked files editor toolbar (thanks to @robertoberto).
- Files: file operations now use the active workspace directory more consistently (thanks to @tomzx).
- Sessions: session menus now include a delete action (thanks to @ShogunPanda).
- Sessions: deleting a parent session no longer brings deleted child sessions back into the sidebar (thanks to @panzeyu2013).
- Sessions: switching sessions no longer leaves the chat area blank in some cases (thanks to @panzeyu2013).
- Sessions: selected rows now highlight across the full sidebar gutter.
- Comments: inline file/diff comment drafts now stay in place when focus changes.
- Git/Diff: redesigned the Changes diff view with faster multi-file rendering, expandable hunk separators, a full-file loading toggle, compact responsive controls, and a unified changed/staged context panel workflow.
- Git/Diff: individual diff hunks can now be staged, unstaged, or discarded directly from the Changes view via `git apply`.
- Git/Diff: added a review flow for starting a review from current changes.
- GitHub: GitHub settings can now use credentials from the `gh` CLI when available (thanks to @tomzx).
- Settings/MCP: importing MCP snippets from OpenCode config works again (thanks to @youzini).
- Notifications: notification streams now stay connected more reliably behind proxies (thanks to @kostazol).
- Mobile: the empty Changes view keeps a close control visible (thanks to @lilyzhaun).
- Security: file previews and downloads now reject paths outside the allowed workspace unless access has been granted.
- Sessions: fixed a bug where a running session would briefly flicker as idle (in the sidebar, the send/stop button, and the status row) when the app is protected by a password.
- Desktop: you can now open developer tools from the Help menu.
- Sessions: new draft sessions now start from the default model and agent instead of inheriting the previous session's selection, and fall back to OpenCode's own `default_agent` (and its model) when no OpenChamber default is set.
- Startup: cached settings and session state now appear earlier while the live API finishes connecting.
- Startup: the model and agent now appear faster on the initial draft — config loads under the project key up front (no reload when the draft opens) and the agent list is fetched once instead of per consumer.
- VSCode: the extension opens faster with cached sessions, models, providers, and projects, then refreshes in the background.
- VSCode: sessions are now grouped under their workspace, with cleaner session rows and an archived-sessions toggle.

## [1.12.4] - 2026-06-11

- Chat: added `/handoff-review` to open a linked review session for the current workspace changes, with actions to send review feedback and implementation replies between the sessions.
- Chat/UI: added a setting to collapse long user messages.
- Chat: `@agent` mentions in rendered messages now use the primary accent color.
- Chat: table copy actions now include a Markdown format option (thanks to @kjhq).
- Chat: Mermaid diagrams can now be opened in a dedicated diagram editor (thanks to @nerdosaurus).
- Models: hidden models now stay hidden in multi-model selection controls (thanks to @kjhq).
- Worktrees: creating a single new worktree session now opens the session immediately while worktree setup continues in the background.
- Multi-Run: creating isolated runs now opens sessions immediately while worktree setup continues in the background.
- Sessions: chat folder assignments now stay in place after reloads.
- Sessions: session, folder, project, and worktree rows now have right-click menus for their available actions.
- Settings: added search across settings pages.
- Settings/Agents: agent prompt and permission edits now stay saved after changes.
- Files: added an editor Vim mode setting (thanks to @Champii).
- Files: writes are now safer when saving through temporary files (thanks to @nerdosaurus).
- Git: changed-file folders now have a revert action (thanks to @kostazol).
- GitHub: issue and pull-request pickers now use server-side search for larger repositories (thanks to @tomzx).
- Preview: inline module scripts are now rewritten in proxied HTML responses, fixing more Vite preview pages (thanks to @mdbetancourt).
- Voice: Plan and file preview markdown now include text-to-speech buttons, with a setting for reading selected text or the full document (thanks to @yangyaofei).
- Desktop/macOS: added a menu bar tray with live session status, Mini Chat access, and a provider usage submenu.
- Desktop/macOS: added an optional vibrancy effect for the left sidebar.
- Desktop/macOS: startup no longer opens unnecessary folder prompts.
- Mobile: refreshed session controls, worktree deletion flow, MCP controls, update flow, and usage tracking for new layout.
- Terminal/Mobile: touch scrolling in the terminal no longer conflicts with terminal input as often (thanks to @kostazol).
- Usage: added Cursor quota tracking.
- UI/Localization: added French interface translations and French documentation (thanks to @pascalandr).
- VSCode: added an action to archive all sessions from the extension (thanks to @jjdubski).
- VSCode: added multi-root workspace support, including workspace folder switching in the extension (thanks to @mmospanenko).

## [1.12.3] - 2026-06-05

- Windows/Startup: WSL OpenCode installs are no longer detected or launched; install OpenCode natively on Windows and configure `opencode.cmd` or `opencode.exe` instead.
- Startup: OpenCode health checks now work with OpenCode 1.15.x.
- Files: file trees now show directory loading errors with a retry action instead of leaving the folder empty, and slow Git ignore checks no longer block directory listings indefinitely.

## [1.12.2] - 2026-06-05

- **Desktop/Windows: the Windows app is now available publicly, with full functionality parity across the app.**
- Tunnels: switching between Cloudflare and ngrok quick tunnels now replaces the active quick tunnel instead of reusing the previous provider.
- Tunnels: ngrok startup failures now show the ngrok or authtoken error returned during startup.
- Projects: the Add Project directory picker now starts with hidden files off each time it opens.
- Chat: prompts sent while creating or switching target sessions now stay attached to the intended project directory.
- VSCode: the extension now detects more Windows OpenCode installs from PATH, npm, Scoop, and Chocolatey.

## [1.12.1] - 2026-06-03

- Chat: completed turns can now show changed-file chips with per-file additions and deletions, controlled by a new Chat setting.
- Chat: LSP tool calls now show the operation, file, and cursor position more clearly, and JSON tool output can be toggled between formatted and raw views or copied.
- Chat: streaming messages now appear correctly after startup, and activity/status rows show for the active session.
- Chat: completed responses no longer lose late-arriving summaries, token counts, errors, structured output, or changed-file details.
- Chat: question cards now show an error or no-longer-pending message when submit or dismiss fails instead of silently doing nothing.
- Chat: the first prompt in a new session no longer gets stuck before sending.
- Chat/UI: sticky user-message headers are now off by default.
- Sessions: session titles update from live session events, and the app now consistently loads all existing OpenCode sessions.
- Sessions: recent sessions now stay visible inside project groups, and new or worktree sessions stay in the correct project/worktree group on desktop, mobile, and VS Code.
- Settings/OpenCode: OpenCode CLI path, update-notification preference, keyboard shortcuts, and protected-session settings now stay saved after changes.
- UI/Time: the 12-hour/24-hour time preference now applies to chat timestamps, usage reset times, scheduled tasks, tunnels, passkeys, Git history, and pull-request dates.
- Settings/Files: the default file preview setting now lives with the Chat appearance settings and applies immediately to open file tabs.
- Preview: embedded previews now rewrite inline module imports, fixing Vite React preview pages that load root-relative modules.
- Desktop: Desktop tunnels now serve the full app UI instead of the headless page.
- Desktop: quitting the Desktop app now stops managed OpenCode processes more reliably, reducing leftover OpenCode processes after exit.
- Desktop: removed the legacy Tauri desktop path; Electron is now the only desktop runtime.

## [1.12.0] - 2026-06-03

- Mobile: added a new mobile UI as the default, with an option in Settings to switch back to the previous layout; this is the foundation for the upcoming mobile app and is available to try now.
- Chat: added customizable draft welcome starters from commands and skills, including guided commands for planning, catch-up, debugging, and exploration.
- Chat: assistant answers now have a dialog for starting a new session from that answer.
- Chat/Input: queued messages no longer auto-send before the active session is ready, and thinking-variant choices are preserved for generated messages.
- Chat/UI: markdown-rendered user messages now preserve line breaks.
- Web/Browser: added a Browser feature for opening websites in the web app and sharing annotations with screenshots to agents.
- Web/Remote Instances: added a headless web app mode, and remote instance switching now changes the OpenChamber API endpoint without loading the full remote UI.
- UI/Themes: added JetBrains Light and JetBrains Dark themes, and VS Code chat colors now map more closely to the active editor theme.

## [1.11.7] - 2026-05-27

- Git: commit history now includes a branch graph and commit-row actions in the history modal (thanks to @ermanhavuc).
- Desktop: added a launch-at-startup setting, and collapsed browser windows now keep their webview state.
- UI/Localization: added Traditional Chinese interface translations (thanks to @Jia35).
- Chat/Input: selecting an agent now switches to that agent's configured model, and malformed tool diffs no longer break chat rendering (thanks to @Adrian-Eckardt).
- Sessions: inline session renaming no longer exits immediately after focus changes (thanks to @youfch).
- Notes/Todos: completed todos stay at the end of the list, and the send-to-session dialog has a cleaner model picker (thanks to @kostazol, @rghamilton3).
- Usage: added a setting to hide prediction rows on usage cards (thanks to @ermanhavuc).
- VSCode: restored live streaming in the extension.

## [1.11.6] - 2026-05-25

- Settings/Plugins: added a Plugins page for managing opencode plugins, with npm update checks and user/project scopes (thanks to @Quat3rnion).
- Tunnels: added Ngrok as a quick tunnel provider in the CLI and Desktop tunnel settings, with readiness checks (requires Ngrok cli and auth).
- Desktop: added optional password setting in OpenChamber sessions settings for the local Desktop server.
- Multi-Run: new multi-run sessions now appear in the session list immediately, and slash-command prompts are sent to the created run sessions correctly.
- Mobile: restored the new-session action in the session sidebar header.

## [1.11.5] - 2026-05-25

- Chat/Input: pending image attachments now show previews, sent image attachments can be cited from assistant messages, and markdown source mode highlights formatting while you type.
- Chat: queued messages now send to the session they were queued from, even if you switch sessions before they are sent.
- Chat/UI: chats keep following the latest response after final task summaries, activity reasoning no longer flashes before settling, and assistant timestamps stay visible on narrow layouts.
- Sessions: session titles can now be renamed inline with a double-click (thanks to @robertoberto).
- Git: changed files are split into staged and unstaged sections, and Git operations work correctly from repository subdirectories (thanks to @ShogunPanda, @kostazol).
- Files: file search now shows the number of matches in the editor panel, and directory rows include a quick-add button (thanks to @attackonryan, @tomzx).
- Settings/Skills: installed skills are discovered more accurately, skill files opened from tool messages now load correctly, and snippet names keep their canonical casing (thanks to @jkker, @isanchez404).
- Mobile/PWA: long-press tooltips work on touch screens, fullscreen panels keep the right header state, deleted or long-named files behave better in file lists, and Android PWA dialogs stay visible (thanks to @kostazol, @lilyzhaun).
- Voice: OpenAI-compatible custom speech providers can now use API keys (thanks to @yangyaofei).

## [1.11.4] - 2026-05-22

- Desktop: Electron is now the desktop release target, with updated macOS menu actions for the right sidebar and terminal dock.
- Chat: added reusable snippets with `#` autocomplete in the composer and a Snippets settings page for global and project snippets with [opencode-snippets](https://github.com/JosXa/opencode-snippets) plugin compatibility.
- Multi-Run: runs can now be split into separate prompt/model groups, and Multi-Run prompts support command, file, agent, and snippet autocomplete (thanks to @tomzx).
- UI: refreshed the desktop workspace shell with a full-width header, framed chat area, and smooth left/right sidebar open and close states.
- Chat: completed reasoning blocks stay collapsed without replaying the collapse animation when you reopen a session.
- Files: file search and mention results avoid mixing entries from similar query/cache keys (thanks to @isanchez404).
- VSCode: switching between chat sessions is less likely to stall on very large conversations.
- Voice: preview audio now stops and cleans up correctly when you stop playback or leave Voice settings (thanks to @isanchez404).
- UI/Localization: refreshed Simplified Chinese terminology across the interface (thanks to @luojiyin).

## [1.11.3] - 2026-05-19

- Chat: question cards now include copy buttons for Markdown and JSON (thanks to @robertoberto).
- Chat: slash command autocomplete now includes skills and clearer command/type badges.
- Chat: slash, file, skill, and agent autocomplete selection now stays steadier when using the keyboard or mouse.
- Chat: external links in messages now show favicons with better contrast, and skill links render correctly in user message rendered as markdown.
- Chat: multi-file tool diffs now render safely, including files with mixed line endings.
- Sessions: archived session lists handle large archives better, and sub-session expansion is kept separate between Recent and project sections (thanks to @vhqtvn).
- Sessions: deleting or archiving a parent session now shows a descendant count that matches what will actually be removed (thanks to @vhqtvn).
- Git: reverting a chat message now refreshes the Git changes view afterward.
- Updates/PWA: OpenCode update and PWA install prompts can now be dismissed without reappearing repeatedly (thanks to @robertoberto).
- Notifications: browser and VS Code notifications work without duplicate alerts.
- Terminal/Mobile: the terminal viewport now stays above the mobile keyboard more consistently (thanks to @Dav1dch).
- Usage: added Wafer.ai quota tracking and removed the duplicate Zhipu usage provider entry (thanks to @bowber).

## [1.11.2] - 2026-05-18

- Chat: thinking blocks can now be collapsed, and expanding tool details feels smooth (thanks to @ermanhavuc).
- Chat: reverting or forking messages now keeps file attachments in place, with clearer undo/redo controls (thanks to @youfch, @ermanhavuc).
- Notes/Todos: context panel sizes are remembered, and todos can be reordered with drag and drop (thanks to @ermanhavuc).
- Git: commit history can now show file diffs inline (thanks to @ermanhavuc).
- Git: branch history works better for local-only branches, and branch search fields accept typing again (thanks to @ermanhavuc).
- Sessions: root project sessions now show up correctly in the session switcher (thanks to @isanchez404).
- Skills: installed skills now match OpenCode's own skill list more closely.

## [1.11.1] - 2026-05-15

- Multi-Run: added fusion for multi-run sessions.
- Multi-Run: added optional isolation and support for non-Git projects.
- Chat/Sessions: added a header session switcher with project, branch, diff, active, unread, and sub-session context.
- Chat/Subagents: opened subagent sessions read-only in the context panel and made subagent chats read-only.
- Chat/Shortcuts: made the agent-switching shortcut configurable and usable from the chat input/model picker.
- Desktop/Mini Chat: added session switching and the new-session shortcut to Mini Chat, while preserving user-selected sessions during startup.
- Preview: improved embedded preview proxying for absolute same-origin requests and WebSocket URLs, and avoided launching unrelated project actions when no dev-server action is detected.
- Updates/Usage: added a setting to disable OpenCode update notifications, and quota reset times now display in your local timezone.
- Chat/UI: sorted-mode tool paths animate consistently, and tooltip rendering is guarded defensively.
- Git: large change lists now display reliably, and branch selection stays hidden for non-Git draft sessions.
- Settings/Skills: the skills catalog now keeps the selected source label visible when switching sources (thanks to @kjhq).

## [1.11.0] - 2026-05-14

- Updates/OpenCode: added in-app OpenCode update checks and upgrade actions.
- Voice: added local Whisper speech-to-text.
- Voice: synced speech recognition settings across devices and let server transcription finish processing audio when voice input stops (thanks to @kostazol).
- Chat/Permissions: restored `@agent` mentions in sent messages and parent-session auto-accept for child-session permissions.
- Chat/Input: queued messages now auto-send one at a time in FIFO order, and model/agent selections persist across reloads (thanks to @lyxxx708, @chutastic).
- Chat/Performance: virtualized more timeline content, deferred heavy tool output, and improved scroll-to-bottom behavior.
- VSCode: improved chat sidebar command handoff, active-editor context updates, SSE cleanup, Agent Manager settings sync, and archived-session bulk delete reliability in the extension (thanks to @isanchez404, @jjdubski).
- Git: generalized repository provider handling beyond GitHub and made commit/PR generation more tolerant of JSON wrapped in assistant text.
- Terminal: rejected file paths as terminal working directories, preserved UTF-8 replay chunks, and cleaned up WebSocket/SSE listeners reliably during shutdown and reconnects (thanks to @isanchez404).
- Usage/Reliability: guarded quota percentages and reset timestamps defensively.
- UI/Reliability: added smaller fixes for chunk-load recovery, locale retry behavior, stale attachment reads, scheduled tasks, session folders, and accessible Git/session controls (thanks to @isanchez404).

## [1.10.4] - 2026-05-09

- Desktop/Mini Chat: improved Mini Chat session controls with current context usage in the compact header and a single header action that opens either the active session or current draft in Mini Chat.
- Chat/Input: model, variant, and agent labels collapse better on narrow widths.
- Git/Worktrees: pull-request worktrees can now reuse an existing local branch when it matches the PR head.
- Git: deduplicated lightweight and full status refreshes separately, preventing stale or mismatched Git updates during background polling (thanks to @isanchez404).
- Files: ignored stale file loads, guarded pending navigation, and stopped switching files when save fails.
- Terminal: cleaned up idle WebSocket connections and scoped SSE connection-open handling per retry attempt.
- Settings/UI: improved keyboard and screen-reader support for resizable Settings navigation and collapsible sidebar groups (thanks to @isanchez404).
- Reliability/Sync: preserved message part update ordering (thanks to @isanchez404).

## [1.10.3] - 2026-05-08

- Desktop/Electron: added Mini Chat windows for focused conversations without the full workspace shell, including session/draft handoff back to the main window, always-on-top pinning, and quick access from the header, session list, command palette, and keyboard shortcuts.
- Desktop/Startup: show the splash window earlier while the local runtime starts.
- Chat/Scrolling: rebuilt auto-follow behavior for active responses.
- Chat/Scrolling: saved scroll positions restore consistently after session switches, hydration, and draft-to-session transitions.
- Chat/UI: tightened scroll-to-bottom behavior and code-block scrolling handoff.
- Chat/Input: fixed attachment-only queued sends, stale attachment restores, stale file-search results, autocomplete tab handling, and focusable removal controls (thanks to @isanchez404).
- Reliability/Sync: reduced stale and duplicate live-state updates across request arrays, retry metadata, streaming indicators, and session status events, cutting unnecessary rerenders and stuck activity states during long-running chats (thanks to @isanchez404).
- Files/Skills: ignored stale directory refreshes and outdated skills catalog/repo scans.
- Git/Terminal/Desktop: fixed sandbox database loading in ESM, forwarded lightweight Git status mode across runtimes, preserved Electron SSH desktop hosts when saving instances, and made terminal UTF-8 locale fallbacks platform-aware (thanks to @isanchez404, @liyiopener).
- UI/Reliability: added smaller polish fixes for mobile Settings Escape handling, Multirun model limits, text-selection cleanup, and upstream event-stream cancellation (thanks to @isanchez404).

## [1.10.2] - 2026-05-07

- Projects: added repository cloning to the Add Project flow.
- Chat/Reliability: stabilized live turn rendering and session sync caches.
- Terminal: improved Android tablet keyboard handling, including control-key shortcuts, and kept app shortcuts from stealing focus while typing in the terminal (thanks to @Dav1dch).
- Terminal: set a UTF-8 locale for terminal sessions (thanks to @liyiopener).
- Usage: OpenRouter credit balances now avoid misleading percentage displays and use clearer labels across usage views (thanks to @zerone0x).
- Preview: improved embedded preview proxying with cleaner URL rewriting, fewer false-positive dev-server errors, steady navigation, and theme-aware preview frames.
- Notifications: suppressed inherited subagent completion notifications.
- VSCode: split the extension into a dedicated app root.

## [1.10.1] - 2026-05-06

- Git: added one-click Sync and stash management, including stash access from a clean worktree.
- Git: improved sync safety and feedback with latest remote refs, clearer progress banners, less flicker during refresh, cleaner header controls, and better unavailable pull-request states.
- UI/Localization: added Polish interface translations, expanding language support for Polish-speaking users (thanks to @levy52).
- Sessions: added a quick archive action directly on session rows (thanks to @zoubenr).
- Files: added a manual save mode to the file editor.
- Chat/Timeline: added full-text timeline search across user, assistant, and tool messages in a session.
- Chat/Reliability: pending questions now survive session switches and directory eviction.
- Mobile/Terminal: added an opt-in keyboard resize mode and steady touch terminal input.
- Terminal: restored focus back to terminal input after Ghostty element blur events.
- VSCode/Reliability: aligned session status parsing and reconnect reconciliation (thanks to @vhqtvn).
- Startup/Reliability: configured OpenCode CLI paths are now validated before managed startup, with clearer errors for missing, non-executable, or app-bundle paths.
- Performance/Reliability: reduced duplicate app initialization, deferred heavier views, lowered local server status overhead, optimized markdown file-link detection, reduced sync recovery payloads, and suppressed expected missing-directory noise.

## [1.10.0] - 2026-05-05

- Preview: added an embedded dev-server Preview pane for loopback apps, with authenticated proxying, Vite/HMR support, same-origin API request handling, and safer local dev-server shutdown (thanks to @wpbiggs).
- Preview: added preview console capture, DOM element inspection, annotation context, and Electron screenshot attachments.
- Projects/Terminal: added Auto-discover for local dev servers, background terminal startup, action-linked Preview reopen controls, and cleaner terminal tab styling (thanks to @wpbiggs).
- Settings/Behavior: added a dedicated Behavior page with global `AGENTS.md` configuration and response style presets.
- Chat/UI: added a wide layout option, steady scroll position across sessions and generated prompts, less flicker during streaming, and safer rendering for malformed message parts (thanks to @jwcrystal, @pasta-paul).
- VSCode/Chat: added the currently open editor file to chat context (thanks to @daveotero).
- UI/Settings: improved settings scrolling, empty states, and button/overlay polish (thanks to @Yabuku-xD).
- GitHub/Git: improved fork-aware issue and pull-request listing, PR status handling, startup loading feedback, remote MCP headers, and long model ID handling (thanks to @corrm, @ricautomation, @yart).
- Reliability/Streaming: reconnects now recover immediately after OS wake-from-sleep, long agent sessions avoid streaming hangs, concurrent sessions sharing the same provider are throttled more safely, and model metadata refreshes after OpenCode restarts (thanks to @jwcrystal, @pasta-paul, @Yabuku-xD).
- Onboarding/Updates/Mobile: added OpenCode CLI auto-detection during onboarding, cross-checks update prompts against npm, and improved iPad/tablet controls for fewer false update notices and smooth touch use (thanks to @IslamNofl).

## [1.9.10] - 2026-04-28

- UI/Localization: added Korean interface translations and default new installs back to English when no language has been chosen (thanks to @An-jinu).
- Chat/Models: unified the model picker across desktop and mobile with a cleaner selection flow (thanks to @daveotero).
- Projects: improved the project directory picker with expandable pinned folders and better file/path handling.
- Chat/UI: improved split-response action placement, error-message alignment, tab close affordances, and overscroll behavior.
- Sessions/Sidebar: fixed stale session, folder, project, and worktree state after mutations, and polished pinned-session indicators (thanks to @corrm, @Yabuku-xD).
- VSCode/Windows: normalized Windows drive-letter paths in extension webviews and added MiniMax/Ollama quota support.
- Reliability/Startup: hardened managed OpenCode startup, preserved shell PATH reliably, ignored stale downgrade update prompts, and improved stream/proxy recovery with heartbeat support.

## [1.9.9] - 2026-04-26

- UI/Localization: added a localization foundation with translated interface strings for Spanish, Brazilian Portuguese, Ukrainian, and Simplified Chinese.
- Settings/Appearance: added selectable interface and code fonts with 10 choices each.
- Chat/Workflow: added keyboard turn navigation, widened chat content, and introduced local workspace review and summarize slash commands.
- Chat/Mobile: improved mention and autocomplete behavior with complete results, clearer active-tab scoping, and less context-switching while drafting prompts.
- Chat/Tasks: todo list progress now updates live as task status changes, and task/model status hints are steady during active runs (thanks to @Yabuku-xD).
- Files/Editor: added an "Open files in preview mode" setting and improved multi-file edit/diff safety (thanks to @daveotero).
- Reliability/Performance: improved cold start and streaming responsiveness with lazy-loaded heavy components, chunk-load recovery, lower re-render churn, and safer reconnect/local-stream recovery (thanks to @Yabuku-xD, @jwcrystal, @vhqtvn).
- Desktop/Web/Mobile: improved Electron update restart behavior, PWA service-worker notifications, mobile keyboard handling, and the Add Project panel flow (thanks to @Jovines, @vhqtvn).

## [1.9.8] - 2026-04-22

- Sessions/Reliability: fixed parent-child session sync during reconnects and navigation (thanks to @jwcrystal).
- Settings/Sync: settings updates now sync reliably across clients, and sidebar session pagination is steady in larger workspaces.
- Sessions/Folders: folder changes now persist through server-backed endpoints.
- Notifications: permission notifications are now suppressed when auto-accept is enabled.
- Chat/Files: improved changed-files handling in chat and restored quick file-open flows from pending changes (thanks to @jwcrystal).
- UI: improved the bottom scroll shadow and hid the tasks row when there is no active work.
- Reliability/Desktop: improved live event-stream recovery after transient stalls, wait briefly before failing chat actions during reconnects, and persist Electron server logs for easier disconnect debugging.
- Desktop/macOS: System color mode now tracks OS theme changes, traffic-light controls stay visible after dock restore, and update restart/changelog handling is more reliable.
- Chat/Commands: added `/summary` slash command for a non-destructive session summary - optional topic hint after the command focuses the output, and the prompt is customizable under Settings: Magic Prompts.

## [1.9.7] - 2026-04-22

- Desktop: added an Electron desktop runtime in parallel with the current Tauri app, with Electron planned to become the default path in an upcoming release.
- Plans/Notes/Todos: added editable project plans from assistant messages, external plan upload, configurable planning magic prompts, and quicker note/todo handoff into new sessions or worktrees.
- Chat/Files: you can now drag files and folders from the file tree into chat, with improved `@folder` autocomplete (thanks to @youfch).
- Sessions/UI: added bulk session selection in the sidebar and fixed pinned sessions (thanks to @yart).
- Files/Git: added a file-change summary bar and auto-refresh for open files changed outside the app.
- Git/Worktrees: improved branch/worktree reliability by allowing checkout with uncommitted changes, tightening worktree cache invalidation, and reducing incorrect remote prefetches (thanks to @jwcrystal, @jasonalsing).
- Settings/MCP: improved MCP auth flow with better remote-config support and clearer diagnostics, and aligned config resolution with OpenCode behavior (thanks to @daveotero, @cyan).
- Reliability/Chat: hardened bootstrap and stream-connection recovery, preserved session/connect state, and reduced streaming UI churn.
- Web/PWA: added install orientation controls and fixed loopback-origin handling for web push notifications in local setups (thanks to @vhqtvn, @yart).

## [1.9.6] - 2026-04-17

- Reliability/Streaming: switched live message events to a WebSocket-first transport with SSE fallback, added response compression, and hardened proxy/compression handling (thanks to @geekifan, @jwcrystal).
- Sessions/Scheduled Tasks: added scheduled task creation and management with locale-aware scheduling.
- Sessions/Worktrees: enforced session worktree isolation and tightened session-switch safety.
- Files: added a full Go to Line workflow (toolbar + shortcut + dialog) and a new Copy Relative Path action (thanks to @coldbrow).
- Files: file trees now auto-refresh when files change outside the app (thanks to @jwcrystal).
- Chat/Export: added export session as Markdown and improved empty-state/export behavior (thanks to @coldbrow).
- Chat/Requests: restored blocking request visibility in sub-sessions, scoped auto-approve to the active session tree, and reduced noisy auto-approved notifications during multi-session work.
- Desktop: added quick open and a LAN access toggle, plus safer quit behavior around scheduled tasks (thanks to @An-jinu).
- Chat/Markdown: added LaTeX rendering support for clearer math and technical notation in messages (thanks to @ricautomation).
- Settings/Skills: skills are now sorted within groups (thanks to @tomzx).

## [1.9.5] - 2026-04-14

- Security/Auth: added passkey sign-in for protected instances and new 1-week/30-day session expiration options (thanks to @daveotero, @pm0u).
- Voice: added OpenAI-compatible custom server support for both text-to-speech and speech-to-text, including configurable TTS model/pitch/volume and stricter custom URL validation for safer setup (thanks to @ablepharus).
- Chat/Tool Output: added an interactive tree viewer for structured outputs and fixed JSON quote rendering (thanks to @yaozhenghangma).
- Chat/Reliability: fixed question-tool content disappearing after refresh and hardened subagent/session recovery paths.
- Sync/Performance: optimized multi-session streaming with per-directory queues, event coalescing, and parts-gap recovery to keep live updates smooth under heavy activity (thanks to @jwcrystal).
- Sessions/UI: kept active sessions visible in Recent, auto-expanded parent groups when opening subagent sessions, and hid empty archived/folder sections (thanks to @jwcrystal).
- Git/UI: restored Git changes panel visibility and sidebar sync (thanks to @jwcrystal).
- Desktop/Startup: delivered a more guided first-launch and smart recovery flow, plus startup and remote-window interaction fixes to reduce early-session friction (thanks to @jwcrystal).
- Usage: added Zhipu AI Coding Plan tracking and restored model-variant compatibility with older OpenCode runtimes (thanks to @cainiao1992, @Chi-square-test).

## [1.9.4] - 2026-04-07

- Settings/Magic Prompts: added a dedicated Magic Prompts page with editable templates for commit/PR generation, PR and issue reviews, failed-check/comment analysis, and merge/cherry-pick conflict resolution.
- Chat/Performance: reduced streaming render churn across the app.
- Chat/Scrolling: fixed jumpy follow behavior and restored stable bottom-resume/live-compaction updates.
- Reliability/Streaming: improved reconnect, retry, and directory-aware event routing to reduce stuck session/subagent states after transient disconnects (thanks to @jwcrystal, @daveotero).
- Chat/Tool Output: LSP diagnostics now render directly in tool output (thanks to @yulia-ivashko).
- Models: added defensive handling for missing model pricing/capability metadata (thanks to @Chi-square-test).
- Desktop/Performance: removed costly window translucency and reduced duplicate notification triggers for a cooler, less noisy desktop experience.
- Startup/Remote: restored remote provider startup behavior and tightened host/port detection to reduce false startup failures.
- Usage: refreshed MiniMax CN coding-plan quota data (thanks to @nzlov).

## [1.9.3] - 2026-03-01

- Security/Chat: user messages now escape raw HTML by default (thanks to @kalac2232).
- Desktop/Performance: reduced Tauri shell CPU/GPU overhead during longer sessions.
- Sessions/Drafts: draft chat config now stays synced with the selected draft target directory.
- VSCode/Files: added file stat support in the extension bridge (thanks to @geekifan).
- Chat/Models: added arrow-key navigation for thinking-mode selection in model controls (thanks to @daveotero).
- Files: added HTML preview support in the file viewer (thanks to @nguyenngothuong).
- Chat: improved error message readability with clearer styling and safer word-wrapping (thanks to @nguyenngothuong).
- Chat/JSON: added an interactive JSON tree viewer with collapse/expand controls and richer color cues for easier inspection of large structured outputs (thanks to @nguyenngothuong).
- Mobile/Settings: fixed lingering settings drawers and removed extra top spacing for a cleaner, less obstructed mobile layout (thanks to @Jovines).
- Git/Worktrees: fixed worktree detection and reset stale integration state when switching contexts.
- Desktop/Settings: window vibrancy now correctly controls macOS window transparency, and settings copy now clarifies when full transparency changes take effect.
- Reliability/Proxy: hardened OpenCode proxy header handling (including identity-encoding normalization, compression-header cleanup, hop-by-hop response-header stripping) and suppressed expected SSE close noise.
- Reliability/Proxy: restored proxied chat event streaming.
- Terminal/Reliability: switched terminal transport to a pure WebSocket path with fallback handling.
- Usage/Providers: added ZhipuAI quota tracking and fixed MiniMax coding-plan and GitHub Copilot overusage calculations (thanks to @kalac2232, @baruchvitorino, @ebrainte).

## [1.9.2] - 2026-03-31

- Chat/Performance: rebuilt live session sync and streaming updates to cut render churn, reduce CPU spikes, and keep long-running chats smooth and more stable across runtimes.
- Worktrees/Multi-Run: added instant draft-first worktree creation and redesigned the multi-run launcher with a cleaner, faster flow for parallel runs.
- VSCode/UI: polished the extension chat and sidebar with improved spacing, tooltips, a resizable sessions pane, and file-to-chat mention flows from Explorer.
- Models/Providers: improved custom provider model metadata loading and caching (thanks to @ZeppLu).
- CLI/Server: added `--foreground` for process-manager deployments, made managed server hostname configurable, and added an explicit `--host` option with safer localhost defaults (thanks to @colinmollenhour, @rapidrabbit76, @yulia-ivashko).
- Docker/Deployments: improved container defaults, including UID 1000 user behavior, non-fatal SSH key generation, and better localhost detection in container networking (thanks to @yulia-ivashko).
- Web/PWA: fixed manifest behavior behind Cloudflare Access (thanks to @arthurfiorette).

## [1.9.1] - 2026-03-20

- Sessions/UI: restored Project Notes access in the sidebar, polished notes/todo editing, and fixed project action overlap.
- Chat/GitHub: linked issues and pull requests now appear as user-message attachments and open reliably across runtimes.
- Settings/MCP: adding MCP servers now consistently respects user vs project scope, preventing user-scope entries from being written into project config files.
- VSCode/Reliability: managed server startup now imports login-shell environment values and normalizes Windows workspace paths.
- Sessions: sidebar lists now keep sessions visible in both Recent and Project sections for easier discovery (thanks to @nguyenngothuong).
- Files: file trees now refresh incrementally after create/rename/delete actions (thanks to @nguyenngothuong).
- Sessions/Worktrees: draft sessions now resolve the correct project when opened from worktree paths (thanks to @yulia-ivashko).
- Desktop: improved stale server-process cleanup on startup and fixed external link opening behavior (thanks to @jwcrystal).
- Usage: added MiniMax Weekly quota provider support (thanks to @nzlov).

## [1.9.0] - 2026-03-20

- UI/Navigation: delivered a major sidebar redesign with clearer hierarchy, unified action patterns, and improved session organization (thanks to @yulia-ivashko).
- Chat: reduced streaming CPU usage and background churn with steady turn rendering, debounced updates, and less storage thrash during long runs.
- Chat: fixed scroll-to-latest and timeline tracking behavior.
- Chat/Permissions: added a session-based permission auto-accept toggle and polished permission-shield visuals for quicker, clearer approval workflows.
- Git: refreshed history visuals and added clearer branch-boundary markers.
- Git: added remote removal from sync workflows and stabilized polling to reduce noisy background refreshes (thanks to @yulia-ivashko).
- Settings/UI: fixed settings scrolling on mobile, made outside-click closing immediate, and reduced settings load churn/CPU spikes.
- Panels/UI: softened panel resize affordances and tightened service dropdown/layout spacing for a cleaner, less distracting workspace.
- Files: added debounced editor auto-save (thanks to @nguyenngothuong).
- Files: reworked search UI for searching in files.
- Reliability/Platform: improved Windows path/process behavior and restored macOS PTY/microphone compatibility.
- Desktop/macOS: lowered the minimum supported macOS version to Ventura (13.0), expanding compatibility on older systems (thanks to @craigharman).
- Updates/Reliability: unified update-check behavior across runtimes.

## [1.8.7] - 2026-03-13

- CLI: fixed a startup regression in global npm/bun installs where wrapper or symlinked `openchamber` entrypoints could exit without output on commands like `--version` or `status`.
- CLI: hardened entrypoint detection across direct, symlinked, and shim-based launches to keep startup behavior consistent across package managers (thanks to @shekohex).
- Windows/Web: daemon startup and Git operations no longer flash extra console windows (thanks to @SergioChan).
- Deployment/Docker: improved `docker run` startup behavior and entrypoint handling (thanks to @nzlov).

## [1.8.6] - 2026-03-13

- Tunnel/CLI: rebuilt tunnel workflows around clearer managed modes and provider-aware lifecycle commands, with safer startup checks, improved diagnostics, and cleaner CLI output for everyday remote access (thanks to @yulia-ivashko).
- Chat: completed a turn-based rendering pipeline that keeps streaming, activity rows, and tool progress more stable in long runs, with smooth auto-follow and fewer jumpy updates.
- Chat/Settings: added richer chat render controls, including sorted/live behavior, compact live Activity previews, and options to keep Bash/Edit outputs open by default.
- Sessions/GitHub: overhauled sidebar session loading and GitHub PR tracking, and added a new minimal sidebar sessions mode on Desktop/Web.
- Sessions: worktrees with active sessions now surface earlier in the sidebar (thanks to @GhostFlying).
- Chat: fixed narrow-layout send behavior for modified Enter shortcuts (thanks to @eengad).
- Chat: fixed queue-button behavior and focus-mode composer sizing.
- Projects/Desktop: project action inputs now submit with Enter, and Desktop settings now include a spell-check toggle for writing comfort (thanks to @DocterZed).
- Mobile/PWA: install metadata now honors orientation lock consistently.

## [1.8.5] - 2026-03-04

- Desktop: startup now opens the app shell much earlier while background services continue loading.
- Desktop/macOS: fixed early title updates that could shift traffic-light window controls on startup.
- VSCode: edit-style tool results now open directly in a focused diff view.
- VSCode: cleaned up extension settings by removing duplicate display controls and hiding sections that do not apply in the editor environment.
- Chat: fixed focus-mode composer layout.
- UI/Theming: unified loading logos and startup screens across runtimes, with visuals that better match your active theme.
- Projects/UI: project icons now follow active theme foreground colors consistently.
- Reliability: improved early startup recovery.
- Tunnel/CLI: fixed one-time Cloudflare tunnel connect links in CLI output for `--try-cf-tunnel` (thanks to @plfavreau).
- Mobile/PWA: respected OS rotation lock by removing forced orientation behavior in the web app shell (thanks to @theluckystrike).

## [1.8.4] - 2026-03-04

- Chat: added clickable file-path links in assistant messages (including line targeting) (thanks to @yulia-ivashko).
- Chat: added a new `Changes` tool-output mode that expands edits/patches by default while keeping activity readable (thanks to @iamhenry).
- Chat: in-progress tools now appear immediately and stay live in collapsed activity view (thanks to @nelsonPires5).
- Chat: improved long user-message behavior in sticky mode with bounded height, internal scrolling, and cleaner action hit targets.
- Chat/Files: improved `@` file discovery and mention behavior with project-scoped search and more consistent matching.
- Chat/GitHub: added Attach menu actions to link GitHub issues and PRs directly in any session.
- Chat/Files: restored user image previews/fullscreen navigation and improved text-selection action placement on narrow layouts.
- Shortcuts/Models: added favorite-model cycling shortcuts (thanks to @iamhenry).
- Sessions: added active-project session search in the sidebar, with clearer match behavior and easier clearing during filtering (thanks to @KJdotIO).
- Worktrees/GitHub: streamlined worktree creation with a unified flow for branches, issues, and PR-linked sessions, including cleaner validation and faster branch loading.
- Worktrees/Git: fixed branch/PR source resolution (including slash-named branches and fork PR heads).
- Git: fixed a PR panel refresh loop that could trigger repeated updates and unstable behavior in the PR section (thanks to @yulia-ivashko).
- Files/Desktop: improved `Open In` actions from file views/editors, including app selection behavior and tighter integration for opening focused files (thanks to @yulia-ivashko).
- Mobile/Projects: added long-press project editing with a bottom-sheet panel and drag-to-reorder support (thanks to @Jovines).
- Web/PWA/Android: added improved install UX with pre-install naming and manifest shortcut updates (thanks to @shekohex).
- UI: interactive controls now consistently show pointer cursors.
- Security/Reliability: hardened terminal auth, tightened skill-file path protections, and reduced sensitive request logging exposure for safer day-to-day usage (thanks to @yulia-ivashko).

## [1.8.3] - 2026-03-02

- Chat: added user-message display controls for plain-text rendering and sticky headers.
- Chat/UI: overhauled the context panel with reusable tabs and embedded session chat (_beta_).
- Chat: improved code block presentation with cleaner action alignment, restored horizontal scrolling, and polished themed highlighting across chat messages and tool output (thanks to @nelsonPires5).
- Diff: added quick open-in-editor actions from diff views that jump to the first changed line.
- Git: refined Git sidebar tab behavior and spacing, plus bulk-revert with confirmations for easier cleanup.
- Git: fixed commit staging edge cases by filtering stale deleted paths before staging.
- Git/Worktrees: restored branch rename/edit controls in draft sessions when working in a worktree directory.
- Chat: model picker now supports collapsible provider groups and remembers expanded state between sessions.
- Settings: reorganized chat display settings into a more compact two-column layout.
- Mobile/UI: fixed session-title overflow in compact headers (thanks to @iamhenry).

## [1.8.2] - 2026-03-01

- Updates: hardened the self-update flow with safer release handling and fallback behavior.
- Chat: added a new "Share as image" action (thanks to @Jovines).
- Chat: improved message readability with cleaner tool/reasoning rendering and less noisy activity timing in busy conversations (thanks to @nelsonPires5).
- Desktop/Chat: permission toasts now include session context and a clearer permission preview (thanks to @nelsonPires5).
- VSCode: fixed live streaming edge cases for event endpoints with query/trailing-slash variants.
- Reliability: improved event-stream/session visibility handling when the app is hidden or restored.
- Windows: fixed CLI/runtime path and spawn edge cases to reduce startup and command failures on Windows (thanks to @plfavreau).
- Notifications/Voice: consolidated TTS and summarization service wiring for steady text-to-speech and summary flows (thanks to @nelsonPires5).
- Deployment: fixed Docker build/runtime issues (thanks to @nzlov).

## [1.8.1] - 2026-02-28

- Web/Auth: fixed an issue where non-tunnel browser sessions could incorrectly show a tunnel-only lock screen; normal auth flow now appears unless a tunnel is actually active.

## [1.8.0] - 2026-02-28

- Desktop: added SSH remote instance support with dedicated lifecycle and UX flows (thanks to @shekohex).
- Projects: added project icon customization with upload/remove and automatic favicon discovery from your repository (thanks to @shekohex).
- Projects: added header project actions on Web and Mobile.
- Projects/Desktop: project actions can also open SSH-forwarded URLs.
- Desktop: added dynamic window titles that reflect active project and remote context (thanks to @shekohex).
- Remote Tunnel: added tunnel settings with quick/named modes, secure one-time connect links (with QR), and saved named-tunnel presets/tokens (thanks to @yulia-ivashko).
- UI: expanded sprite-based file and folder icons across Files, Diff, and Git views (thanks to @shekohex).
- UI: added an expandable project rail with project names, a settings toggle, and saved expansion state for easier navigation in multi-project setups (thanks to @nguyenngothuong).
- UI/Files: added file-type icons across file lists, tabs, and diffs (thanks to @shekohex).
- Files: added a read-only highlighted view with a quick toggle back to edit mode (thanks to @shekohex).
- Files: markdown preview now handles frontmatter more cleanly.
- Chat: improved long-session performance with virtualized message rendering, smooth scrolling, and more stable behavior in large histories (thanks to @shekohex).
- Chat: enabled markdown rendering in user messages for clearer formatted prompts and notes (thanks to @haofeng0705).
- Chat: edit tools now use the same diff style as the dedicated Diff view (thanks to @shekohex).
- Chat: pasted absolute paths are now treated as normal messages.
- Chat: fixed queued sends for inactive sessions.
- Chat: upgraded Mermaid rendering with a cleaner diagram view plus quick copy/download actions (thanks to @shekohex).
- Notifications: improved child-session notification detection to reduce missed or misclassified subtask updates (thanks to @Jovines).
- Deployment: added Docker deployment support with safer container defaults and terminal shell fallback (thanks to @nzlov).
- Reliability: improved Windows compatibility across git status checks, OpenCode startup, path normalization, and session merge behavior (thanks to @mmereu).
- Usage: added MiniMax coding-plan quota provider support (thanks to @nzlov).
- Usage: added Ollama Cloud quota provider support (thanks to @iamhenry).

## [1.7.5] - 2026-02-25

- UI: moved projects into a dedicated sidebar rail and tightened the layout.
- Chat: fixed an issue where messages could occasionally duplicate or disappear during active conversations.
- Sessions: reduced session-switching overhead to make chat context changes feel more immediate.
- Reliability/Auth: migrated session auth storage to signed JWTs with a persistent secret.
- Mobile: pending permission prompts now recover after reconnect/resume instead of getting lost mid-run (thanks to @nelsonPires5).
- Mobile/Chat: refined message spacing and removed the top scroll shadow for a cleaner small-screen reading experience (thanks to @Jovines).
- Web: added `OPENCODE_HOST` support (thanks to @colinmollenhour).
- Web/Mobile: fixed in-app update flow in containerized setups.

## [1.7.4] - 2026-02-24

- Settings: redesigned the settings workspace with flatter, more consistent page layouts.
- Settings: improved agents and skills navigation by grouping entries by subfolder for easier management at scale (thanks to @nguyenngothuong).
- Chat: improved streaming smoothness and stability with buffered updates and runtime fixes.
- Chat: added fullscreen Mermaid preview, persisted default thinking variant selection, and hardened file-preview safety checks for a safer, more predictable message experience (thanks to @yulia-ivashko).
- Chat: draft text now persists per session, and the input supports an expanded focus mode for longer prompts (thanks to @nguyenngothuong).
- Sessions: expanded folder management with subfolders, cleaner organization actions, and clearer delete confirmations (thanks to @nguyenngothuong).
- Settings: added an MCP config manager UI to simplify editing and validating MCP server configuration (thanks to @nguyenngothuong).
- Git/PR: moved commit-message and PR-description generation to active-session structured output.
- Chat Activity: improved Structured Output tool rendering with dedicated title/icon, clearer result descriptions, and more reliable detailed expansion defaults.
- Notifications/Voice: moved utility model controls into AI Summarization as a Zen-only Summarization Model setting.
- Mobile: refreshed drawer and session-status layouts (thanks to @Jovines).
- Desktop: improved remote instance URL handling (thanks to @shekohex).
- Files: added C, C++, and Go language support for syntax-aware rendering in code-heavy workflows (thanks to @fomenks).

## [1.7.3] - 2026-02-21

- Settings: added customizable keyboard shortcuts for chat actions, panel toggles, and services (thanks to @nelsonPires5).
- Sessions: added custom folders to group chat sessions, with move/rename/delete flows and persisted collapse state per project (thanks to @nguyenngothuong).
- Notifications: improved agent progress notifications and permission handling to reduce noisy prompts during active runs (thanks to @nguyenngothuong).
- Diff/Plans/Files: restored GitHub-style inline comments (thanks to @nelsonPires5).
- Terminal: restored terminal text copy behavior (thanks to @shekohex).
- UI: unified clipboard copy behavior across Desktop app, Web app, and VS Code extension.
- Reliability: improved startup environment detection by capturing login-shell environment snapshots.
- Reliability: refactored OpenCode config/auth integration into domain modules for steady provider auth and command loading flows (thanks to @nelsonPires5).

## [1.7.2] - 2026-02-20

- Chat: question prompts now guide you to unanswered items before submit.
- Chat: fixed auto-send queue to wait for the active session to be idle before sending.
- Chat: improved streaming activity rendering and session attention indicators.
- UI: added Plan view in the context sidebar panel for quicker access to plan content while you work (thanks to @nelsonPires5).
- Settings: model variant options now refresh correctly in draft/new-session flows, avoiding stale selections.
- Reliability: provider auth failures now show clearer re-auth guidance when tokens expire (thanks to @yulia-ivashko).

## [1.7.1] - 2026-02-18

- Chat: slash commands now follow server command semantics (including multiline arguments).
- Chat: added a shell mode triggered by leading `!`, with inline output visibility/copy.
- Chat: improved delegated-task clarity with richer subtask bubbles, better task-detail rendering, and parent-chat surfacing for child permission/question requests.
- Chat: improved `@` mention autocomplete by prioritizing agents and cleaning up ordering.
- Skills: discovery now uses OpenCode API as the source of truth with safer fallback scanning.
- Skills: upgraded editing/install UX with better code editing, syntax-aware related files, and clearer location targeting across user/project .opencode and .agents scopes.
- Mobile: fixed accidental abort right after tapping Send on touch devices.
- Maintenance: removed deprecated GitHub Actions cloud runtime assets and docs to reduce setup confusion (thanks to @yulia-ivashko).

## [1.7.0] - 2026-02-17

- Chat: improved live streaming with part-delta updates and smarter auto-follow scrolling.
- Chat: Mermaid diagrams now render inline in assistant messages, with quick copy/download actions for easier sharing.
- UI: added a context overview panel with token usage, cost breakdown, and raw message inspection to make session debugging easier.
- Sessions: project icon and color customizations now persist reliably across restarts.
  **- Reliability: managed local OpenCode runtimes now use rotated secure auth and tighter lifecycle control across runtimes.**
- Git/GitHub: improved backend reliability for repository and auth operations (thanks to @nelsonPires5).

## [1.6.9] - 2026-02-16

- **UI: redesigned the workspace shell with a context panel, tabbed sidebars, and quicker navigation across chat, files, and reviews.**
- UI: compact model info in selection (price + capabilities) (thanks to @nelsonPires5).
- Chat: fixed file attachment issues and added exceeded-quota information.
- Diff: improved large diff rendering and interaction performance for smooth reviews on heavy changesets.
- Worktrees: shipped an upstream-first flow across supported runtimes (thanks to @yulia-ivashko).
- Git: improved pull request branch normalization and base/remote resolution to reduce PR setup mismatches (thanks to @gsxdsm).
- Sessions: added a persistent project notes and todos panel (thanks to @gsxdsm).
- Sessions: introduced the ability to pin sessions within your groups for easy access.
- Settings: added a configurable Zen model for commit messages generation and summarization of notifications (thanks to @gsxdsm).
- Usage: added NanoGPT quota support and hardened provider handling (thanks to @nelsonPires5).
- Reliability: startup now auto-detects and safely connects to an existing OpenCode server.
- Desktop: restored desktop window geometry and position (thanks to @yulia-ivashko).
- Mobile: fixes for small-screen editor, terminal, and layout overlap issues (thanks to @gsxdsm, @nelsonPires5).

## [1.6.8] - 2026-02-12

- Chat: added drag-and-drop attachments with inline image previews.
- Sessions: fixed a sidebar issue where draft input could carry over when switching projects.
- Chat: improved quick navigation from the sessions list by adding double-click to jump into chat and auto-focus the draft input; also fixed mobile session return behavior (thanks to @gsxdsm).
- Chat: improved agent/model picking with fuzzy search across names and descriptions.
- Usage: corrected Gemini and Antigravity quota source mapping and labels (thanks to @gsxdsm).
- Usage: when using remaining-quota mode, usage markers now invert direction to better match how remaining capacity is interpreted (thanks to @gsxdsm).
- Desktop: fixed project selection in opened remote instances.
- Desktop: fixed opened remote instances that use HTTP (helpful for instances under tunneling).

## [1.6.7] - 2026-02-10

- Voice: added built-in voice input and read-aloud responses with multiple providers (thanks to @gsxdsm).
- Git: added multi-remote push selection and smarter fork-aware pull request creation to reduce manual branch/remote setup (thanks to @gsxdsm).
- Usage: added usage pace and prediction indicators in the header and settings (thanks to @gsxdsm).
- Diff/Plans: fixed comment draft collisions and improved multi-line comment editing in plan and file workflows (thanks to @nelsonPires5).
- Notifications: stopped firing completion notifications for comment draft edits to reduce noisy alerts during review-heavy sessions (thanks to @nelsonPires5).
- Settings: added confirmation dialogs for destructive delete/reset actions to prevent accidental data loss.
- UI: refreshed header and settings layout, improved host switching, and upgraded the editor for smooth day-to-day navigation and editing.
- Desktop: added multi-window support with a dedicated "New Window" action for parallel work across projects (thanks to @yulia-ivashko).
- Reliability: fixed message loading edge cases, stabilized voice-mode persistence across restarts, and improved update flow behavior across platforms.

## [1.6.6] - 2026-02-9

- Desktop: redesigned the main workspace with a dedicated Git sidebar and bottom terminal dock.
- Desktop: added an `Open In` button to open the current workspace in Finder, Terminal, and supported editors with remembered app preference (thanks to @yulia-ivashko).
- Header: combined Instance, Usage, and MCP into one services menu.
- Git: added push/pull with remote selection, plus in-app rebase/merge flows with improved remote inference and clearer conflict handling (thanks to @gsxdsm).
- Git: reorganized the Git workspace with improved in-app PR workflows.
- Files: improved editing with breadcrumbs, better draft handling, smooth editor interactions, and more reliable directory navigation from file context (thanks to @nelsonPires5).
- Sessions: improved status behavior, faster mobile session switching with running/unread indicators, and clearer worktree labels when branch name differs (thanks to @Jovines, @gsxdsm).
- Notifications: added smarter templates with concise summaries (thanks to @gsxdsm).
- Usage: added per-model quota breakdowns with collapsible groups, and fixed provider dropdown scrolling (thanks to @nelsonPires5, @gsxdsm).
- Terminal: improved input responsiveness with a persistent low-latency transport for steady typing (thanks to @shekohex).
- Mobile: fixed chat input layout issues on small screens (thanks to @nelsonPires5).
- Reliability: fixed OpenCode auth pass-through and proxy env handling to reduce intermittent connection/auth issues (thanks to @gsxdsm).

## [1.6.5] - 2026-02-6

- Settings: added an OpenCode CLI path override.
- Chat: added arrow-key prompt history and an optional setting to persist input drafts between restarts (thanks to @gsxdsm).
- Chat: thinking/reasoning blocks now render consistently, and justification visibility settings now apply reliably (thanks to @gsxdsm).
- Diff/Plans: added inline comment drafts (thanks to @nelsonPires5).
- Sessions: you can now rename projects directly from the sidebar, and issue/PR pickers are easier to scan when starting from GitHub context (thanks to @shekohex, @gsxdsm).
- Worktrees: improved worktree flow reliability, including cleaner handling when a worktree was already removed outside the app (thanks to @gsxdsm).
- Terminal: improved Android keyboard behavior and removed distracting native caret blink in terminal inputs (thanks to @shekohex).
- UI: added Vitesse Dark and Vitesse Light theme presets.
- Reliability: improved OpenCode binary resolution and HOME-path handling across runtimes for steady local startup.

## [1.6.4] - 2026-02-5

- Desktop: switch between local and remote OpenChamber instances, plus a thinner runtime.
- VSCode: improved Windows PATH resolution and cold-start readiness checks to reduce "stuck loading" for sessions/models/agents.
- Mobile: split Agent/Model controls and a quick commands button with autocomplete (Commands/Agents/Files) for easier input (thanks to @Jovines, @gsxdsm).
- Chat: select text in messages to quickly add it to your prompt or start a new session (thanks to @gsxdsm).
- Diff/Plans: add inline comment drafts (thanks to @nelsonPires5).
- Terminal/Syntax: font size controls and Phoenix file extension support (thanks to @shekohex).
- Usage: expanded quota tracking with more providers (including GitHub Copilot) and a provider selector dropdown (thanks to @gsxdsm, @nelsonPires5).
- Git: improved macOS SSH agent support for smooth private-repo auth (thanks to @shekohex).
- Web: fixed missing icon when installing the Android PWA (thanks to @nelsonPires5).
- GitHub: PR description generation supports optional extra context (thanks to @nelsonPires5).

## [1.6.3] - 2026-02-2

- Web: improved server readiness check to use the `/global/health` endpoint.
- Web: added login rate limit protection to prevent brute-force attempts on the authentication endpoint (thanks to @Jovines).
- VSCode: improved server health check with the proper health API endpoint and increased timeout for steady startup (thanks to @wienans).
- Settings: dialog no longer persists open/closed state across app restarts.

## [1.6.2] - 2026-02-1

- Usage: new multi-provider quota dashboard to monitor API usage across OpenAI, Google, and z.ai (thanks to @nelsonPires5).
- Settings: now opens in a windowed dialog on desktop with backdrop blur.
- Terminal: added tabbed interface to manage multiple terminal sessions per directory.
- Files: added multi-file tabs on desktop and dropdown selector on mobile (thanks to @nelsonPires5).
- UI: introduced a token-based theming system, 18 themes with light/dark variants, and custom user themes from `~/.config/openchamber/themes`.
- Diff: optimized stacked view with worker-pool processing and lazy DOM rendering for smooth scrolling.
- Worktrees: workspace path now resolves correctly when using git worktrees (thanks to @nelsonPires5).
- Projects: fixed directory creation outside workspace in the Add Project modal (thanks to @nelsonPires5).

## [1.6.1] - 2026-01-30

- Chat: added Stop button to cancel generation mid-response.
- Mobile: revamped chat controls on small screens with a unified controls drawer (thanks to @nelsonPires5).
- UI: update dialog now includes the changelog.
- Terminal: added optional on-screen key bar (Esc/Ctrl/arrows/Enter) for easier terminal navigation.
- Notifications: added "Notify for subtasks" toggle to silence child-session notifications during multi-run (thanks to @Jovines).
- Reliability: improved event-stream reconnection when the app becomes visible again.
- Worktrees: starting new worktree sessions now defaults to HEAD when no start point is provided.
- Git: commit message generation now includes untracked files and handles `git diff --no-index` comparisons reliably (thanks to @MrLYC).
- Desktop: improved macOS window chrome and header spacing, including steady traffic lights on older macOS versions (thanks to @yulia-ivashko).

## [1.6.0] - 2026-01-29

- Chat: added message stall detection with automatic soft resync.
- Chat: fixed "Load older" button behavior in chat with proper pagination implementation.
- Git: PR picker now validates local branch existence and includes a refresh action.
- Git: worktree integration now syncs clean target directories before merging.
- Diff: fixed memory leak when viewing many modified files; large changesets now lazy-load for smooth performance.
- VSCode: session activity status now updates reliably even when the webview is hidden.
- Web: session activity tracking now works consistently across browser tabs.
- Reliability: plans directory no longer errors when missing.

## [1.5.9] - 2026-01-28

- Worktrees: migrated to the OpenCode SDK worktree implementation; sessions in worktrees are now completely isolated.
- Git: integrate worktree commits back to a target branch with commit previews and guided conflict handling.
- Files: toggle markdown preview when viewing files (thanks to @Jovines).
- Files: open the file viewer in fullscreen for focused review and editing (thanks to @TaylorBeeston).
- Plans: switch between markdown preview and edit mode in the Plan view.
- UI: Files, Diff, Git, and Terminal now follow the active session/worktree directory, including new-session drafts.
- Web: plan lists no longer error when the plans directory is missing.

## [1.5.8] - 2026-01-26

- Plans: new Plan/Build mode switching support with dedicated Plan content view with per-session context.
- GitHub: sign in with multiple accounts and smooth auth flow.
- Chat/UI: linkable mentions, better wrapping, and markdown/scroll polish in messages.
- Skills: ClawdHub catalog now pages results and retries transient failures.
- Diff: fixed Chrome scrolling in All Files layout.
- Mobile: improved layout for attachments, git, and permissions on small screens (thanks to @nelsonPires5).
- Web: iOS safe-area support for the PWA header.
- Activity: added a text-justification setting for activity summaries (thanks to @iyangdianfeng).
- Reliability: file lists and message sends handle missing directories and transient errors better.

## [1.5.7] - 2026-01-24

- GitHub: PR panel supports fork PR detection by branch name.
- GitHub: Git tab PR panel can send failed checks/comments to chat with hidden context; added check details dialog with Actions step breakdown.
- Web: GitHub auth flow fixes.

## [1.5.6] - 2026-01-24

- GitHub: connect your account in Settings with device-flow auth to enable GitHub tools.
- Sessions: start new sessions from GitHub issues with seeded context (title, body, labels, comments).
- Sessions: start new sessions from GitHub pull requests with PR context baked in (including diffs).
- Git: manage pull requests in the Git view with AI-generated descriptions, status checks, ready-for-review, and merge actions.
- Mobile: fixed CommandAutocomplete dropdown scrolling (thanks to @nelsonPires5).

## [1.5.5] - 2026-01-23

- Navigation: URLs now sync the active session, tab, settings, and diff state for shareable links and reliable back/forward (thanks to @TaylorBeeston).
- Settings: agent and command overrides now prefer plural directories while still honoring legacy singular folders.
- Skills: installs now target plural directories while still recognizing legacy singular folders.
- Web: push notifications no longer fire when a window is visible, avoiding duplicate alerts.
- Web: improved push subscription handling across multiple windows.

## [1.5.4] - 2026-01-22

- Chat: new Apply Patch tool UI with diff preview for patch-based edits.
- Files: refreshed attachment cards and related file views for clearer context.
- Settings: manage provider configuration files directly from the UI.
- UI: updated header and sidebar layout for a cleaner, tighter workspace fit (thanks to @TheRealAshik).
- Diff: large diffs now lazy-load to avoid freezes (thanks to @Jovines).
- Web: added Background notifications for PWA.
- Reliability: connect to external OpenCode servers without auto-start and fixed subagent crashes (thanks to @TaylorBeeston).

## [1.5.3] - 2026-01-20

- Files: edit files inline with syntax highlighting, draft protection, and save/discard flow.
- Files: toggles to show hidden/dotfiles and gitignored entries in file browsers and pickers (thanks to @syntext).
- Settings: new memory limits controls for session message history.
- Chat: smooth session switching with more stable scroll anchoring.
- Chat: new Activity view in collapsed state, now shows latest 6 tools by default.
- Chat: fixed message copy on Firefox for macOS (thanks to @syntext).
- Appearance: new corner radius control and restored input bar offset setting (thanks to @TheRealAshik).
- Git: generated commit messages now auto-pick a gitmoji when enabled (thanks to @TheRealAshik).
- Performance: faster filesystem/search operations and general stability improvements (thanks to @TheRealAshik).

## [1.5.2] - 2026-01-17

- Sessions: added branch picker dialog to start new worktree sessions from local branches (thanks to @nilskroe).
- Sessions: added project header worktree button, active-session loader, and right-click context menu in the sessions sidebar (thanks to @nilskroe).
- Sessions: improved worktree delete dialog with linked session details, dirty-change warnings, and optional remote branch removal.
- Git: added gitmoji picker in commit message composer with cached emoji list (thanks to @TaylorBeeston).
- Chat: optimized message loading for opening sessions.
- UI: added one-click diagnostics copy in the About dialog.
- VSCode: tuned layout breakpoint and server readiness timeout for steady startup.
- Reliability: improved OpenCode process cleanup to reduce orphaned servers.

## [1.5.1] - 2026-01-16

- Desktop: fixed orphaned OpenCode processes not being cleaned up on restart or exit.
- OpenCode: fixed a crash when reloading configuration.

## [1.5.0] - 2026-01-16

- UI: added a new Files tab to browse workspace files directly from the interface.
- Diff: enhanced the diff viewer with mobile support and the ability to ask the agent for comments on changes.
- Git Identities: added "default identity" setting with one-click set/unset and automatic local identity detection.
- VSCode: improved server management to ensure it initializes within the workspace directory with context-aware readiness checks.
- VSCode: added responsive layout with sessions sidebar + chat side-by-side when wide, compact header, and streamlined settings.
- Web/VSCode: fixed orphaned OpenCode processes not being cleaned up on restart or exit.
- Web: the server now automatically resolves and uses an available port if the default is occupied.
- Stability: fixed heartbeat race condition causing session stalls during long tasks (thanks to @tybradle).
- Desktop: fixed commands for worktree setup access to PATH.

## [1.4.9] - 2026-01-14

- VSCode: added session editor panel to view sessions alongside files.
- VSCode: improved server connection reliability with multiple URL candidate support.
- Diff: added stacked/inline diff mode toggle in settings with sidebar file navigation (thanks to @nelsonPires5).
- Mobile: fixed iOS keyboard safe area padding for home indicator bar (thanks to @Jovines).
- Upload: increased attachment size limit to 50MB with automatic image compression to 2048px for large files.

## [1.4.8] - 2026-01-14

- Git Identities: added token-based authentication support with ~/.git-credentials discovery and import.
- Settings: consolidated Git settings and added opencode zen model selection for commit generation (thanks to @nelsonPires5).
- Web Notifications: added configurable native web notifications for assistant completion (thanks to @vio1ator).
- Chat: sidebar sessions are now automatically sorted by last updated date (thanks to @vio1ator).
- Chat: fixed edit tool output and added turn duration.
- UI: todo lists and status indicators now hide automatically when all tasks are completed (thanks to @vio1ator).
- Reliability: improved project state preservation on validation failures (thanks to @vio1ator) and refined server health monitoring.
- Stability: added graceful shutdown handling for the server process (thanks to @vio1ator).

## [1.4.7] - 2026-01-10

- Skills: added ClawdHub integration as built-in market for skills.
- Web: fixed issues in terminal.

## [1.4.6] - 2026-01-09

- VSCode/Web: switched OpenCode CLI management to the SDK.
- Input: removed auto-complete and auto-correction.
- Shortcuts: switched the agent cycling shortcut from Shift+Tab back to Tab.
- Chat: added question tool support with a rich UI for interaction.

## [1.4.5] - 2026-01-08

- Chat: added support for model variants (thinking effort).
- Shortcuts: switched the agent cycling shortcut from Tab to Shift+Tab.
- Skills: added autocomplete for skills on "/" when it is not the first character in input.
- Autocomplete: added scope badges for commands/agents/skills.
- Compact: changed `/summarize` to `/compact` and moved compaction to the SDK.
- MCP: added the ability to dynamically enable or disable configured MCP servers.
- Web: refactored the Add Project UI with autocomplete.

## [1.4.4] - 2026-01-08

- Agent Manager / Multi Run: select agent per worktree session (thanks to @wienans).
- Agent Manager / Multi Run: worktree actions to delete group or individual worktrees, or keep only selected one (thanks to @wienans).
- Agent Manager: added "Copy Worktree Path" action in the more menu (thanks to @wienans).
- Worktrees: added session creation flow with loading screen, auto-create worktree setting, and setup commands management.
- Session sidebar: refactored the unified view for sessions in worktrees.
- Settings: added the ability to create new sessions in worktrees by default.
- Git view: added branch rename for worktree.
- Chat: fixed IME composition for CJK input to prevent accidental send (thanks to @madebyjun).
- Projects: added multi-project support with per-project settings for agents/commands/skills.
- Event stream: improved SSE with heartbeat management, permission bootstrap on connect, and reconnection logic.
- Tunnel: added QR code and password URL for Cloudflare tunnel (thanks to @martindonadieu).
- Model selector: fixed dropdowns not responding to viewport size.

## [1.4.3] - 2026-01-04

- VS Code extension: added Agent Manager panel to run the same prompt across up to 5 models in parallel (thanks to @wienans).
- Added permission prompt UI for tools configured with "ask" in opencode.json, showing requested patterns and "Always Allow" options (thanks to @aptdnfapt).
- Added "Open subAgent session" button on task tool outputs to quickly navigate to child sessions (thanks to @aptdnfapt).
- VS Code extension: improved activation reliability and error handling.

## [1.4.2] - 2026-01-02

- Added timeline dialog (`/timeline` command or Cmd/Ctrl+T) for navigating, reverting, and forking from any point in the conversation (thanks to @aptdnfapt).
- Added `/undo` and `/redo` commands for reverting and restoring messages in a session (thanks to @aptdnfapt).
- Added fork button on user messages to create a new session from any point (thanks to @aptdnfapt).
- Desktop app: keyboard shortcuts now use Cmd on macOS and Ctrl on web/other platforms (thanks to @sakhnyuk).
- Migrated to OpenCode SDK v2 with improved API types and streaming.

## [1.4.1] - 2026-01-02

- Added the ability to select the same model multiple times in multi-agent runs for response comparison.
- Model selector now includes search and keyboard navigation.
- Added revert button to all user messages (including first one).
- Added HEIC image support for file attachments with automatic MIME type normalization for text format files.
- VS Code extension: added Git backend integration for UI access (thanks to @wienans).
- VS Code extension: only shows the main Worktree in the Chat Sidebar (thanks to @wienans).
- Web app: terminal backend now supports a faster Bun-based PTY when Bun is available, with automatic fallback for existing Node-only setups.
- Terminal: improved terminal performance and stability by switching to the Ghostty-based terminal renderer, while keeping the existing terminal UX and per-directory sessions.
- Terminal: fixed several issues with terminal session restore and rendering under heavy output, including switching directories and long-running TUI apps.

## [1.4.0] - 2026-01-01

- Added the ability to run multiple agents from a single prompt, with each agent working in an isolated worktree.
- Git view: improved branch publishing by detecting unpublished commits and automatically setting the upstream on first push.
- Worktrees: new branch creation can start from a chosen base; remote branches are only created when you push.
- VS Code extension: default location is now the right secondary sidebar in VS Code, and the left activity bar in Cursor/Windsurf; navigation moved into the title bar (thanks to @wienans).
- Web app: added Cloudflare Quick Tunnel support for simpler remote access (thanks to @wojons and @aptdnfapt).
- Mobile: improved keyboard/input bar behavior (including Android fixes and better keyboard avoidance) and added an offset setting for curved-screen devices (thanks to @auroraflux).
- Chat: now shows clearer error messages when agent messages fail.
- Sidebar: improved readability for sticky headers with a dynamic background.

## [1.3.9] - 2025-12-30

- Added skills management to settings with the ability to create, edit, and delete skills (make sure you have the latest OpenCode version for skills support).
- Added Skills catalog functionality for discovering and installing skills from external sources.
- VS Code extension: added right-click context menu with "Add to Context," "Explain," and "Improve Code" actions (thanks to @wienans).

## [1.3.8] - 2025-12-29

- Added Intel Mac (x86_64) support for the desktop application (thanks to @rothnic).
- Build workflow now generates separate builds for Apple Silicon (arm64) and Intel (x86_64) Macs (thanks to @rothnic).
- Improved dev server HMR by reusing a healthy OpenCode process to avoid zombie instances.
- Added queued message mode with chips, batching, and idle auto‑send (including attachments).
- Added queue mode toggle to OpenChamber settings (chat section) with persistence across runtimes.
- Fixed scroll position persistence for active conversation turns across session switches.
- Refactored Agents/Commands management with ability to configure project/user scopes.

## [1.3.7] - 2025-12-28

- Redesigned Settings as a full-screen view with tabbed navigation.
- Added mobile-friendly drill-down navigation for settings.
- ESC key now closes settings; double-ESC abort only works on chat tab without overlays.
- Added responsive tab labels in settings header (icons only at narrow widths).
- Improved session activity status handling and message step completion logic.
- Introduced enhanced VSCode extension settings with dynamic layout based on width.

## [1.3.6] - 2025-12-27

- Added the ability to manage (connect/disconnect) providers in settings.
- Adjusted auto-summarization visuals in chat.

## [1.3.5] - 2025-12-26

- Added Nushell support for OpenCode CLI operations.
- Improved file search with fuzzy matching capabilities.
- Enhanced mobile responsiveness in chat controls.
- Fixed workspace switching performance and API health checks.
- Improved provider loading reliability during workspace switching.
- Fixed session handling for non-existent worktree directories.
- Added Discord links in the about section.
- Added settings for choosing the default model/agent to start with in a new session.

## [1.3.4] - 2025-12-25

- Diff view now loads reliably even with large files and slow networks.
- Fixed getting diffs for worktree files.
- VS Code extension: improved type checking and editor integration.

## [1.3.3] - 2025-12-25

- Updated OpenCode SDK to 1.0.185 across all app versions.
- VS Code extension: fixed startup, more reliable OpenCode CLI/API management, and stabilized API proxying/streaming.
- VS Code extension: added an animated loading screen and introduced command for status/debug output.
- Fixed session activity tracking.
- Fixed directory path handling (including `~` expansion) to prevent invalid paths and related Git/worktree errors.
- Chat UI: improved turn grouping/activity rendering and fixed message metadata/agent selection propagation.
- Chat UI: improved agent activity status behavior and reduced image thumbnail sizes.

## [1.3.2] - 2025-12-22

- Fixed new bug session when switching directories.
- Updated OpenCode SDK to the latest version.

## [1.3.1] - 2025-12-22

- New chats no longer create a session until you send your first message.
- The app opens to a new chat by default.
- Fixed mobile and VSCode sessions handling.
- Updated app identity with new logo and icons across all platforms.

## [1.3.0] - 2025-12-21

- Added revert functionality in chat for user messages.
- Polished mobile controls in chat view.
- Updated user message layout/styling.
- Improved header tab responsiveness.
- Fixed bugs with new session creation when the VSCode extension initialized for the first time.
- Adjusted VSCode extension theme mapping and model selection view.
- Polished file autocomplete experience.

## [1.2.9] - 2025-12-20

- Added session auto-cleanup with configurable retention across app versions, including the VSCode extension.
- Added web package updates from the mobile/PWA settings view.
- Added several optimizations for long sessions.

## [1.2.8] - 2025-12-19

- Added a web update flow that does not require CLI interaction.
- Added a web install script with package manager detection.
- Web server update/restart now reuses previously set parameters like port or password.

## [1.2.7] - 2025-12-19

- Comprehensive macOS native menu bar entries.
- Redesigned directory selection view for web/mobile with improved layout.
- Improved theme consistency across dropdown menus, selects, and command palette.
- Introduced keyboard shortcuts help menu and quick actions menu.

## [1.2.6] - 2025-12-19

- Added write/create tool preview in permission cards with syntax highlighting.
- More descriptive assistant status messages with tool-specific and varied idle phrases.
- Polished Git view layout.

## [1.2.5] - 2025-12-19

- Polished the chat experience for longer sessions.
- Fixed file links from Git view to Diff.
- Improved inactive-state handling in the Desktop app.
- Redesigned Git tab layout with improved organization.
- Fixed untracked files in new directories not showing individually.
- Smoother session rename experience.

## [1.2.4] - 2025-12-18

- Added macOS app menu entries for Check for Update and bug/request reports in Help.
- Mobile: added settings, improved terminal scrolling, and fixed app layout positioning.

## [1.2.3] - 2025-12-17

- Added image preview support in Diff tab (shows original/modified images instead of base64 code).
- Improved diff view visuals and aligned styling across widgets.
- Optimized Git polling and background diff/syntax pre-warming for faster Diff tab opening.
- Optimized reloading unaffected diffs.

## [1.2.2] - 2025-12-17

- Agent Task tool now renders progressively with live duration and completed sub-tools summary.
- Unified markdown rendering between assistant messages and tool outputs.
- Reduced markdown header sizes.

## [1.2.1] - 2025-12-16

- Todo task tracking: collapsible status row showing AI's current task and progress.
- Switched "Detailed" tool output mode to only open the 'task', 'edit', 'multiedit', 'write', 'bash' tools.

## [1.2.0] - 2025-12-15

- Favorite & recent models for quick access in model selection.
- Tool call expansion settings: collapsed, activity, or detailed modes.
- Font size & spacing controls (50-200% scaling) in Appearance Settings.
- Settings page access within VSCode extension.
  Thanks to @theblazehen for contributing these features!

## [1.1.6] - 2025-12-15

- Optimized diff view layout with smaller fonts and compact hunk separators.
- Improved mobile experience: simplified header, better diff file selector.
- Redesigned password-protected session unlock screen.

## [1.1.5] - 2025-12-15

- Improved file attachment performance.
- Added fuzzy search for file mentions with `@` in chat.
- Optimized input area layout.

## [1.1.4] - 2025-12-15

- Flexoki themes for Shiki syntax highlighting for consistency with the app color schema.
- Enhanced VSCode extension theming with editor themes.
- Fixed mobile view model/agent selection.

## [1.1.3] - 2025-12-14

- Replaced Monaco diff editor with Pierre/diffs.
- Added line wrap toggle in diff view with dynamic layout switching (auto-inline when narrow).

## [1.1.2] - 2025-12-13

- Moved VS Code extension to activity bar (left sidebar).
- Added feedback messages for "Restart API Connection" command.
- Removed redundant VS Code commands.
- Enhanced UserTextPart styling.

## [1.1.1] - 2025-12-13

- Adjusted model/agent selection alignment.
- Fixed user message rendering issues.

## [1.1.0] - 2025-12-13

- Added assistant answer fork flow.
- Added OpenChamber VS Code extension with editor integration: file picker, click-to-open in tool parts.
- Improved scroll performance with force flag and RAF placeholder.
- Added git polling backoff optimization.

## [1.0.9] - 2025-12-08

- Added directory picker on first launch to reduce macOS permission prompts.
- Show changelog in update dialog from current to new version.
- Improved update dialog UI with inline version display.
- Added macOS folder access usage descriptions.

## [1.0.8] - 2025-12-08

- Added fallback detection for OpenCode CLI in `~/.opencode/bin`.
- Added window focus after app restart/update.
- Adapted traffic lights position and corner radius for older macOS versions.

## [1.0.7] - 2025-12-08

- Optimized OpenCode binary detection.
- Adjusted app update experience.

## [1.0.6] - 2025-12-08

- Enhanced shell environment detection.

## [1.0.5] - 2025-12-07

- Fixed "Load older messages" incorrectly scrolling to bottom.
- Fixed page refresh getting stuck on splash screen.
- Disabled devtools and page refresh in production builds.

## [1.0.4] - 2025-12-07

- Optimized desktop app start time.

## [1.0.3] - 2025-12-07

- Updated onboarding UI.
- Updated sidebar styles.

## [1.0.2] - 2025-12-07

- Updated macOS window design.

## [1.0.1] - 2025-12-07

- Initial public release of OpenChamber web and desktop packages in a unified monorepo.
- Added GitHub Actions release pipeline with macOS signing/notarization, npm publish, and release asset uploads.
- Introduced OpenCode agent chat experience with section-based navigation, theming, and session persistence.
