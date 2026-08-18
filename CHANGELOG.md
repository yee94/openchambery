# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

## [1.17.0-beta.18] - 2026-08-18

- **Out-of-order transcripts on open:** a session whose local cache loaded just after the network page no longer renders older turns below newer ones. The durable cache seed is skipped once the canonical transcript is already filled, and any seed rows that do land are inserted by their created time instead of being appended to the tail. A manual refresh could not repair the earlier misorder; the transcript is now ordered correctly from the first paint.

## [1.17.0-beta.17] - 2026-08-18

- **Compaction transcript:** `/compact` is no longer painted as a user bubble. The compact turn stays in place so the previous assistant stream does not remount, and Compacting / Compaction complete attach to the continuous assistant Activity.
- **Compaction status hint:** while the last user command is compact and the session is still working, the bottom working hint now says Compacting instead of leftover previous-turn tool status such as Editing file.

## [1.17.0-beta.16] - 2026-08-18

- **Manual refresh no longer swallows messages:** refreshing a session transcript now reconciles against the fetched authority tail instead of rebuilding it from scratch. A just-sent message that the server has not confirmed yet survives the refresh, older history outside the tail page is kept in place, and already-loaded full parts are not downgraded to slim summaries. Server-deleted messages within the refreshed range are still removed, and a refresh that races live streaming skips deletions rather than guessing.
- **Transcript deletion on the observer path:** structural sharing now recognizes reference-stable deletion subsets, so message removals are not silently restored by the query observer.

## [1.17.0-beta.15] - 2026-08-18

- **Swallowed sends:** an unconfirmed just-sent message is no longer overwritten when a reconnect reconcile delivers a slim server copy of it — the optimistic parts stay whole until full authoritative parts arrive. Editing (which removes old turns) is untouched by this protection.
- **Edited text not updating:** slim text parts are now exact-materialized from the host record, so a message body that landed as a summary after an edit or refetch upgrades to the full authoritative text without a manual refresh. Cold-start revalidation keeps targeting only tool/reasoning/file parts, so no fetch storm.
- **Enter-and-sync:** opening a session with a warm cache now runs a lightweight authority tail check in the background (30s per-session window, skipped while SSE is live, stale revisions merge conservatively) and merges the result without clearing the transcript, so turns that finished elsewhere appear on re-entry and failures keep what is on screen.
- **Sync test harness:** new command-sequence replay tests pin the optimistic-row protection, slim text fill, and hot revalidate behavior at the repository merge boundary.

## [1.17.0-beta.14] - 2026-08-18

- **Transcript diagnostics:** new `transcript-diff` diagnostics event captures a canonical snapshot (message IDs, per-message part counts, slim/full distribution, optimistic markers) before and after every user send/edit/delete/refresh and every reconnect-compensation, materialize, and destructive-reset path, then derives the added/removed/downgraded/optimistic-lost diff. Snapshots carry no message text or attachment payloads; existing merge and compensation behavior is unchanged. Export via About → client diagnostics.
- **Composer session mentions:** @-referenced sessions now ship a self-describing card with id, title, owning directory, and cached client messages, plus a verified read-only SQLite recipe the receiving assistant can use to look up the transcript itself. Empty `messages` arrays now signal a client cache miss (still retrievable) instead of masquerading as an empty session.
- **Android save-file picker:** the Capacitor `OpenChamberMedia.saveFile` bridge now stages bytes in an app-private cache file before opening the system picker, avoiding Binder `TransactionTooLargeException` on large diagnostics exports, and uses `application/octet-stream` + `EXTRA_TITLE` so OEM DocumentsUI does not crash on confirm.

## [1.17.0-beta.13] - 2026-08-18

- **Session references:** @-mentioning a conversation no longer inlines its transcript into the prompt — under progressive hydration an unopened referenced session serialized as empty messages, silently dropping the reference content. The hidden part now carries only the stable session ID and display title plus an instruction to look the session up by ID when its content matters, references resolve from loaded session summaries without transcript reads, and pasted or copied `@<title>` text also delivers session semantics (deduped against `@session:<id>` tokens).
- **Message removal consistency:** removing a message now applies across every cached transcript scope of the same session instead of only the resolved directory, keeping multi-directory session caches consistent after retries or edits.

## [1.17.0-beta.12] - 2026-08-17

- **Missing turns:** transcript updates now broadcast to every cached scope of the same session instead of only the directory the event arrived on, and an ambiguous multi-directory route no longer drops events. Opening an already-cached session also runs a throttled background reconcile check, so turns that finished elsewhere (or before a restart) appear without a manual refresh.

## [1.17.0-beta.11] - 2026-08-17

- **Android attachments:** tapping attach in the chat composer now offers Attach photos or Attach files. Photos open the Android system Photo Picker (gallery, multi-select) through a new native bridge; files keep the document picker. iOS, desktop, web, and VS Code keep their existing attach flows.
- **Transcript hydration:** completed activity groups hydrate their slim reasoning/tool parts in the background after mount, so a cold-start tail no longer shows truncated bodies until manual expansion.

## [1.17.0-beta.10] - 2026-08-17

- **Session list recovery:** a project whose sidebar stayed empty after OpenCode once returned an empty session snapshot now rediscovers its historical sessions on the next sync, instead of waiting for the 24-hour full reconcile. Empty worktree directories keep their topology hint and normal projects keep incremental sync.

## [1.17.0-beta.9] - 2026-08-17

- **Image citations:** sending `[image-1.png]` now also writes the durable host file path into the agent-facing message, so a later turn can Read the same image. The chat chip still shows the short filename; relay/slim still omit the image bytes.

## [1.17.0-beta.8] - 2026-08-17

- **Transcript cache:** reopening the app after a session advanced elsewhere no longer pins stale message bodies from the local cache. Seeded tool/reasoning/file parts revalidate against the exact message record in the background after the first paint, so the latest content appears without a manual refresh.

## [1.17.0-beta.7] - 2026-08-17

- **Desktop image upload:** Electron can send prompt attachments again. The runtime CORS allowlist now includes the OpenChamber upload headers used from `openchamber-ui://app`.

## [1.17.0-beta.6] - 2026-08-17

- **Chat images:** slim first-paint images now upgrade in place from the exact message fetch. Assistant tool rows no longer appear as unnamed file attachments.
- **Relay images:** large images wait for a per-image Load tap instead of covering the whole card; already-visible images start loading without another scroll.

## [1.17.0-beta.5] - 2026-08-17

- **Transcript load:** a missing parent message no longer blocks the whole conversation. Sessions that OpenCode can open now load in OpenChamber even if one assistant row points at a deleted user message.

## [1.17.0-beta.4] - 2026-08-17

- **Chat settings:** hide Inline Assistant Actions and Show Tool File Icons. Chinese labels now say 显示隐藏文件 / 顯示隱藏檔案 instead of 显示点文件.

