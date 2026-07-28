# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

## [1.16.76] - 2026-07-28

- **File links:** detect binary files across Web, VS Code, and Desktop, open them with the system default app on desktop, and skip non-image binary references on mobile.
- **Model picker:** keep search-time section collapse independent from browse mode so filtering no longer fights your saved section layout.
- **Reconnect recovery:** allow recovery pulls to apply stale revision pages and reconcile active session status after the transcript tail reloads.

## [1.16.75] - 2026-07-28

- **Mobile file preview:** open Read/Skill and chat file links in a gesture resizable sheet on phone, with direct-preview back dismiss and iPad still using the right Files panel.
- **Refresh transcript:** add a mobile overflow Refresh action that clears prefetch and re-materializes the current session tail from the server.
- **Reconnect recovery:** gate session identity and message body on separate live revisions so a streaming session can still recover its transcript after `session.get`.
- **Tool rows:** make Read/Skill tool rows full-width navigation hotspots and route mobile opens through the shared file preview path.
- **Android debug:** give debug builds a separate applicationId and app name so local installs no longer replace release packages.

## [1.16.74] - 2026-07-28

- **Session completion:** reconcile active session status from authoritative, runtime-scoped snapshots after reconnects and message pulls, keeping busy, retry, and idle indicators current.
- **Conversation refresh:** reload dirty session tails after live updates and materialize completed reasoning and text fields when an active session becomes idle.
- **Mobile new sessions:** present project and branch selection in resizable sheets, tighten selector chips, and unify bottom safe-area treatment across sheets and action surfaces.
- **Mobile composer:** keep Android keyboard transitions in sync with shorter open/close motion, and preserve follow-up send or steer controls above busy composer surfaces.
- **Release assets:** remove retired Electron icon backup files from the package resources.

## [1.16.73] - 2026-07-27

- **Smart session titles:** add a shared `requestSessionSmartTitle` action and expose AI title generation from mobile session rename dialogs on Projects home and the sessions sheet.
- **Desktop rename:** route sidebar smart-title requests through the same action so live session stores stay consistent after regeneration.

## [1.16.72] - 2026-07-27

- **Assistant delete:** long-press or context-menu Delete on desktop and mobile assistant lists opens a confirmation dialog, removes the assistant, and clears a matching default share target.
- **Assistant settings:** enlarge the default-prompt textarea so longer system prompts are easier to edit.

## [1.16.71] - 2026-07-27

- **Desktop header:** move Switch instance into the session ··· menu and anchor the instance/usage panel to that control, removing the standalone stack trigger.

## [1.16.70] - 2026-07-27

- **Search ranking:** rank command, skill, snippet, agent, and branch pickers by relevance (exact → prefix → boundary → fuzzy) so exact hits like `origin/master` stay on top.
- **Queue edit focus:** restore composer focus after editing a queued message so desktop and mobile can keep typing immediately.
- **Grok usage:** map SuperGrok unified weekly credits correctly, surface prepaid Extra Credits as a separate balance window, and avoid falling back to monthly billing when weekly data is present.

## [1.16.69] - 2026-07-27

- **Grok quota renewal:** automatically renew expired Grok Build CLI access tokens when fetching xAI usage on Web and VS Code, with clearer renewal failure messaging.
- **Mobile assistants:** long-press an assistant in the list to open Edit and jump straight into that assistant’s settings detail page.
- **Mobile sessions:** wire phone session and draft open actions through the secondary navigation stack so + and history rows land on the correct chat route.
- **Mobile worktrees:** force-refresh the project worktree catalog on connect and when the sessions sheet opens, matching desktop topology without wiping known entries on partial failure.
- **Desktop header:** rename Services to Switch instance and surface View usage from the session menu for clearer instance switching.
- **Message queue:** strengthen server-runtime queue handling with additional regression coverage.

## [1.16.68] - 2026-07-26

- **Mobile chat navigation:** add animated, multi-level phone session navigation so child-agent conversations retain an interactive parent-page history.
- **iOS responsiveness:** start Composer keyboard motion before UIKit presentation, calibrate it from native keyboard measurements, and use high-refresh edge-back progress with velocity-aware settling.
- **Android chrome:** keep the gesture navigation bar hidden across focus and keyboard transitions for a cleaner edge-to-edge chat surface.

