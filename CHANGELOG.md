# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

## [1.16.119] - 2026-08-05

- **Mobile chat history availability:** reserve a spinner-backed load-older control while the first page resolves, so every mobile entry path keeps the pagination affordance visible.
- **Relay Markdown images:** retain `file:` image locators through sanitization as a private decoration source, allowing the Relay image pipeline to replace them with opaque native display URLs.

## [1.16.118] - 2026-08-05

- **Mobile chat history availability:** page responses retain their cursor and completion boundary through cache-dirty tail refreshes, keeping the load-older action available from authoritative response metadata.
- **Chat history pagination:** load four user turns per prepend page, pass each session workspace directory through pagination metadata, merge cursor state by authoritative load generation, and bound Host turn-page requests with a client timeout.
- **Mobile load-older experience:** render the spinner from the explicit pagination mutation, preserve the first visible message and its viewport offset across virtualized prepend transitions, and retain released auto-follow ownership through restoration.
- **History failure feedback:** surface turn-page and transport failures through the localized load-older toast, including user-initiated requests that return no page growth.
- **Relay host security:** allow private-relay host control only in the Electron desktop runtime; Web, CLI, VS Code, and plain Node runtimes receive an unavailable response.
- **Mobile scheduled task history:** keep each run's start time and trigger metadata on one compact row.

## [1.16.118-beta.4] - 2026-08-05

- **Mobile chat history:** label the initial cursor discovery as “Checking for earlier messages…” so it describes availability checking before the actionable load-more button appears.
- **Mobile load-older viewport:** hold auto-follow released through explicit prepend restoration, preventing TanStack transition and measurement scroll events from reclaiming bottom ownership on the first load.
- **Virtualized history transition:** preserve the first visible message and its viewport offset when a prepend crosses the small-history virtualization threshold.

## [1.16.118-beta.3] - 2026-08-05

- **Load-older button missing:** incomplete wins when merging local + prefetch meta — a dirty prefetch (`complete:false`) no longer loses to a stale local `complete:true`, which hid the mobile "load older" button and blocked pagination.
- **Load-older silent no-op:** throw when history is incomplete but cursor is missing; toast on user-initiated no-growth as well as transport errors.
- **Materialize turn limit:** session materialize writes prefetch `limit` as Host turnCount (not message count).
- Includes **1.16.118-beta.2** (cursor merge, failure toast, desktop-only relay host) and **beta.1** (4-turn pages, mutation busy, timeout).

## [1.16.118-beta.2] - 2026-08-05

- **Chat load-more silent no-op:** merge local pagination meta with prefetch so a local entry without cursor cannot hide a still-valid prefetch cursor (mobile "load older" no longer flashes and stops with no request).
- **Load-older failures:** surface Host turn-page / transport errors with a toast (`chat.history.loadOlderFailed`) instead of swallowing them after the spinner clears.
- **Relay host gate:** only the Electron desktop runtime may open the private-relay host-control socket; plain Node / web / CLI / VS Code report unavailable and refuse host enable/pairing with 403.
- Includes **1.16.118-beta.1:** 4-turn prepend pages, directory-scoped load-more, mutation-owned mobile load-older busy state, Host turn-page timeout, scheduled-tasks mobile history row layout.

## [1.16.118-beta.1] - 2026-08-05

- **Chat load-more:** raise history prepend to 4 turns per page (local and Relay), pass the session workspace directory into load-more meta so cross-project sessions no longer silent-no-op, and bound Host turn-page flights with a client timeout.
- **Mobile load-older button:** own explicit load-earlier with TanStack `useMutation` so the spinner tracks real mutation pending state instead of background materialize/prefetch loading (fixes stuck Relay spinner with no real load).
- **Scheduled tasks (mobile):** keep history row meta (started time / trigger) on one line in the mobile panel.

## [1.16.117] - 2026-08-04