## [1.17.0-beta.3] - 2026-08-17

- **Prompt attachment uploads:** inline image/file bytes are uploaded as a binary stream before the prompt is sent, and the prompt JSON only carries a host `file://` reference. Sending large attachments no longer head-of-line blocks the shared relay tunnel with a giant data URL.
- **Native HEIC transcode:** iPhone photos convert to JPEG through native ImageIO on iOS (and the Android equivalent) instead of the heic2any WASM decoder in the WKWebView main thread; web/desktop keep the JS fallback.
- **Relay image streaming:** image chunks cross the native asset bridge in 512KB batches (8× fewer bridge round-trips), base64 chunking no longer uses oversized spread calls, and images larger than 1MB over a relay connection load on tap instead of automatically.
- **Attach documents on mobile:** the mobile attach button now opens the document picker, so JSON and other non-image files can be attached on iOS; photos stay reachable from the same picker's action sheet.

## [1.17.0-beta.2] - 2026-08-16

- **Mobile composer fade:** the fade above the input now uses a page-background mask instead of a `color-mix` gradient, so it renders on iOS WKWebView the same way it already did on Android.
- **Mobile composer scroll:** opening the input no longer press-scales or scaleY-animates the card. That transform was leaving a long textarea intermittently unscrollable on iOS.

## [1.17.0-beta.1] - 2026-08-16

- **Progressive transcript hydration:** opening a long session no longer waits for the whole history. The last user message and final answer (or a live Activity shell) render from the first packet, the composer is usable immediately, and older history backfills in the background without jumping the view.
- **Message-level transcript cache:** transcripts are now persisted per message on-device. Reopening a session paints from local cache instantly and then delta-updates only the messages that actually changed, instead of refetching the whole window.
- **On-demand tool output:** full tool-call output is fetched only when you expand an Activity, keeping first paint small.
- **Transcript diagnostics:** prerelease builds record transcript sync/load-failure facts locally and export them from About, so we can debug slow or failed loads without uploading message content.

## [1.16.134] - 2026-08-16

- **Exploration groups:** consecutive read, search, and directory tools collapse into a localized exploration group with live progress and expandable details. The grouped Exploring state lasts from the first exploration call until a later non-explore part appears, and the live count flip no longer spills out of the row or opens a mobile scrollbar (overflow-clipped so Android does not paint an overlay thumb).
- **Tool loading:** every chat tool shows the shared loading state from first appearance until it settles, then restores its normal icon; running shell tools show the loading orb while settled rows keep the terminal icon.
- **Delegated task rows:** assigned task rows keep the agent avatar and name across busy and idle states; only an unassigned live Task shows Delegating, while ordinary running tools keep their own titles. The agent badge chip on mobile is smaller, regular weight, and fill-only.
- **Localized tool names:** built-in tools carry concise Chinese labels (apply_patch is "批量修改" so patch edits read apart from single-file edit), and reasoning/activity copy consistently uses "Agent" in Simplified and Traditional Chinese instead of 智能体 / 智能體.
- **Transcript reliability:** a just-sent message and its follow-up could stop appearing while the status line kept moving; the message body now always subscribes and the option that could silence it has been removed. If a session still reports work while the visible transcript has not moved for 20 seconds and no local stream is running, the client refetches the authoritative tail itself; a failed refetch keeps the messages on screen and is logged.
- **Provider recovery:** messages no longer get stuck after a failed provider load. Sending re-triggers a fresh provider refresh once before giving up, and an empty provider catalog is never cached as permanently fresh, so the model list is re-fetched on demand instead of being stranded forever.
- **Session goals & questions:** when the agent asks a question, the goal pauses instead of staying on Evaluating and keeps waiting for your reply; a missed pending question is fetched again so its answer card returns instead of leaving unclickable chips.
- **Mobile session layout:** worktree sessions share the project-level indent instead of sitting one extra level deeper; the composer status uses the same type size as collapsed Processed activity titles and stays on the stable copy 正在委派任务 while a Task runs; the lattice loading orb is slightly larger on phones.
- **Diagnostics & privacy:** About export now saves a file via the system save picker (iOS Files / Android create-document) instead of copying to the clipboard. Anonymous usage reporting stays off unless the user turns it on, and prerelease builds record transcript sync/load-failure facts locally without ever including message bodies or tokens.
- **Remote instances:** pairing names an instance instead of a device, and relay matches require the relay URL in addition to paired credentials.
- **Dev server:** the bundled web dev build no longer pulls server or test files into the browser graph.
- **Docs (zh-CN):** refreshed Chinese documentation and sidebar navigation for the included product guides.

## [1.16.134-beta.21] - 2026-08-16

- **Exploration groups:** the count flip uses overflow clipping that does not create a scroll box, so Android no longer paints a tiny overlay thumb on the row.

## [1.16.134-beta.20] - 2026-08-16

- **Exploration groups:** the count flip still moves upward, but compositor layers no longer poke out of the row and flash a mobile scrollbar.
- **Mobile sessions:** expanded worktree lists no longer add a second indent under the project.

## [1.16.134-beta.19] - 2026-08-16

- **Status bar:** on mobile, the composer status uses the same type size as collapsed Processed activity titles.
- **Mobile sessions:** worktree sessions now share the project-level indent instead of sitting one extra level deeper.

## [1.16.134-beta.18] - 2026-08-16

- **Status bar:** while a Task is running, the composer status stays on the stable Chinese copy 正在委派任务 instead of the subagent name.

## [1.16.134-beta.17] - 2026-08-16

- **Provider recovery:** messages no longer get stuck after a failed provider load. Sending re-triggers a fresh provider refresh once before giving up, and an empty provider catalog is never cached as permanently fresh, so the model list is re-fetched on demand instead of being stranded forever.

## [1.16.134-beta.16] - 2026-08-16

- **Exploration groups:** the count flip keeps its upward motion, but the row can no longer grow and open a mobile scrollbar.

## [1.16.134-beta.15] - 2026-08-16

- **Tool rows:** ordinary running tools keep their own titles. Only an unassigned live Task shows Delegating.

## [1.16.134-beta.14] - 2026-08-16

- **Agent naming:** reasoning and activity copy now consistently use "Agent" in Simplified and Traditional Chinese instead of 智能体 / 智能體 (including the task tool row). The existing code comment in ToolPart is left untouched.

## [1.16.134-beta.13] - 2026-08-16

- **Tool rows:** only an unassigned Task shows Delegating. Assigned tasks keep the agent name; other tools keep their normal titles and only swap in the loading orb.
- **Mobile loading:** the lattice orb is slightly larger on phones, and the exploration count flip no longer opens a scrollbar.
- **Remote instances:** pairing names an instance instead of a device, and relay matches require both server id and relay URL.

## [1.16.134-beta.12] - 2026-08-16