## [1.16.67] - 2026-07-26

- **Android sharing:** raise native Assistant share attachment capacity to 20 MiB and align the Composer handoff validation with the native draft limit.
- **Share recovery:** record privacy-safe Android draft preparation failure categories, improving diagnosis without exposing shared text, URIs, or image metadata.

## [1.16.66] - 2026-07-26

- **Session startup:** cache validated session-index snapshots by runtime identity and paint the cached sidebar state immediately during cold starts.
- **Session refresh:** move session-index snapshot reads into TanStack Query with transport-scoped keys, shared in-flight fetches, and abort-signal propagation.
- **Session resilience:** retain the cached startup projection through transient refresh failures, then reconcile it with the next authoritative live snapshot.

## [1.16.65] - 2026-07-26

- **Mobile pickers:** keep model and agent searches pinned above bounded, scrollable result lists, preserving reliable keyboard focus and touch input in Android WebView.
- **Mobile sheets:** strengthen sheet scrolling, focus handling, and dismiss-gesture ownership so search fields and compact action sheets remain responsive during touch interaction.
- **Mobile projects:** streamline main-workspace session presentation beneath the project header and preserve covered layout behavior with focused regression coverage.
- **Message queue:** preserve committed queue mutations across reconciliation so completed operations retain their authoritative state.

## [1.16.64] - 2026-07-26

- **Android keyboard:** add native IME inset sync so the mobile composer and chat layout track soft-keyboard open/close more reliably across Android WebView surfaces.
- **Assistant staged edits:** support continuous staged sent-message edits with CAS rollback, exclusive scope cleanup, and safer draft restoration when assistant bindings or transports change.
- **Assistant drafts:** preserve draft attachments across restore and staged-edit flows so shared and secondary assistant composers keep media with the draft body.
- **Composer recovery:** strengthen input-surface recovery, queue admission, and message-composer restoration so interrupted or remounted chat surfaces rehydrate drafts without dropping queued work.
- **Mobile sessions:** refine session list pagination, project search, and mobile chat chrome for smoother project-home and history navigation.
- **Message queue:** tighten server-edit bridge and shadow-import paths so queue status and edit handoffs stay consistent across client and server runtimes.

## [1.16.63] - 2026-07-25

- **Grok quota:** add Grok Build credit and billing-window usage across Web, VS Code, and shared quota surfaces, using local Grok CLI authentication.
- **File references:** detect extension-bearing project paths in ordinary assistant prose and make file links open directly in the mobile Files preview.
- **Mobile history:** hand virtualized history-prepend anchoring to TanStack Virtual while preserving exact compensation for non-virtualized lists, improving scroll stability during older-message loads.
- **Mobile autocomplete:** cap command, skill, and file suggestion panels at 40% of the visual viewport so long lists remain scrollable without covering the conversation.
- **Message queue:** strengthen server-runtime dependency wiring and production cutover coverage for more reliable queue status and snapshot hydration.
- **Mobile polish:** refine queued-message controls, timeline caching, and responsive chat layout behavior.

## [1.16.62] - 2026-07-25

- **Mobile connections:** make pairing links a first-class connection method on both welcome and instance-management surfaces, with clearer separation from manual server addresses.
- **Mobile feedback:** add light, medium, and heavy native haptics, refine press scaling for compact controls and full-width rows, and tighten queued-message touch controls.
- **Mobile layout:** lock the Android and iOS apps to portrait orientation for a consistent phone-first experience.
- **Session freshness:** invalidate completed message-prefetch snapshots when authoritative live events arrive and retain a larger mobile session cache to keep revisited conversations current and responsive.
- **Draft branches:** resolve new-session branch chips from live Git and worktree state so they show the real branch name during cold starts.
- **Provider UI:** add a generic fallback mark for providers without local logos and compact provider rows for faster scanning.

## [1.16.61] - 2026-07-25