- **Relay Markdown images:** load local image references through the encrypted binary tunnel on first paint, so screenshots and other agent-produced image artifacts render directly on paired clients.
- **Native Relay images:** stream host-backed images through an opaque virtual asset protocol on desktop and mobile (Electron `openchamber-asset` scheme + Capacitor bridge), so progressive tunnel images load without exposing host paths or credentials.
- **Chat history:** preserve current-session transcript content while older history pages load, with transport-aware turn windows and safer hosted Assistant transcript reconciliation.
- **Chat tool activity:** render each static tool call on its own row, keep pre-assistant compaction disclosure expandable, and seed task avatars by task id.
- **Queued message chips:** improve chip state handling for pending composer messages.
- **Scheduled task history:** refine failed-run details in dark mode with theme-aware text and a quiet status icon treatment.

## [1.16.116] - 2026-08-04

- **Git sync:** keep the toolbar controls aligned while sync details appear instantly in a hover tip; pending incoming or outgoing changes receive a compact status badge.
- **Chat stability:** eliminate activity-tool flicker during streaming, preserve cached timeline layout, and keep session synchronization responsive while live updates arrive.
- **Composer and references:** improve dropped-file references, inline visual layout, and model-control interaction handling.
- **Scheduled tasks:** extend the runtime allowance for task dialogs and simplify progressive tool-row rendering.

## [1.16.115] - 2026-08-04

- **Chat timeline (turn pages):** load and paginate conversations by turn pages instead of raw message slices, with shared Web / VS Code bridge + server `session-turn-pages` APIs so cold open, history scroll-up, and recovery share one cursor-aware contract.
- **Cold open hydration:** gate the transcript behind a stable skeleton until the first renderable snapshot lands — no more flash of “Unable to load this conversation”, and session pin waits until hydration leaves so deep links / session switches do not pin against an empty shell.
- **Virtualized history:** end-anchored TanStack Virtual (`anchorTo: 'end'`, `followOnAppend`) with activity-density estimates, timeline cache keys split by collapsed/summary mode, synchronous `scrollToFn` writes so end-anchor stays in lockstep with the DOM, and overscan that no longer ramps through thrashing measure waves.
- **Markdown hydration:** cold open and bulk history land settle the visible window in one after-paint commit; scrolling meters preload; idle frames release under density-aware limits so dense collapsed viewports stop freezing multi-hundred-ms React dumps.
- **Turn activity:** live processing on the latest turn always starts expanded so you can watch work in flight; when it settles and stays untouched it follows the collapsed/summary setting again; touched turns keep explicit expansion across disposition changes.
- **Progressive groups & compaction:** progressive tool/reasoning grouping and compaction-aware timeline projection keep long turns readable without losing part order or live tail fidelity.
- **Pending messages:** retain optimistic / provisional admission parts through live merge so user bubbles do not vanish when a part-less live row overlays SQLite history.
- **Hosted Assistant history:** seed the current binding from Assistant SQLite, overlay directory-sync by message ID (live wins only with parts), and keep same-assistant infinite-query placeholder data across `sessionID` / `sessionGeneration` so stateless turns do not blank the stitched transcript mid-load.
- **Scheduled tasks:** durable run-history store with dialog UI for past runs, elapsed duration, and clearer task status — plus recovery paths that keep history readable after restarts.
- **Session goals:** richer goal row / dialog with run history and elapsed duration while a goal is active or evaluating.
- **Composer send reliability:** primary send falls back to the visible model/agent selection when worktree→project config lag makes live capture miss; one more activate+recapture when still incomplete; missing provider/model now toasts instead of silently restoring the draft.
- **Session identity gate:** primary chat unblocks Send once a renderable message snapshot exists, even if the directory session-list row is still lagging; live/global session entity is a second proof path.
- **Model picker tooltip:** show provider name, capability icons (tools / reasoning / image / video / audio), and stacked In/Out cost rows instead of raw modality text dumps.
- **Sync:** initial session materialization uses the turn-page limit (`getInitialSessionTurnLimit`) so bootstrap page size matches history pagination.
- **Desktop branding:** refresh packaged `icon.ico` / `icon.png` assets for the dark OpenChamber mark.