- **Session goals:** when the agent asks a question, the goal pauses instead of staying on Evaluating. The current turn keeps waiting for your answer; resume after you reply.
- **Questions:** missed pending questions are fetched again so the answer card comes back, instead of leaving only unclickable chips in the transcript.
- **Subagent rows:** assigned task rows keep the agent name instead of falling back to Delegating.
- **Dev server:** bundled web dev no longer pulls server or test files into the browser graph.

## [1.16.134-beta.11] - 2026-08-16

- **iOS beta:** prerelease TestFlight marketing version again strips the suffix (`1.16.134-beta.10` → `1.16.134`) instead of pinning to `0.99.0`, so Apple can treat it as an update on the current 1.16.x train.

## [1.16.134-beta.10] - 2026-08-16

- **Diagnostics export:** About export now saves a file. Capacitor opens the system save picker (iOS Files / Android create-document) instead of copying to the clipboard.
- **iOS beta:** prerelease TestFlight marketing version is now fixed at `0.99.0` instead of the stripped package version, so Apple version trains no longer go backwards when package versions jump.
- **Usage reports:** anonymous usage reporting is off unless the user turns it on.

## [1.16.134-beta.9] - 2026-08-16

- **Diagnostics:** prerelease builds record transcript sync and load-failure facts locally. About can export the log; message bodies and tokens are never included.
- **iOS beta:** prerelease IPAs now upload to Internal TestFlight. Apple marketing version drops the `-beta` suffix; external group and Beta App Review stay off.

## [1.16.134-beta.8] - 2026-08-16

- **Agent badge:** the message-header agent chip is smaller, regular weight, and fill-only (no border). On mobile the name matches the 10px avatar.

## [1.16.134-beta.7] - 2026-08-16

- **Subagent rows:** the agent name stays visible beside the avatar instead of collapsing away.
- **Exploration groups:** the live count flip no longer spills out of the row and creates a scrollbar.

## [1.16.134-beta.6] - 2026-08-16

- **Subagent rows:** delegated task rows keep the agent avatar while work is in progress instead of switching to the shared loading orb.

## [1.16.134-beta.5] - 2026-08-16

- **Exploration groups:** the grouped Exploring state now lasts from the first search/read/list call until a later non-explore part appears, instead of stopping as soon as those calls settle.

## [1.16.134-beta.4] - 2026-08-16

- **Tool loading:** every chat tool shows the shared loading state from first appearance until it settles; settled rows restore their normal icons.
- **Docs (zh-CN):** refreshed Chinese documentation and sidebar navigation for the included product guides.

## [1.16.134-beta.3] - 2026-08-16

- **Shell activity:** running shell/terminal tools show the shared loading orb; settled rows restore the terminal icon.
- **Tool labels:** Chinese `apply_patch` label is now “批量修改” so patch edits read apart from single-file edit.
- **Task chrome:** delegated task rows keep the agent avatar across busy and idle states (loading orb is shell-only).

## [1.16.134-beta.2] - 2026-08-16

- **Chat activity:** consecutive read, search, and directory tools now collapse into a localized exploration group with live progress and expandable details.
- **Tool labels:** built-in tool names are localized, with concise Chinese labels for editing, writing, patches, and delegated tasks.
- **Activity polish:** refined activity, exploration, and editing tool icon sizing and status presentation.

## [1.16.134-beta.1] - 2026-08-15

- **Frozen transcript:** the message body and the session status line are separate subscriptions, so the body could stop updating while the header kept showing activity — a just-sent message and the reply that followed it would never appear. The body now always subscribes, and the option that could silence it has been removed outright.
- **Transcript self-heal:** if a session still reports work while the visible transcript has not moved at all for 20 seconds and no local stream is running, the client refetches the authoritative tail on its own. A failed refetch keeps the messages already on screen, and the case is logged so the underlying cause can be traced.

## [1.16.133] - 2026-08-15

- **Sync messages:** desktop session right-click and the mobile overflow Refresh force an authoritative OpenCode tail. Success replaces the visible transcript; failure keeps the previous messages. Refresh is disabled only when the live session is actually busy or retrying.
- **Send self-heal:** after a long idle gap the client no longer trusts a zombie "connected" stream. It reconnects before sending, and a hung prompt times out so "Sending message" cannot stick forever.
- **Cold open:** a first tail page still lands when SSE moved while it was in flight, so the skeleton does not wait for another GET. Any landed row, including an assistant-only first page, dismisses the skeleton. An empty success still does not become an empty chat.
- **Load-error retry:** clicking Try again on "Unable to load this conversation" now shows the skeleton and actually reloads the transcript.
- **Mobile sync hint:** the chat title shows a tiny "Syncing messages..." line while the current session is first loading, user-refreshing, or reconnecting. Once a transcript is already visible, reconnect no longer keeps the whisper.
- **Relay:** apply per-direction backpressure and fair-queue pumps so one busy tunnel cannot monopolize the event loop or get heartbeat-reaped while paused.

## [1.16.139-beta.5] - 2026-08-15

- **Cold open:** a first tail page still lands when SSE moved while it was in flight, so the skeleton does not wait for another GET. Any landed row, including an assistant-only first page, dismisses the skeleton. An empty success still does not become an empty chat.
- **Mobile sync hint:** once the current session already has a transcript, reconnect no longer keeps the "Syncing messages..." whisper. The hint now reads the same directory as the chat.
- **Relay:** apply per-direction backpressure and fair-queue pumps so one busy tunnel cannot monopolize the event loop or get heartbeat-reaped while paused.

## [1.16.139-beta.4] - 2026-08-15

- **Load-error retry:** clicking Try again on "Unable to load this conversation" now shows the skeleton and actually reloads the transcript instead of doing nothing.

## [1.16.139-beta.3] - 2026-08-15

- **Mobile sync hint:** the chat title shows a tiny "Syncing messages..." line while the current session is first loading, user-refreshing, or reconnecting. Idle chats stay a single title line.

## [1.16.139-beta.2] - 2026-08-15

- **Sync messages:** Refresh is disabled only when the live session is actually busy or retrying. A sticky leftover busy flag no longer greys out the mobile overflow button.
- **Send self-heal:** after a long idle gap the client no longer trusts a zombie "connected" stream. It reconnects before sending, and a hung prompt times out so "Sending message" cannot stick forever.

## [1.16.139-beta.1] - 2026-08-15

- **Sync messages:** desktop session right-click and the mobile overflow Refresh now force an authoritative OpenCode tail. Success replaces the visible transcript; failure keeps the previous messages. Busy or retrying sessions disable the action so a live turn is not interrupted.

## [1.16.132] - 2026-08-14