- **Mobile share targets:** add an Android share recipient picker so Share Sheet handoffs can choose an Assistant destination before opening the app.
- **Mobile pairing & shortcuts:** add mobile pairing deep links and Android Assistant shortcuts for faster reconnect and share entry.
- **Mobile sessions:** refine session and tab interactions, including stronger header swipe-to-sessions handling and smoother surface navigation.
- **Mobile connections:** simplify connection setup and swipe handling, and move instance management into Settings while relaxing queue blocking on share-busy turns.
- **HAPI gateway:** add HAPI gateway support for mobile and remote instances so hosted surfaces can reach configured backends more reliably.
- **Mobile polish:** continue session and Assistant flow polish across the mobile chrome and conversation surfaces.

## [1.16.60] - 2026-07-24

- **Mobile navigation:** redesign phone flows around tab-based navigation with stronger back handling, primary composer restore from session history, and send/queue runtime identity pinning so stale cross-session dispatch cannot fire.
- **Mobile settings:** unify settings and secondary navigation shells with shared layout, mobile back navigation, and Settings surfaces that match the new mobile chrome.
- **Mobile projects:** add project search, refreshed session navigation rows, and clearer session status indicators on the projects home surface.
- **Reliability:** detect TanStack Query cancelled errors correctly in Git store refreshes so cancelled work no longer surfaces as hard failures.

## [1.16.59] - 2026-07-23

- **Assistant history:** persist and page assistant-owned conversation archives across bindings, keep archived rows read-only, and avoid replacing a restorable transcript with a live-session load-failure wall.
- **Assistant composer:** allow hosted secondary surfaces to send without waiting for a directory session-list row, and fall back from queue to steer when the server queue is legacy or frozen so share-busy turns stay sendable.
- **OpenCode recovery:** recover stuck directory instances before turn admission when MCP probes report a poisoned instance that still returns prompt_async 204.
- **Desktop Preview:** package side-by-side Preview builds with distinct app identity, PREVIEW icon, and isolated OpenChamber/OpenCode data so local QA no longer collides with the installed release app.
- **Model labels:** humanize slug-style catalog names (for example DeepSeek-V4-Flash → DeepSeek V4 Flash) for consistent picker and header display.
- **Desktop sidebar:** pin brand mark and global search above the scroll region when a brand is configured, and reserve no empty brand row when it is not.

## [1.16.58] - 2026-07-23

- **Message headers:** show non-default thinking depth as a muted model-name suffix (same rule as the composer), and hide the default depth instead of rendering a separate brain badge.
- **Send after idle:** paint the optimistic user bubble and busy status before the connection grace wait so long-idle reconnects no longer clear the composer while the chat list still shows the pre-send snapshot.
- **Session message cache:** only force-refetch a busy/retry session when the local tail is not already a user message, so ordinary session switches keep the cache and avoid a loading flash.

## [1.16.57] - 2026-07-23

- **Model picker:** open thinking variants in a dedicated desktop sub-view, show the active variant on model triggers (including mobile), and dismiss the menu instantly after a pick without flashing the model list.
- **Composer references:** center trigger icons in a fixed 1em well with balanced insets, reserve icon slots for attachment citations, and strip those slots before delivery so agents still see plain `[filename]` text.
- **Provider catalogs:** treat soft metadata allowlist stripping as non-partial so incomplete optional fields no longer freeze a stale complete catalog snapshot across Web, VS Code, and shared parsers.
- **Session index:** coalesce concurrent session-index GETs and debounce dense revision tips before the next full snapshot refresh.
- **Message queue:** share status and snapshot reads through TanStack Query helpers, skip duplicate startup catalog fetches, and defer StrictMode stop so remount reuses the first in-flight refresh.
- **SmartFetch sessions:** keep temporary `smartfetch-secondary` sessions out of live directory lists and sidebar merges.
- **Desktop quit:** on macOS, a second `Cmd+Q` while the quit-risk confirmation is open confirms quit along the same shutdown path as the dialog Quit button.

## [1.16.56] - 2026-07-23

- **Keyboard shortcuts:** restore the first Esc confirmation prompt and second Esc abort path from focused chat composer inputs while a session is running.

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