## [1.16.114] - 2026-08-03

- **Markdown rendering:** reserve the box each content string actually renders at instead of laying out the raw source as an invisible spacer, so the swap from placeholder into rich content no longer shrinks the row or yanks the scroll offset; heights come from `ResizeObserver` entries and are dropped when the column width changes.
- **Markdown highlighting:** memoize every Shiki worker entry point with content-addressed keys, deduplicate concurrent requests for the same snippet into one worker job, and leave failed highlighting retryable instead of cached, so a row scrolling out of view can no longer strip highlighting from a row still waiting on the same code.
- **Markdown hydration:** batch-release the visible hydration window in one commit (with metered preload past both viewport edges) so entering a session settles layout without remeasuring and re-anchoring the virtualizer once per turn.
- **Code fences:** a fence whose info string is a `startLine:endLine:filepath` code reference now resolves the referenced file's name or extension to the correct Shiki language id and shows the file path on the code card header, instead of leaving every reference block uncolored under a mangled path.
- **Message rendering:** release the turn tail in one batch while idle (never mid-stream), and replace the forced reflow reads in the chat auto-follow scroll path with a single box snapshot per scroll event for a smoother long-scroll experience.
- **Sessions sidebar:** refresh active-session selection with an inset rounded chip, keep the whole row clickable (without double-firing interactive children), and optimize group prop equality and render-phase structure lookups to reduce re-renders.
- **Goal mode:** recover a restarted active goal stranded on “evaluating” after the app was force-killed mid-turn — an orphaned unfinished assistant reply is now corroborated against live session status and resumed past instead of bailing forever.
- **Chat history:** recover an incomplete tail page by fetching up to eight missing parent user messages by exact message ID (including mixed tails that already hold a newer user turn); authoritative complete pages skip parent recovery.
- **Settings / i18n:** add a theme-mode switch label and align the “Tokens” terminology across Simplified and Traditional Chinese goal copy.

## [1.16.113] - 2026-08-03

- **Slash commands:** auto-submit only immediate local actions (`new`, `fork`, `compact`, `undo`, `redo`, `model`, `goal`); draft-style commands such as `/loop` insert into the composer for continued editing.
- **Goal mode:** `/goal` only arms goal mode, strips the command token, and leaves any objective draft in the composer instead of auto-sending.
- **Composer chips:** hand-typed complete slash commands promote to reserved-slot chips so icon spacing matches autocomplete selection.
- **Assistant TPS:** optional generation-rate display on completed assistant messages and in the context panel (tool call time excluded).
- **Terminal:** stop rebinding the PTY stream on viewport resize/fit; only the first measured viewport size enters session creation.
- **Docs / mobile:** refresh README download links and mobile screenshots; keep Capacitor update checks on the native app version path.

## [1.16.112] - 2026-08-03

- **Mobile Relay recovery:** preserve the active runtime and model catalog through transient re-probe failures, allowing the tunnel reconnect path to recover without clearing model selection.

## [1.16.111] - 2026-08-02

- **Mobile image preview:** consume the WebView's synthesized trailing click before the viewer unmounts so a stationary tap closes the preview and keeps the source image closed.

## [1.16.110] - 2026-08-02

- **Image preview:** keep the full-screen viewer in control of pointer input throughout its closing transition and consume the closing click so the underlying image stays closed.

## [1.16.109] - 2026-08-02

- **Image preview:** replace the static image popup with a full-viewport gallery viewer that supports `1x`–`5x` zoom, bounded pan, desktop wheel/double-click controls, mobile pinch gestures, and swipe navigation without horizontal content padding.
- **Mobile image preview:** use a stationary tap to close at any zoom level while keeping pinch, pan, gallery swipe, and cancelled gestures isolated; remove visible title and close chrome while preserving keyboard focus trapping and an accessible hidden close action.