- **Transcript echo:** SSE `message.updated` and optimistic merges locate rows by conversation order, not id binary-search. A completed turn keeps its finish/body on the live last assistant, and a just-sent user message is not duplicated while "Sending message..." stays pinned.
- **Conversation order on send:** idle/Query insert-only and optimistic queue inserts no longer re-sort the transcript by message id. A just-sent or queued user turn stays at the tail.
- **Transcript tail:** a lagging idle/Query snapshot no longer replaces the live last turn. Same-length or collapsed tail refreshes merge insert-only, and idle materialize drops the page if SSE moved while it was in flight.
- **Chat Activity auto-collapse:** insert-only idle/Query merges now copy missing `finish` / `time.completed` / `error` onto the live last assistant, so a completed turn can fold after the final body is visible.
- **Background idle settle:** a session that finishes off-screen is refreshed with the completed snapshot when you switch back, so reasoning can collapse and the final conclusion appears without restarting the app.
- **Provider/agent catalog:** new draft and project switch reuse the already-loaded global Agent and Provider lists. Composer no longer clears agents or waits on a per-project fetch; last selected agent+model ID stays per project. `listAgents` has a 12s timeout with merged abort signals, and startup catalog recovery stays single-flight across directory changes.
- **Session todos:** after opening a session, fill the todo list from the latest loaded `todowrite`/`todoread` in the transcript when live `todo.updated` never arrived.
- **Mobile Projects canvas:** share one page-background token between the app shell and tabs root, and keep the floating shell as a clip frame so short project lists no longer seam into plain `--background`.
- **Sidebar contrast:** lift session-sidebar ink in dark mode so labels stay readable on charcoal / vibrancy surfaces.
- **Mobile/Android pairing QR:** Google scan still runs first on devices with Play Services; if it fails to start, fall back to the bundled CameraX scanner so phones without GMS can pair. Old WebViews that misread `openchamber://` pairing links now parse the scanned string directly.

## [1.16.132-beta.8] - 2026-08-14

- **Transcript echo:** SSE `message.updated` and optimistic merges locate rows by conversation order, not id binary-search. A completed turn keeps its finish/body on the live last assistant, and a just-sent user message is not duplicated while "Sending message..." stays pinned.
- **Background idle settle:** a session that finishes off-screen is refreshed with the completed snapshot when you switch back, so reasoning can collapse and the final conclusion appears without restarting the app.

## [1.16.132-beta.7] - 2026-08-14

- **Provider/agent catalog:** new draft and project switch immediately reuse the already-loaded global Agent and Provider lists. Composer no longer clears agents or waits on a per-project fetch; last selected agent+model ID stays per project. Project-only agents remain rare and arrive later via force-refresh or Agents settings.

## [1.16.132-beta.6] - 2026-08-14

- **Conversation order on send:** idle/Query insert-only and optimistic queue inserts no longer re-sort the transcript by message id. A just-sent or queued user turn stays at the tail instead of disappearing into the middle of history.

## [1.16.132-beta.5] - 2026-08-14

- **Chat Activity auto-collapse:** insert-only idle/Query merges now copy missing `finish` / `time.completed` / `error` onto the live last assistant, so a completed turn can fold after the final body is visible. Lagging snapshots still cannot replace extra live messages or strip terminal fields already present.

## [1.16.132-beta.4] - 2026-08-14

- **Mobile Projects canvas:** share one page-background token between the app shell and tabs root, and keep the floating shell as a clip frame so short project lists no longer seam into plain `--background`.
- **Provider/agent catalog:** give `listAgents` a 12s timeout with merged abort signals, clear loading flags by per-directory load epoch, and keep startup catalog recovery single-flight across directory changes.

## [1.16.132-beta.3] - 2026-08-14

- **Transcript tail:** a lagging idle/Query snapshot no longer replaces the live last turn. Same-length or collapsed tail refreshes merge insert-only, and idle materialize drops the page if SSE moved while it was in flight.
- **Sidebar contrast:** lift session-sidebar ink in dark mode so labels stay readable on charcoal / vibrancy surfaces.

## [1.16.132-beta.2] - 2026-08-14

- **Session todos:** after opening a session, fill the todo list from the latest loaded `todowrite`/`todoread` in the transcript when live `todo.updated` never arrived. Typical on mobile when the write happened on another device. No extra request.

## [1.16.132-beta.1] - 2026-08-14

- **Mobile/Android pairing QR:** Google scan still runs first on devices with Play Services; if it fails to start, fall back to the bundled CameraX scanner so phones without GMS can pair. Old WebViews that misread `openchamber://` pairing links now parse the scanned string directly.

## [1.16.131] - 2026-08-14

- **Markdown code line numbers:** size gutters from wrapped layout height so mobile line wrap no longer desyncs numbers from the code.
- **Relay send:** if the event pipeline is down but the E2EE tunnel is connected, skip the nested OpenCode health probe so send no longer fails with `Connection lost (health probe unhealthy)`.
- **Relay event-stream ready:** wait up to 8s for the WebSocket to become ready (LAN stays 2s); Host `/api/opencode/health` nested fetch now times out at 4s.
- **Provider catalog:** one global cache per transport. New project / new-draft no longer force-refreshes the model list; only last selected model ID stays per project.
- **Conversation order:** revert visibility, the revert dock, and user-message history compare position by `messageOrder`, not lexicographic message ids.
- **Chat LaTeX:** render Pandoc-style `$...$` inline math with currency-safe pairing so `$I_m$` becomes KaTeX while `$50` / `US$ 680` stay money.
- **Retry overlay:** live session activity and expired retry backoff promote `retry` → `busy` so a resumed turn does not keep the retry overlay pinned.

## [1.16.131-beta.3] - 2026-08-14

- **Markdown code line numbers:** size gutters from wrapped layout height so mobile line wrap no longer desyncs numbers from the code.

## [1.16.131-beta.2] - 2026-08-13

- **Relay send:** if the event pipeline is down but the E2EE tunnel is connected, skip the nested OpenCode health probe so send no longer fails with `Connection lost (health probe unhealthy)`.
- **Relay event-stream ready:** wait up to 8s for the WebSocket to become ready (LAN stays 2s); Host `/api/opencode/health` nested fetch now times out at 4s.
- **Provider catalog:** one global cache per transport. New project / new-draft no longer force-refreshes the model list; only last selected model ID stays per project.
- **Conversation order:** revert visibility, the revert dock, and user-message history compare position by `messageOrder`, not lexicographic message ids.

## [1.16.131-beta.1] - 2026-08-13

- **Chat LaTeX:** render Pandoc-style `$...$` inline math with currency-safe pairing so `$I_m$` becomes KaTeX while `$50` / `US$ 680` stay money.
- **Retry overlay:** live session activity and expired retry backoff promote `retry` → `busy` so a resumed turn does not keep the retry overlay pinned.

## [1.16.130] - 2026-08-13

- **Android 12 launch crash:** move `OnBackAnimationCallback` / `OnBackInvokedCallback` out of `OpenChamberNavigationPlugin` into SDK-gated support classes so registering the plugin no longer class-loads Android 13/14-only `android.window.*` types on older devices.

## [1.16.130-beta.1] - 2026-08-13

- **Android 12 launch crash:** move `OnBackAnimationCallback` / `OnBackInvokedCallback` out of `OpenChamberNavigationPlugin` into SDK-gated support classes so registering the plugin no longer class-loads Android 13/14-only `android.window.*` types on older devices.

## [1.16.129] - 2026-08-12

- **Android package identity:** change release `applicationId` to `com.yee94.openchamber` (debug: `com.yee94.openchamber.debug`) so the fork no longer collides with upstream `com.openchamber.app` installs that use a different signing key. Uninstall any older `com.openchamber.app` build before installing this APK.
- **Windows: agent turns end reliably.** An agent turn no longer leaves the composer stuck in a busy state: benign durable-sync replica frames no longer tear down the WebSocket stream, a single unreadable frame can no longer wedge reconnect resume, and directory spellings that differ by drive-letter case or separators converge on the same session store so `session.idle` always reaches the composer.
- **Windows: queued follow-ups are admitted again.** Queue admission, ledger keys, chip scope matching, and server-queue scope lookup now address the canonical directory, so one project resolves to one queue whichever win32/canonical spelling a caller holds.
- **Path normalization hardening:** directory identity keys now canonicalize Windows drive-letter case and separator spellings, and read-only session status hooks no longer provision a directory store on a miss.
- **Sidebar session hover card:** let the session title wrap to multiple lines so the full name stays readable instead of truncating with an ellipsis.
- **Sorted chat final-body streaming:** in “Sorted” / “整理后显示” mode, intermediate tool and reasoning work still lands in Activity; only the terminal final-conclusion body reveals and streams once the assistant reaches the no-continuation / finish absent-or-`stop` shape.
- **Context Panel subagent transcript after focus:** Sorted + collapsed Activity no longer blanks an open Context Panel chat when the window refocuses. Null-anchor (subtask/synthetic) reconnect refresh uses non-destructive `ensureInitial` instead of wiping the transcript; the panel’s open session stays in the compensation viewed set across blur; an empty open surface force-ensures on focus.
- **i18n:** clarify Sorted-mode descriptions across locales so the setting matches the final-body-only streaming behavior.

## [1.16.129-beta.6] - 2026-08-12

- **Context Panel subagent transcript after focus:** Sorted + collapsed Activity no longer blanks an open Context Panel chat when the window refocuses. Null-anchor (subtask/synthetic) reconnect refresh uses non-destructive `ensureInitial` instead of wiping the transcript; the panel’s open session stays in the compensation viewed set across blur; an empty open surface force-ensures on focus.

## [1.16.129-beta.5] - 2026-08-12

- **Sorted chat final-body streaming:** in “Sorted” / “整理后显示” mode, intermediate tool and reasoning work still lands in Activity; only the terminal final-conclusion body reveals and streams once the assistant reaches the no-continuation / finish absent-or-`stop` shape.
- **i18n:** clarify Sorted-mode descriptions across locales so the setting matches the final-body-only streaming behavior.

## [1.16.129-beta.4] - 2026-08-12

- **Windows: queued follow-ups are admitted again.** Outgoing requests carry a canonicalized directory while session payloads come back in the win32 spelling, so queue admission compared two spellings of the same directory, judged every attempt stale, and handed the message back to the composer. Admission, the queue ledger key, chip scope matching, and server-queue scope lookup now address the canonical directory, so one project resolves to one queue whichever spelling a caller holds.

## [1.16.129-beta.3] - 2026-08-12

- **Windows: agent turns end reliably.** An agent turn no longer leaves the composer stuck in a busy state: benign durable-sync replica frames no longer tear down the WebSocket stream, a single unreadable frame can no longer wedge reconnect resume, and directory spellings that differ by drive-letter case or separators converge on the same session store so `session.idle` always reaches the composer.
- **Path normalization hardening:** directory identity keys now canonicalize Windows drive-letter case and separator spellings, and read-only session status hooks no longer provision a directory store on a miss.

## [1.16.129-beta.2] - 2026-08-12

- **Sidebar session hover card:** let the session title wrap to multiple lines so the full name stays readable instead of truncating with an ellipsis.

## [1.16.129-beta.1] - 2026-08-12

- **Android package identity:** change release `applicationId` to `com.yee94.openchamber` (debug: `com.yee94.openchamber.debug`) so the fork no longer collides with upstream `com.openchamber.app` installs that use a different signing key. Uninstall any older `com.openchamber.app` build before installing this APK.

## [1.16.128] - 2026-08-12

- **Desktop multi-window appearance isolation:** scope sidebar brand and theme localStorage by runtime transport so a packaged local window and a remote-host window no longer share logo/theme prefs; delay theme server write-back until settings hydrate so remote hosts are not polluted with local defaults.
- **Relay event-stream stability:** serialize host-side WebSocket outbound fragments so large frames no longer interleave and corrupt JSON over the tunnel.
- **Event pipeline recovery:** treat invalid WS frames (JSON parse, bad type, non-normalizable event payload) as transport faults; keep the last good event id, reconnect with compensation, and prefer SSE fallback in auto mode without postponing heartbeat recovery.
- **Diff summary over the wire:** Host outbound `session.diff` and message/session `summary.diffs` now ship preview fields only (`file` / `status` / `additions` / `deletions`); full patch bodies are stripped before fan-out and replay.
- **Client store sanitization:** summarize `session.diff` and message summary diffs on ingest so large patch/before/after blobs never enter live stores.
- **Turn Diff on demand:** DiffView turn scope loads full patches via `GET /session/{id}/diff` when expanding a turn, merges them with summary stats, keeps tool-patch paths inline, and surfaces load failure with retry while preserving the summary file list.
- **Update button polish:** sidebar update button is now a compact solid theme-color circle (24px, no translucent tint); in-progress buttons in the update dialog use a solid primary fill instead of a semi-transparent one.

## [1.16.128-beta.2] - 2026-08-12

- **Desktop multi-window appearance isolation:** scope sidebar brand and theme localStorage by runtime transport so a packaged local window and a remote-host window no longer share logo/theme prefs; delay theme server write-back until settings hydrate so remote hosts are not polluted with local defaults.

## [1.16.128-beta.1] - 2026-08-12