## [1.16.108] - 2026-08-02

- **Chat images:** open Markdown and message images in the shared gallery preview, resolving relative paths, absolute paths, and file URLs through the active Relay runtime when needed.
- **Relay Markdown:** show themed click-to-load placeholders for local images while direct and LAN connections retain browser-native image loading; streaming updates reconcile activated image resources through explicit render commits without DOM image observers.
- **Assistant navigation:** open source sessions through the native phone navigation stack, honor guarded Chat-tab switches on desktop and iPad, and use a target icon for the source-session action.

## [1.16.107] - 2026-08-01

- **Desktop updates:** keep idle package downloads silent until the user clicks Download, then join any in-flight download and show progress from the current offset instead of restarting at 0%.
- **Desktop updates:** style “Restart to Update” with the normal primary action color instead of the success mint tint.
- **Message queue:** address durable queue rows by transport, directory, session, and delivery target only — never by runtime generation — so LAN⇄relay or host-restore bounces no longer orphan persisted queue items.

## [1.16.106] - 2026-08-01

- **Mobile updates:** Android and iOS Capacitor clients now check for app updates directly against EdgeOne, then Vercel, then GitHub Releases, using the native app version instead of the connected OpenChamber Server’s network and version.

## [1.16.105] - 2026-08-01

- **Updates:** check the configured EdgeOne-compatible update service first, then Vercel, then GitHub Releases. The update path now serves Web, VS Code, Capacitor mobile, and server-managed update checks through the same fallback chain.

## [1.16.104] - 2026-08-01

- **Mobile updates:** surface update-check failures instead of reporting “already on latest” when the connected instance cannot reach the update service, and keep About retry available after a failed check.

## [1.16.103] - 2026-08-01

- **Update service:** restore the EdgeOne transition feed for already-installed clients still pointed at `openchamber-update.edgeone.dev`, sharing the same stable release manifest and GitHub assets as Vercel.
- **Update service:** route EdgeOne desktop updater manifests through one dynamic handler so every `latest*.yml` path resolves without per-file edge routes.
- **Release CI:** keep TestFlight submission-limit deferrals from blocking GitHub Release finalize.
- **Sessions sidebar:** rename the sidebar new-conversation entry to “New chat” and wire it to the correct label key instead of the schedule copy.
- **Chat history:** batch-release the visible markdown hydration window in one commit so entering a session settles layout without remeasuring and re-anchoring the virtualizer once per turn.

## [1.16.102] - 2026-08-01

- **Assistants:** make cold-device conversation loading wait for session startup, retry transient OpenCode history failures, and skip deleted historical sessions while preserving mirrored messages.

## [1.16.101] - 2026-08-01

- **Release CI:** fix Vercel update-service deploy path so stable finalize no longer doubles `deploy/update-service` and fails production publish.

## [1.16.100] - 2026-08-01

- **Update service:** move the public auto-update API and desktop Electron updater feed from EdgeOne Pages to Vercel (`openchamber-update.vercel.app`), removing the EdgeOne project layout and fixing mainland check-update failures that returned HTTP 401.

## [1.16.99] - 2026-07-31

- **Message edit:** commit a staged edit before queue admission, so a resend routed through the queue (queued messages present, queue follow-up, or auto-review running) deletes the old turn first instead of landing as an extra message with a stale edit that could delete it on a later unrelated send.
- **Message edit:** treat the whole composer shell (attachment chips, input header, footer) as still inside the composer for blur disarming, so removing an attachment or opening a dropdown no longer cancels the edit.
- **Message edit:** keep the staged edit while a mobile chrome action (attach / agent / model picker) blurs the composer on purpose, matching the desktop send-button behavior.