- **Relay event-stream stability:** serialize host-side WebSocket outbound fragments so large frames no longer interleave and corrupt JSON over the tunnel.
- **Event pipeline recovery:** treat invalid WS frames (JSON parse, bad type, non-normalizable event payload) as transport faults; keep the last good event id, reconnect with compensation, and prefer SSE fallback in auto mode without postponing heartbeat recovery.
- **Diff summary over the wire:** Host outbound `session.diff` and message/session `summary.diffs` now ship preview fields only (`file` / `status` / `additions` / `deletions`); full patch bodies are stripped before fan-out and replay.
- **Client store sanitization:** summarize `session.diff` and message summary diffs on ingest so large patch/before/after blobs never enter live stores.
- **Turn Diff on demand:** DiffView turn scope loads full patches via `GET /session/{id}/diff` when expanding a turn, merges them with summary stats, keeps tool-patch paths inline, and surfaces load failure with retry while preserving the summary file list.

## [1.16.127-beta.6] - 2026-08-11

- **File preview JSON/JSONC:** remove the JSON tree viewer from sidebar and mobile file preview; `.json` / `.jsonc` files now always open in the standard editor.
- **Tool JSON output:** drop the summary/item JSON view in shell and tool results; keep only the collapsible tree viewer (default) and raw JSON toggle.

## [1.16.127] - 2026-08-11

- **Assistant transcript loading:** materialize each active Assistant binding through the shared transcript repository, so current OpenCode messages load immediately and historical pagination continues through the standard conversation timeline.
- **Desktop language consistency:** localize native application menus, dock actions, and tray controls with the selected UI language; refresh their labels when the language changes.
- **Windows title bar:** use an opaque theme surface for Windows chrome and window controls.
- **Windows file references:** normalize drive-letter and UNC paths with `pathe`, preserving absolute roots and generating valid `file://` URLs for referenced files and folders.
- **Language recovery:** return the active locale state to the default language when a translation dictionary fails to load.

## [1.16.126] - 2026-08-11

- **Message edit while busy:** keep the editing state, abort then wait for session idle before deleting the old tail, then send the replacement (fixes OpenCode 409 Session is busy).
- **Cold-start Provider catalog recovery:** force-refresh empty Provider/Agent catalogs after a successful temporary empty warm load (`staleTime: Infinity`), with store-level single-flight and a shared `useStartupCatalogRecovery` poll (`useInterval`, bounded attempts) on web, mobile, and mini-chat; VS Code bootstrap uses the same store action.
- **Desktop new window black screen fix:** remove `setVisualZoomLevelLimits(-3, 5)` which broke the macOS compositor surface (0×0 layout viewport, fully opaque/blank paint) on Electron 41 additional windows; first window only survived because splash → app navigation reset the broken state.
- **Desktop window boot reliability:** per-key init-script assignment so contextBridge read-only globals no longer abort boot-outcome injection (fixes New Window / re-shown windows stuck on splash); boot outcome pushed through preload for host switches.
- **Desktop single-main-window semantics:** app-level broadcasts (deep links, notification clicks, updater/SSH/installed-apps events, system resume) now route to the main window only; closing the main window promotes the next surviving primary window in creation order.
- **electron:dev environment isolation:** strip production/preview `OPENCHAMBER_*` / `OPENCODE_*` env leakage (UI password, dist dir, runtime flags) from HMR children so dev API no longer 401s.
- **Desktop menu/dock:** New Window accelerator restored to Cmd/Ctrl+Shift+N, New Worktree entry removed, "Add Workspace" → "Add Project", and a dock menu (New Window / New Session / New Mini Chat).
- **File mention autocomplete:** move state derivation into a focused `fileMentionAutocompleteState.ts` module with tests.
- **Desktop host switch:** extract desktop host switch mutation/query helpers with tests.
- **Markdown list styling:** use native disc/decimal outside markers with theme-primary colored `::marker` (no faded en-dash pseudo-bullets); compact list item spacing aligned with agent-tracker prose rhythm. Body line-height stays `1.625`.

## [1.16.125] - 2026-08-10

- **Scheduled history mobile cards:** whole-card open with the shared soft press surface (no trailing open-session button); compact datetime and status chrome; time/trigger meta no longer ellipsized; error text uses an inline warning glyph that stays on the first line and wraps only at the trailing edge.
- **Scheduled History spacing:** match Tasks list card gap and a single `--oc-mobile-page-gap` under the tab switcher (no stacked tablist margin + content padding).
- **Runtime identity switch routing:** always rewrite the browser path to the restored session (or clear it); re-parse route state after identity switch so deep-link reconcile cannot toast or re-pin a previous-runtime session id; clear a previous-runtime `/session/…` path when restore has no matching session.
- **Deep-link failure toast:** toast `missing-directory` only once per dead session id for the mount lifetime; index refresh no longer spams.
- **Mobile settings search alignment:** use the shared `--oc-mobile-page-gap` between the collapsing header and settings search so the search field lines up with other root tab first content.

## [1.16.125-beta.6] - 2026-08-10

- **Scheduled history error row:** render the warning glyph as an inline icon with the message so it stays on the first line and only wraps at the trailing edge.

## [1.16.125-beta.5] - 2026-08-09

- **Scheduled history error row:** keep the warning icon inline with the message (line-clamp only on the text), and match History card spacing to the Tasks list on mobile tab.

## [1.16.125-beta.4] - 2026-08-09

- **Scheduled History spacing:** align mobile-tab History list offset with Tasks using a single `--oc-mobile-page-gap` (no stacked tablist margin + content padding).
- **Runtime identity switch routing:** always rewrite the browser path to the restored session (or clear it); re-parse route state after identity switch so deep-link reconcile cannot toast or re-pin a previous-runtime session id.

## [1.16.125-beta.3] - 2026-08-09

- **Scheduled history mobile cards:** open the run session from the whole card with the shared soft press surface; drop the trailing open-session button on mobile so meta stays readable.

## [1.16.125-beta.2] - 2026-08-09

- **Runtime switch path cleanup:** after a runtime identity switch, clear a previous-runtime `/session/…` path when restore has no matching session so deep-link resolve and missing-directory toasts do not re-fire.
- **Deep-link failure toast:** toast `missing-directory` only once per dead session id for the mount lifetime; index refresh no longer spams.
- **Scheduled history mobile cards:** compact datetime, smaller status chrome, stack time/trigger meta so they are not ellipsized beside open-session, and allow longer error text with better wrapping.

## [1.16.125-beta.1] - 2026-08-09

- **Mobile settings search alignment:** use the shared `--oc-mobile-page-gap` between the collapsing header and settings search so the search field lines up with other root tab first content.

## [1.16.124] - 2026-08-09