## [1.16.98] - 2026-07-31

- **Message edit:** stop treating an empty composer as a cancel; a staged edit now releases only on the ✕, on leaving the session, or when focus moves out of the composer.
- **Message edit:** ignore the blurs that do not mean abandonment — a send in flight, focus landing on composer chrome such as attach / model / dictation, the mobile overlay and keyboard-restore windows, and the blur that precedes staging a different row.
- **Message edit:** re-focus the composer per edited row, so switching edit targets focuses again without stealing focus while typing.

## [1.16.97] - 2026-07-31

- **Message edit:** hold the staged edit while a send is in flight so the optimistic composer clear no longer disarms the edit it is submitting, which left the original message in place and stranded a permanent “editing…” shimmer.
- **Message edit:** always release the editing paint once the send settles, on the success, failure, and early-bail paths.
- **Message edit:** focus the composer when an edit arms, retrying on the next frame if the textarea is not mounted or still disabled yet.

## [1.16.96] - 2026-07-31

- **Message edit:** stop a forgotten staged edit from deleting history on the next ordinary send; cancel, clear the composer, or leave the session disarms it.
- **Message edit:** show a visible “edit pending” chip with cancel on the target user row before send, then a shimmer “editing…” label while the commit runs.
- **Message edit:** derive the delete range only from an authoritative server snapshot, keep deletes forward-only, and exclude in-flight optimistic send IDs so optimistic resend no longer wipes earlier turns.
- **Mobile sessions:** expose Rename from the session status-bar menus, and close the rename sheet as soon as smart-title is submitted instead of waiting for generation to finish.

## [1.16.95] - 2026-07-31

- **Desktop updates:** after discovering a pending package, auto-download only while the OS reports idle/locked (`powerMonitor`), sharing one in-flight download with the manual Download button so the two paths never race.
- **Desktop updates:** keep `downloaded` across hourly re-checks for the same version, and mirror main-process progress / ready events so the UI can flip to “Restart to Update” without a second click.
- **Desktop updates:** also probe on window focus (throttled to once per 20 minutes) while keeping the hourly visible-window baseline check.
- **Agent/model defaults:** remember the last explicit pick as one Project-scoped unit (agent + model + variant), with a global fallback, instead of a per-agent model map; migrate legacy `lastSelectedAgentName` / `agentModelSelections` on hydrate.
- **Session fork:** keep the fork loading shell session-scoped, only follow into the new chat when the user is still on the source/target, and skip restoring pending composer input after switching away mid-fork.

## [1.16.94] - 2026-07-31