- **Path-mode app router:** replace query-param routing with history paths and exclusive primary surfaces (session / plan / schedule / assistant / settings); add session deep-link directory lookup, visible open failures, and sidebar reveal for focused sessions already in the loaded list.
- **New-session path:** canonicalize the draft surface as `/session/new` (with `/new` alias), wire router + session UI store so opening a draft owns the URL and does not re-open a previous session.
- **Sidebar visibility performance:** gate desktop/mobile sidebars with `isVisible` so off-screen surfaces unmount the session row tree and stop live aggregates, sticky headers, PR enrichment, and related speculative work while keeping the shell mounted for instant reopen.
- **Session index stability:** ignore pure `time.updated` churn in global upsert/live-list equivalence so ownership memos do not rebuild on every streaming tick; soften directory child-store eviction with a grace window to avoid thrashing multi-worktree expands.
- **Mobile collapsing headers:** keep sticky layout height constant and drive collapse with compositor-only `transform`/`opacity` (plus a static in-flow spacer) so scroll no longer feedback-bounces; scale titles top-left, preserve expanded top inset, and keep a comfortable compact edge inset on Android.
- **Mobile root headers:** collapse large tab titles on scroll with reduced-motion fallback; align read-only prompt banners with the solid mobile foot / safe-area treatment.
- **Mobile Projects worktrees:** add long-press actions and left-swipe New session / Delete rails on worktree headers (session-row parity), plus container wiring for worktree action sheets and delete.
- **Segmented selected chrome:** shared `.oc-segmented-selected-pill` in the design system — light elevated paper + soft shadow (no border ring), dark selection-token fill — used by scheduled Tasks/History, filter chips, and SortableTabsStrip active pills.
- **Mobile scheduled segmented controls:** share pad/gap/item-height metrics across Tasks/History and All/Active/Paused (+ create); derive concentric inner radius from surface radius minus pad; keep selected pills vertically centered and align trailing create action height.
- **Android floating glass:** remove the Capacitor Android opaque-fill override so mobile floating surfaces, dock, and glass controls keep the same translucent + backdrop-filter recipe as iOS; reduced-transparency remains the accessibility fallback.
- **Settings theme mode chips:** keep theme-mode options on one row (`flex-nowrap` + `shrink-0`) and shorten the Chinese system-follow label for dense mobile layout.

## [1.16.124-beta.6] - 2026-08-09

- **Mobile segmented radii:** derive inner item/pill radius from the track surface radius minus pad so outer and selected corners stay concentric; drop hard-coded inset-radius on scheduled Tasks/History and filter pills.

## [1.16.124-beta.5] - 2026-08-09

- **Mobile scheduled segmented controls:** share pad/gap/item-height metrics across Tasks/History and All/Active/Paused (+ create), keep selected pills vertically centered, and align trailing create action height with segment items.
- **Segmented selected chrome:** light mode keeps elevated fill + soft shadow only (no border ring); dark mode uses selection-token lift without a full outline.

## [1.16.124-beta.4] - 2026-08-09

- **Mobile collapsing headers:** keep sticky layout height constant and drive collapse with compositor-only `transform`/`opacity` (plus a static in-flow spacer) so scroll no longer feedback-bounces; scale titles top-left, preserve expanded top inset, and keep a comfortable compact edge inset on Android.
- **New-session path:** canonicalize the draft surface as `/session/new` (with `/new` alias), wire router + session UI store so opening a draft owns the URL and does not re-open a previous session.

## [1.16.124-beta.3] - 2026-08-09

- **Mobile collapsing headers:** interpolate expanded root title padding (`safe-area + 1rem + legacy pt-1.5`) down to detail-nav compact chrome, drop the forced min-height, and keep the header as the sole owner of top safe-area spacing.

## [1.16.124-beta.2] - 2026-08-09

- **Path-mode app router:** replace query-param routing with history paths and exclusive primary surfaces (session / plan / schedule / assistant / settings); add session deep-link directory lookup, visible open failures, and sidebar reveal for focused sessions already in the loaded list.
- **Sidebar visibility performance:** gate desktop/mobile sidebars with `isVisible` so off-screen surfaces unmount the session row tree and stop live aggregates, sticky headers, PR enrichment, and related speculative work while keeping the shell mounted for instant reopen.
- **Session index stability:** ignore pure `time.updated` churn in global upsert/live-list equivalence so ownership memos do not rebuild on every streaming tick; soften directory child-store eviction with a grace window to avoid thrashing multi-worktree expands.
- **Mobile Projects worktrees:** add long-press actions and left-swipe New session / Delete rails on worktree headers (session-row parity), plus container wiring for worktree action sheets and delete.
- **Mobile root headers:** collapse large tab titles on scroll with reduced-motion fallback; align read-only prompt banners with the solid mobile foot / safe-area treatment.

## [1.16.124-beta.1] - 2026-08-08

- **Segmented selected chrome:** add shared `.oc-segmented-selected-pill` in the design system — light elevated paper, dark selection-token fill — and use it for scheduled Tasks/History, filter chips, and SortableTabsStrip active pills so dark mode contrast is theme-owned, not feature-local.
- **Android floating glass:** remove the Capacitor Android opaque-fill override so mobile floating surfaces, dock, and glass controls keep the same translucent + backdrop-filter recipe as iOS; reduced-transparency remains the accessibility fallback.
- **Settings theme mode chips:** keep theme-mode options on one row (`flex-nowrap` + `shrink-0`) and shorten the Chinese system-follow label for dense mobile layout.

## [1.16.123] - 2026-08-08

- **Transcript repository:** move session messages, parts, pagination, optimistic updates, and live revisions behind one QueryCache-backed transcript store shared by chat, context, assistants, and runtime consumers.
- **Reconnect recovery:** signed Host reconciliation continuations, replay-before-ready compensation, generation isolation, bounded destructive reset, and stale-response merge rules that preserve newer live content.
- **Live tool details:** preserve tool part state changes through the transcript cache so Read paths, shell commands, output, metadata, and completion update in the active conversation without switching sessions.
- **History stability:** keep transcript snapshots referentially stable for timeline observers while preserving load-older pagination; rebuild scoped transcript subscriptions when the runtime binding changes so queue auto-send attaches to the new repository registry.
- **Chat stability:** retain a painted conversation while transcript cache data briefly refreshes or reconnects, preserving viewport position, composer focus, and cursor placement.
- **Cache and performance:** runtime-specific transcript LRU limits, narrow SSE observer updates to the changed message, and deterministic coverage for long-gap recovery plus high-volume event delivery.
- **Chat layout:** keep desktop user-message spacing consistent when sticky headers are disabled.
- **Mobile scheduled tasks:** scroll through the root phone tabpanel without a nested scrollbar; keep Tasks/History backgrounds aligned with Projects; unify history cards on floating surface material; keep the original elevated selected pill (fill + soft shadow) when switching views via a sliding indicator.
- **Test suite:** restore query/store tests blocked by incomplete `runtime-switch` mocks, port stale transcript reducer coverage, and realign contract tests with queue ledger semantics and moved pagination helpers.

## [1.16.123-beta.6] - 2026-08-08

- **Mobile scheduled tasks:** keep the Tasks / History selected pill elevation (white fill + soft shadow) when switching views, using a sliding elevated indicator instead of remounting button chrome.

## [1.16.123-beta.5] - 2026-08-08