- **Optimistic send:** paint the primary user row and sending state before async selection flush so ordinary sends feel immediate.
- **Message queue:** fire-and-forget queue admission with optimistic composer clear/restore, pending admission chips, and clearer in-flight send/queue button states.
- **New-session send:** centralize composer flight/establishing in a send manager so rapid follow-up sends stage “Queuing…” chips instead of opening extra sessions, then drain into the real session queue after create completes.
- **Composer send:** keep establishing pending-admission display snapshots referentially stable so sending a new-session message no longer trips Maximum update depth / getSnapshot loops in ChatInput.
- **Composer mentions:** share insertion-boundary helpers so inline file/agent references keep consistent spacing.
- **Composer citations:** strip the reserved icon well when matching image attachment filenames so Backspace removes the chip and attachment together.
- **Composer attachments:** clear inline image/code-selection citations in the same draft revision when removing an attachment, instead of hand-syncing textarea text after remove.
- **Queue chips:** decorate image/citation and mention tokens with the shared message reference chip so queued previews match sent-message styling instead of showing raw reserved-slot placeholders.
- **Mobile composer:** keep the collapsed pill non-scrollable so caret focus / swipe no longer pans long draft lines out of view.
- **Sessions sidebar:** keep the project display-mode menu beside the add-project action, and align “New Session” copy across mobile/desktop entry points.
- **Mobile share:** native Assistant shortcuts and iOS share suggestions use the Assistant display name and emoji/identicon avatar.
- **Git worktrees:** skip double-wrapping already-gated web/mobile discovery bridges so concurrent worktree listings no longer deadlock the discovery semaphore.
- **Branding:** use the dark OpenChamber mark for desktop production icons (without the PREVIEW badge), iOS AppIcon/splash, and Android launcher/splash assets.
- **Desktop branding:** force the macOS Icon Composer `AppIcon` (`Assets.car`) to the dark mark in light, dark, and tinted appearances so Dock no longer switches back to the light glyph.
- **Desktop packaging:** regenerate a multi-size Windows `icon.ico` (includes 256×256) so electron-builder packaging succeeds after the dark-logo refresh.
- **Android branding:** regenerate adaptive-icon cube-only foreground mipmaps and use a full-bleed dark gradient background drawable so launchers no longer stack a finished icon card over the adaptive background; render share-shortcut avatars on transparent canvases.
- **Visual settings:** stack chat rendering controls full-width for a cleaner settings layout.
- **Toolchain:** upgrade Vite 8 / `@vitejs/plugin-react` 6 with Rolldown Babel + React Compiler presets across web/vscode roots.
- **Release CI:** publish semver prereleases as GitHub prereleases and skip EdgeOne update-manifest publication; finalize publishes the existing draft by `release_id`; skip iOS/TestFlight builds for `-beta` tags.

## [1.16.94-beta.8] - 2026-07-31


- **Desktop branding:** force the macOS Icon Composer `AppIcon` (`Assets.car`) to the dark mark in light, dark, and tinted appearances so Dock no longer switches back to the light glyph.
- **Android branding:** regenerate adaptive-icon cube-only foreground mipmaps and use a full-bleed dark gradient background drawable so launchers no longer stack a finished icon card over the adaptive background.

## [1.16.94-beta.7] - 2026-07-31

- **Queue chips:** decorate image/citation and mention tokens with the shared message reference chip so queued previews match sent-message styling instead of showing raw reserved-slot placeholders.
- **Mobile composer:** keep the collapsed pill non-scrollable so caret focus / swipe no longer pans long draft lines out of view.
- **Git worktrees:** skip double-wrapping already-gated web/mobile discovery bridges so concurrent worktree listings no longer deadlock the discovery semaphore.
- **Mobile branding:** use a full-bleed dark Android adaptive-icon background with the transparent vector foreground mark, and render share-shortcut avatars on transparent canvases.
- **Visual settings:** stack chat rendering controls full-width for a cleaner settings layout.
- **Toolchain:** upgrade Vite 8 / `@vitejs/plugin-react` 6 with Rolldown Babel + React Compiler presets across web/vscode roots.

## [1.16.94-beta.6] - 2026-07-31

- **Composer send:** keep establishing pending-admission display snapshots referentially stable so sending a new-session message no longer trips Maximum update depth / getSnapshot loops in ChatInput.
- **Release CI:** finalize publishes the existing draft by `release_id` instead of recreating a release by tag, which was leaving empty published releases and failing with `tag_name already_exists`.

## [1.16.94-beta.5] - 2026-07-31

- **Desktop packaging:** regenerate a multi-size Windows `icon.ico` (includes 256×256) so electron-builder packaging succeeds after the dark-logo refresh.
- **Composer attachments:** clear inline image/code-selection citations in the same draft revision when removing an attachment, instead of hand-syncing textarea text after remove.

## [1.16.94-beta.4] - 2026-07-31

- **Mobile share:** native Assistant shortcuts and iOS share suggestions use the Assistant display name and emoji/identicon avatar.
- **Composer citations:** strip the reserved icon well when matching image attachment filenames so Backspace removes the chip and attachment together.

## [1.16.94-beta.3] - 2026-07-31