- **Mobile scheduled tasks:** let the plan tab scroll through the root phone tabpanel (no nested scrollbar), keep task/history backgrounds aligned with Projects, and unify history cards on the floating surface material.

## [1.16.123-beta.4] - 2026-08-07

- **Chat stability:** retain a painted conversation while transcript cache data briefly refreshes or reconnects, preserving the viewport position, composer focus, and cursor placement.

## [1.16.123-beta.3] - 2026-08-06

- **Transcript observers:** rebuild scoped transcript subscriptions when the runtime binding changes so queued auto-send and other scope listeners attach to the new repository registry instead of a stale child-store map.
- **Test suite:** restore query and store tests blocked by incomplete `runtime-switch` mocks, port stale transcript reducer coverage to the current API, and realign contract tests with queue ledger semantics and moved pagination helpers; full `packages/ui` isolate suite is green again.

## [1.16.123-beta.2] - 2026-08-06

- **Live tool details:** preserve tool part state changes through the transcript cache so Read paths, shell commands, output, metadata, and completion state update in the active conversation without switching sessions or refreshing.
- **Chat layout:** keep desktop user-message spacing consistent when sticky headers are disabled.

## [1.16.123-beta.1] - 2026-08-06

- **Transcript state:** move session messages, parts, pagination, optimistic updates, and live revisions behind one QueryCache-backed transcript repository shared by chat, context, assistants, and runtime consumers.
- **Reconnect recovery:** add signed Host reconciliation continuations, replay-before-ready compensation, generation isolation, bounded destructive reset, and stale-response merge rules that preserve newer live content.
- **History stability:** keep transcript snapshots referentially stable for timeline observers, preventing historical conversations from entering repeated render updates while preserving load-older pagination.
- **Cache and performance:** apply runtime-specific transcript LRU limits, narrow SSE observer updates to the changed message, and cover long-gap recovery plus high-volume event delivery with deterministic runtime tests.

## [1.16.122] - 2026-08-06

- **Assistant turn completion:** align live, cached, and historical turns with OpenCode 1.18.4 run-loop semantics; ordinary tool calls remain continuation work until the terminal final answer, keeping Activity expanded between steps and eliminating the final tool/body flicker.
- **History pagination:** make each directory child store the authoritative load-older boundary, commit transcript pages and pagination state atomically, reject stalled or malformed cursors, preserve retry feedback, and settle native fetches with a hard timeout while concurrent page loads finish.
- **Reconnect and cache recovery:** generation-gate prefetch and materialization commits, invalidate transcript freshness after real reconnects or transport switches, recover the viewed conversation immediately, and wake SSE retries when the OS resumes the app.
- **Mobile load-older experience:** allow explicit pagination while background prefetch is pending, preserve the first visible message across virtualized prepends, and hide the control after an authoritative no-growth page.
- **Runtime requests:** route OpenCode V2 active-session checks through the runtime origin so the SDK emits `/api/session/active` exactly once; browser diagnostics now include failed runtime request status and call stacks.
- **Presentation:** strengthen desktop sidebar vibrancy and refine assistant TPS labels across supported languages.

## [1.16.122-beta.4] - 2026-08-06

- **History pagination:** settle native fetches with a hard timeout, wait through concurrent page loads, hide the load-older control after an authoritative no-growth page, and preserve retry feedback for transport failures.
- **Runtime requests:** route OpenCode V2 active-session checks through the runtime origin so the SDK emits `/api/session/active` exactly once; browser diagnostics now include failed runtime request status and call stacks.
- **Chat activity:** refine assistant TPS presentation and localized labels across supported languages.

## [1.16.122-beta.3] - 2026-08-06

- **Mobile history pagination:** allow an explicit “Load older messages” action to start while a background transcript prefetch is pending, preventing the stale prefetch lifecycle from blocking the request and showing a retry error without issuing a page fetch.

## [1.16.122-beta.2] - 2026-08-06

- **Mobile reconnect recovery:** invalidate cached transcript freshness after real stream reconnects and transport switches, recover the viewed conversation immediately, and refresh other cached conversations on their next visit so messages missed while the app was backgrounded appear without restarting.
- **Event stream resume:** wake SSE retry backoff immediately when the OS resumes the app, including reconnect attempts already sleeping in the long hidden/offline delay.
- **Desktop sidebar glass:** increase native blur visibility through the sidebar surface for a stronger vibrancy treatment.

## [1.16.122-beta.1] - 2026-08-06

- **Assistant turn completion:** align live, cached, and historical turns with OpenCode 1.18.4 run-loop semantics; ordinary tool calls remain continuation work until the model sends a terminal final answer, keeping Activity expanded between steps and preventing the final tool/body three-frame flicker.
- **History pagination:** make each directory child store the authoritative load-older boundary, commit transcript pages and pagination state atomically, reject stalled or malformed cursors, and retain the last known boundary through refresh failures.
- **Reconnect and cache safety:** generation-gate prefetch and materialization commits, share same-flight responses across provider remounts, and clear pagination boundaries with session eviction so reconnects and cross-directory sessions converge on the current transcript.

## [1.16.121] - 2026-08-05

- **Save image:** long-press or context-menu on chat images (markdown, attachments, fullscreen viewer) opens save actions; desktop downloads, mobile saves to Photos via a native media plugin, with runtime-file streams and preview-prefetch so save does not re-hit the host path.
- **Session catalog isolation:** subagent/child sessions never promote to sidebar roots when the parent is missing, archived, or system-owned; scheduled-task children stay out of the project list.
- **Live session caches:** hiding system, subagent, or archived sessions from the directory list no longer drops their message stream — only temporary SmartFetch secondaries wipe caches on leave.
- **Mobile back navigation:** defer history cleanup so React Strict Mode remounts and short-lived overlays (e.g. image preview) no longer pop the chat underlay.
- **Image viewer:** mobile back route, open-close guard against accidental dismiss, and long-press save from the fullscreen preview.

## [1.16.120] - 2026-08-05

- **Chat multi-step stability:** keep the live turn expanded between tool steps, settle completion only when both turn projection and session status agree work is done, and stop treating premature `time.completed` as a finished turn so nested tools no longer fold/flash mid-loop.
- **Display part monotonicity:** while an assistant turn is still open, union lagging HTTP/SSE part frames so already-painted tool rows cannot disappear for a frame; the same merge applies to the streaming tail.
- **Tool expansion:** render expanded tool bodies synchronously so virtualized rows measure real height on first paint instead of lurching a frame later.
- **Composer slash chips:** insert durable reserved-slot chips for non-built-in OpenCode commands without a leading auto-space, match command names case-insensitively, and align message reference chip metrics with the composer trigger well.
- **Scroll prepend tracking:** avoid reading `scrollHeight` on every append; measure only when prepend compensation needs a height delta.

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