- **Branding:** use the dark OpenChamber mark for desktop production icons (without the PREVIEW badge), iOS AppIcon/splash, and Android launcher/splash assets.

## [1.16.94-beta.2] - 2026-07-31

- **New-session send:** centralize composer flight/establishing in a send manager so rapid follow-up sends stage “Queuing…” chips instead of opening extra sessions, then drain into the real session queue after create completes.
- **Release CI:** publish semver prereleases (e.g. `-beta`) as GitHub prereleases and skip EdgeOne update-manifest publication so stable auto-update stays on the newest non-prerelease release.
- **Sessions sidebar:** keep the project display-mode menu beside the add-project action, and align “New Session” copy across mobile/desktop entry points.

## [1.16.94-beta.1] - 2026-07-31

- **Optimistic send:** paint the primary user row and sending state before async selection flush so ordinary sends feel immediate.
- **Message queue:** fire-and-forget queue admission with optimistic composer clear/restore, pending admission chips, and clearer in-flight send/queue button states.
- **Composer mentions:** share insertion-boundary helpers so inline file/agent references keep consistent spacing.
- **Release CI:** skip iOS/TestFlight builds for `-beta` tags because Apple marketing versions cannot include prerelease suffixes.

## [1.16.93] - 2026-07-30

- **Desktop updates:** check the EdgeOne update service at startup and hourly while the packaged app is visible.
- **Android updates:** hand APK downloads to the configured system browser for download and installation.
- **Mobile composer:** stabilize Android keyboard lift and composer focus across model selection, and show a live dictation waveform.

## [1.16.92] - 2026-07-30

- **Mobile composer:** scroll long drafts within the input field after the compact composer expands.

## [1.16.91] - 2026-07-30

- **iOS external TestFlight:** use supported App Store Connect build fields and relationship operations when associating processed builds with the external beta group and submitting Beta App Review.

## [1.16.90] - 2026-07-30

- **iOS external TestFlight:** publish every uploaded iOS build to the fixed external beta group, submit it for Beta App Review, and keep the public TestFlight link serving the newest approved build.

## [1.16.89] - 2026-07-30

- **Mobile About:** show the installed native client version separately from the connected OpenChamber and OpenCode instance versions, and use the native version for mobile update checks.

## [1.16.88] - 2026-07-30

- **Chat delivery:** clear direct Composer messages before asynchronous dispatch, prevent duplicate submits across buttons, keyboard shortcuts, presets, dictation, primary chat, and Assistants, and retain failed drafts for retry.

## [1.16.87] - 2026-07-30

- **Relay messaging:** show an optimistic user message immediately and display a highlighted sending status until the prompt request settles.
- **Filesystem API:** centralize outside-file grant validation and simplify route coverage for read-only file access.

## [1.16.86] - 2026-07-30

- **macOS signed desktop:** give Electron helper processes their own hardened-runtime JIT entitlements so notarized DMGs no longer crash in `OpenChamber Helper (Renderer)` during V8 startup.
- **Desktop updates:** allow the packaged UI to check, download, and apply desktop updates independently of the active OpenChamber host connection, while still keeping generic remote `desktop_restart` blocked.
- **Relay Docker:** build `linux/amd64` and `linux/arm64` images natively in parallel, then merge digests into the multi-arch `:version` and `:latest` manifests.

## [1.16.85] - 2026-07-29

- **Desktop stability:** update Electron to 41.10.3, restoring Renderer startup on macOS 26.5.2 Apple Silicon systems.
- **Release automation:** publish macOS arm64, Windows, Linux, Android, iOS TestFlight, and Relay artifacts without building or attaching a VS Code extension package.

## [1.16.84] - 2026-07-29

- **Desktop updates:** deliver signed macOS ZIP updates through the same in-app Electron updater flow as Windows and Linux, with download and restart-to-install support.
- **Release automation:** install notarization credentials only in macOS jobs so VS Code builds remain platform-independent and macOS packaging can notarize correctly.

## [1.16.83] - 2026-07-29

- **Apple release signing:** configure Developer ID signing and notarization for macOS desktop builds, and App Store distribution signing for iOS TestFlight (main app, Widget, Notification Service, Share Extension).
- **iOS App Group:** link `group.com.yee94.openchamber` across all App Store targets and regenerate provisioning profiles so archive and export succeed.
- **iOS App Store upload:** declare the full iPad interface orientation set required for multitasking review.
- **Release pipeline:** include iOS TestFlight upload in the formal GitHub Release workflow alongside desktop, Android, VS Code, and Relay.

## [1.16.82] - 2026-07-29

- **Session status:** release stale project loading indicators when a newer session-index batch replaces completion metadata, and keep mobile project cards aligned with the recent-session list after a session finishes.
- **Mobile worktrees:** present the new-worktree flow in a resizable, scrollable sheet with a fixed action area.

## [1.16.81] - 2026-07-29

- **Relay pairing:** allow the local Desktop shell (`desktop-local`) to set a custom Host Relay endpoint when creating pairing sessions; remote client tokens stay blocked.
- **Mobile Settings:** keep Settings detail pages as a quiet transparent canvas so only group cards own material, including Android solid chrome.

## [1.16.80] - 2026-07-29

- **Mobile instances:** make the whole instance row a switch target while edit/delete actions keep their own hit areas.

## [1.16.79] - 2026-07-29

- **Relay pairing:** choose official or custom `ws://` / `wss://` Relay endpoints when creating device QR codes, pin server-side endpoints with `OPENCHAMBER_RELAY_URL`, and remember the endpoint from scanned pairing payloads.
- **Relay packaging:** publish Relay Docker images on release, document remote `docker-compose` deployment, and keep repository artifacts free of personal domains or machine paths.
- **Session message pages:** use one 30-message page size for bootstrap, history, recovery, and materialization on every surface, including private Relay tunnels.
- **Mobile composer keyboard:** only the bottom chat composer arms keyboard lift; question cards and other fields no longer move chrome.
- **Draft branch picker:** keep branch lists scoped to the project root so switching worktrees does not drop a warm list while git probes settle.
- **Desktop Preview:** share the machine OpenCode config and session store with release/CLI while still isolating OpenChamber app data.

## [1.16.78-beta.1] - 2026-07-29

- **Message queue:** start manual-dispatch probes before long reconciliation reads, treat accepted rows as explicit reconciliation work, and keep queue chips stable while authoritative revisions catch up.
- **OpenCode events and session status:** normalize current event envelopes, use `v2.session.active` membership with a three-state capability probe, and reconcile live busy/retry/idle status per directory.
- **Session index and worktrees:** retain empty synced directories for cross-client topology recovery, retry transient session-index refreshes without clearing useful projections, and release only observer-owned loading state after failures.
- **Worktree creation:** recover a successful Git worktree creation when message-queue activation remains pending through a scoped, bounded repair flow.
- **Desktop and mobile:** show a runtime-switch overlay until Desktop reconnection is ready, improve host status fidelity, prevent touch-scroll file mentions from selecting rows, and load relay file images through authenticated blobs.
- **Agent settings:** save only edited fields so unrelated changes retain existing model and permission configuration.
- **Android:** reduce streaming rendering and haptic frequency, replace persistent glass blur with solid semantic surfaces, and remove workstation-specific Buildship JDK and JDTLS paths.

## [1.16.77] - 2026-07-28

- **Session merge:** centralize session message page merge strategy so the loader, reducer, and materialization share one `(purpose, stale)` resolution instead of diverging rules.
- **Reconnect recovery:** stale recovery pages backfill missing messages without overwriting newer live message objects.
- **Message loading:** route initial and history loads through the shared session-message loader instead of duplicate fetch paths.

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
