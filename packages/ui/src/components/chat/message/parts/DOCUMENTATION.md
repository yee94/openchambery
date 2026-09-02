# Chat Message Parts: Rendering Architecture

Sorted compaction Activity uses localized Compacting / Compaction complete labels, a dedicated `fold-vertical` icon, and the same geometry, typography, info-token shimmer, and duration formatter as ordinary Activity. `/compact` is hidden as a user bubble at view-layer parse time; the compact turn still owns Activity so the previous assistant stream does not remount. The bottom working hint uses `chat.assistantStatus.compacting` while that last user command is compact and the session is working, so leftover previous-turn tools cannot paint Editing file. Before any assistant message arrives, `TurnItem` renders the standard Activity disclosure (`shouldShowCompactionStatus`): settled without assistants still shows; active Compacting only when the turn is last and the session is authoritatively working. The toggle stays available before foldable content arrives and preserves the user's state for the incoming summary body. Once assistants exist, `MessageBody` always mounts the Activity disclosure on the owner message (even with zero tool/reasoning segments). Summary body text is hidden while the turn is collapsed and restored when expanded — including while the summary is still streaming (`finish` not yet `stop`). Ordinary sorted turns still defer non-stop inline text so intermediate stream text does not paint outside Activity; expanded compaction is the exception because that stream *is* the foldable body. Reasoning projected into Activity continues to follow the disclosure expansion and `showReasoningTraces`. Header-only disclosures with empty activity rows still paint the chrome so the toggle stays available. Live mode keeps its current rendering.

This folder contains renderers for chat message parts (text, tools, reasoning, placeholders) and shared tool presentation helpers.

Use this doc when you ask an agent to change tool/header/description behavior.

## High-level flow

- Message parts are rendered from `MessageBody.tsx`.
- There are four tool rendering paths:
  - **Context exploration tools** (`read` / `glob` / `grep` / `list`) -> consecutive runs collapse into `ContextToolGroup` ("Exploring" / "Explored N searches, N reads"), with each call as a `StaticToolRow` child when expanded
  - **Skill tools** (`skill`) -> consecutive calls collapse into `SkillToolGroup` ("Load Skill" plus original names on one line, including a lone skill so later names can flip-animate)
  - **Other static tools** -> single `StaticToolRow` in `ProgressiveGroup.tsx` (no consecutive merge)
  - **Expandable tools** (including bash/shell) -> `ToolPart.tsx`
- Shared tool icon mapping is centralized in `toolPresentation.tsx` (`getToolIcon`).

## Which file controls what

- `ProgressiveGroup.tsx`
  - Renders grouped Activity rows, context-tool Explored groups, consecutive Skill groups, and single-call static tools.
  - Contains `StaticToolRow`.
  - Contains static tool short description logic (`getToolShortDescription`).
  - Consecutive `read` / `glob` / `grep` / `list` collapse into `tool-context-group` rows
    via `collectConsecutiveContextTools` + `isContextGroupTool` before standalone/expandable/static checks.
  - Consecutive `skill` calls collapse into `tool-skill-group` rows via
    `collectConsecutiveSkillTools` + `isSkillGroupTool`. A lone skill still uses the group header so adding the next name can flip-animate.
  - Live Activity headers use S1 `LatticeOrb`; settled headers keep `stack` / `fold-vertical`.
  - While `completionDisposition === 'active'`, the Activity disclosure is locked open:
    no collapse chevron/toggle, and the indent rail (`ml-2 pl-3` + connector line) is
    omitted so in-flight rows do not jump horizontally when the turn settles.
  - Live non-compaction with zero activity rows renders nothing (header stays hidden
    until the first tool/reasoning/justification row exists). Compaction still keeps
    its header-only chrome so the foldable summary body has an anchor.
  - Collapsed Activity hides Explored / Thought rows with the rest of the timeline.
  - Nested row React keys and expand-state ids are the projected activity id
    (`resolveActivityPartId`, i.e. `part.id` for anything the server sent).
  - Row mounting depends **only** on the disclosure (`!showHeader || effectivelyExpanded ||
    previewCount > 0`, where `effectivelyExpanded` forces open while live). It must not
    consult `completionDisposition` or `streamPhase` beyond that lock: a settled-turn
    branch keyed on "was live" never released for aborted turns, and a one-frame
    disposition flap unmounted every nested row. Structural stability against
    regressing store frames belongs to `@/sync/displayParts`, not to this component.
  - If you want to change how individual `read`/`skill` compact rows look inside or outside a group, edit `StaticToolRow` here.
  - Every visible static call uses the shared tool lifecycle: a 14px desktop / 12px mobile `LatticeOrb` stays in the fixed 14px desktop / 16px mobile leading slot until status or valid end timing proves settlement, then the mapped tool icon returns. Its 3×3 grid optically spans about 12px on desktop and 10.3px on mobile; the mobile slot centers the lighter orb with 2px of space on each side. Expanded context-group children use this same row.

- `ContextToolGroup.tsx`
  - Collapsible "Exploring" / "Explored" header for consecutive context tools.
  - Receives `children` for the expanded list (do not import `StaticToolRow` here — that would cycle with `ProgressiveGroup`).
  - Active state uses the 14px desktop / 12px mobile S1 `LatticeOrb` in the 14px desktop / 16px mobile leading slot (same orb as streaming Thought in `ReasoningPart`) while any grouped call lacks settlement evidence, or while the turn is still live and no later non-explore part (final text / non-context tool) has appeared. The mobile slot centers the orb. Reasoning between explore calls does not settle the group. Individual child rows still use the shared per-call lifecycle.
  - The fixed leading slot restores the Search icon after every grouped call settles; the disclosure chevron stays in the trailing slot across activity states.
  - While Exploring, the whole count summary flips upward when the counts change. The 20px / 24px line box stays fixed (`min-h-0` so a flex item cannot grow with the moving layers). Nested `overflow: clip` keeps the `translateY` layers inside that box without creating an Android overlay scrollbar thumb.

- `contextToolGrouping.ts`
  - Grouping helpers: `collectConsecutiveContextTools`, `summarizeContextTools`, `isContextToolActive`, count keys for search/read/list summary copy.

- `SkillToolGroup.tsx`
  - Collapsible "Load Skill" header for consecutive skill tools.
  - Summary shows original skill names on one line, comma-separated, at most three names.
  - More than three names append the localized overflow (`{names} and {count} more` / `{names} 等{count}个`).
  - While any grouped call is still active, the summary uses the same `FlipUpText` upward flip as Explored counts.
  - Receives `children` for the expanded list (do not import `StaticToolRow` here — that would cycle with `ProgressiveGroup`).
  - Active state uses the same 14px desktop / 12px mobile `LatticeOrb` in the 14px desktop / 16px mobile leading slot while any grouped call lacks settlement evidence; the mobile slot centers the orb, and the leading slot restores the Book icon after every grouped call settles.

- `skillToolGrouping.ts`
  - Grouping helpers: `collectConsecutiveSkillTools`, `getSkillNameFromToolPart`, `summarizeSkillNames`, visible-name limit.
  - `getSkillNameFromToolPart` reads `metadata.name`, then `input.name`, then `input.id`, then `output.name`, so published OpenCode (`input.name`), completed metadata, and the unreleased `input.id` schema all display.

- `../../lib/turns/resolveActivityPartId.ts`
  - Stable activity / tool row identity for keys and bash default-open expand state.

- `../../lib/turns/streamingTailEntry.ts`
  - The live tail subscribes to the raw part store so streaming text is not held back by
    snapshot suspension, and applies `mergePartsForDisplay` from `@/sync/displayParts` —
    the same contract the snapshot uses. Both readers of `state.part` therefore agree on
    when a frame may shrink. Views hold nothing of their own across renders.

- `ToolPart.tsx`
  - Renders expandable tool rows (bash/edit/write/question/task + fallback).
  - Controls expandable header title/description/diff stats/timer and expanded output body.
  - Every visible expandable call shows the shared 14px desktop / 12px mobile `LatticeOrb` in the fixed 14px desktop / 16px mobile leading slot while active and keeps its original tool title. The mobile slot centers the orb. Only an unassigned live Task uses the delegating label; after assignment the row keeps `AgentAvatar` plus the agent nickname. Settled rows never keep the delegating label. The row opens the child session when a session id is present.
  - Expandable rows keep their chevron in the trailing slot, so hover and expansion preserve the lifecycle indicator. Task shows that chevron when Settings → Visual → "Show Sub-agent Work Details" (`showSubagentTaskDetails`) is on.
  - That setting defaults **off**: no vertical task-summary rail. Clicking the compact row always
    opens the sub-agent session (context panel / mobile session switch), including while the task
    is still loading — if the child session id is delayed, the click is queued until it arrives.
    When details are on, the rail + output expand UI return (expand via the leading chevron), and
    child-session summary fetches run again; the row click still opens the sub-agent.
  - While a task is active, title + description use `animate-text-shimmer` (same loading highlight as
    thinking traces). Subagent names need not appear in the main agent picker — the identicon only
    seeds from the name string.
  - A successful session-status snapshot stops stale task loading when the child session is idle
    or when the task started before the snapshot request. Tasks created after that boundary wait
    for live status. The original tool part remains unchanged for history and diagnostics.
  - Background subagent tasks settle the tool part immediately (tool success with a running hint
    in metadata/output). While the resolved child session status is not `idle`, the settled row
    keeps observing the child and stays in the busy shimmer state. Observation is one-shot
    latched: once an authoritative idle newer than the task start is observed (live entry or
    directory snapshot, same freshness guard as `shouldSuppressTaskLoading`), the row
    unsubscribes and renders as an ordinary settled row. Completion itself is announced by the
    synthetic `<subagent …>` notification message (see `MessageBody.tsx`).
  - Nested task-session navigation delegates to `SessionSurfaceContext`. In an
    ContextPanel transcript, the strict read-only panel surface accepts
    same-directory local navigation and preserves the primary session selection.
  - When About → client diagnostics is on, each Task row records `feat: task`
    events through the shared diagnostics hub (`task-row` on identity/status
    change, `task-click` on row click or queued open). Events keep session/part
    identities and loading/click facts only — never titles, prompts, or agent
    names. Recording is silent when the switch is off.
  - If you want to change expandable tool layout, edit here.

- `taskToolModel.ts`
  - Owns Task metadata parsing and child-session summary projection.
  - `part.state.metadata.sessionId` is the only live identity contract between a Task and its child session.
  - A running Task may briefly have no `sessionId`; render it as waiting until the authoritative part update arrives. Never match parallel children by order, title, timestamp, or status.
  - Part-level metadata and output parsing exist only for older persisted records and never override state metadata.
  - `readTaskStatusFromRecord` / `readTaskRunningFromOutput` detect the background-subagent
    running hint (settled output that still says `status: running`).
  - `parseSubagentNotification` parses the synthetic `<subagent sessionID state description>`
    completion notification injected into the parent session; non-matching text returns undefined.

- `toolPresentation.tsx`
  - Shared icon mapping for tool names (`getToolIcon`).
  - Used by both `ProgressiveGroup.tsx` and `ToolPart.tsx`.

- `../../TodoItemRow.tsx`
  - Owns the shared task-row presentation used by the StatusRow task popover and Todo tool output.
  - Keeps status icons, active styling, dividers, responsive type, wrapping, and completed/cancelled treatment aligned.

- `toolRowChrome.ts`
  - Shared Codex-style rounded chip classes for interactive tool / reasoning headers.
  - Hover-only wash matches sidebar session-row hover (`surface-foreground` color-mix); idle rows stay flush.
  - Tight `py-0.5` + `my-1.5` keeps row height compact while spacing tool rows apart; `-mx-2` cancels `px-2` so hover wash expands without shifting icons (message body must not `overflow-hidden` or the wash radius gets clipped); `oc-tool-row` keeps pointer cursor on desktop.
  - `TOOL_ROW_CHIP_GEOMETRY_CLASS` (`rounded-lg px-2 py-0.5`) is shared with desktop assistant info/status chips so radius + padding stay consistent. Mobile info chips use roomier `px-2.5 py-1.5`, keep their card boundary aligned with the message content column, use medium-stroke `size-3.5`, and force `[&_.markdown-content]:!text-[length:var(--text-meta)]` — SimpleMarkdown defaults to body `--text-markdown`, which would otherwise dwarf the icon on mobile.
  - Also exports composer chrome (`SELECTOR_CHIP_HOVER_CLASS`, `COMPOSER_TRIGGER_CHROME_CLASS`, `COMPOSER_ICON_HOVER_CLASS`) for draft project/branch selectors and input footer controls.
  - Used by `ToolPart.tsx`, `ReasoningPart.tsx`, `ProgressiveGroup.tsx`, `ChatInput.tsx`, and `ModelControls.tsx`.

- `toolRenderUtils.ts`
  - Core classification helpers:
    - `isExpandableTool`
    - `isStaticTool`
    - `isStandaloneTool`
    - `isContextGroupTool` (`read` / `glob` / `grep` / `list`)
    - `isSkillGroupTool` (`skill`)
    - `isToolPartActive` / `isToolPartSettled` lifecycle evidence shared by flat rendering, static rows, context groups, skill groups, and expandable rows
  - If a tool should switch between static vs expandable, or join Explored / Skill grouping, change it here.

- `ReasoningPart.tsx`
  - Thinking block UI (`ReasoningTimelineBlock`), summary + optional duration.
  - Streaming Thought uses the 14px desktop / 12px mobile S1 `LatticeOrb` as the active indicator in its flex-centered title row, matching Explored context groups.

- `JustificationBlock.tsx`
  - Renders intermediate assistant text projected into Activity as ordinary assistant Markdown at its timeline position.
  - It follows the Activity group's disclosure and keeps message export, copy/TTS actions, file references, streaming updates, and text haptics without adding a nested reasoning disclosure.

## Current important behavior

- `read` is both a **static navigation tool** (`StaticToolRow`) and a **context-group member**. Consecutive `read` / `glob` / `grep` / `list` collapse into one `ContextToolGroup` ("Exploring" from the first explore call until a later non-explore part appears or the turn is no longer live, otherwise "Explored" plus search/read/list counts). Expanded children are one `StaticToolRow` per call and keep the shared per-call loading lifecycle. Grouping is client-side on `part.tool` names — not an OpenCode API v1/v2 feature. Logic lives in `contextToolGrouping.ts` + `isContextGroupTool`; both Activity (`ProgressiveGroup.aggregateRows`) and the flat `MessageBody` loop apply it. In sorted mode those rows live inside Activity and collapse with the Processed disclosure.
- A visible tool part stays in loading presentation until an explicit terminal status or valid end timing proves settlement. `completed`, `error`, `failed`, `timeout`, `cancelled`, and `aborted` restore the tool identity; `pending`, `started`, and `running` keep the 14px desktop / 12px mobile orb in the 14px desktop / 16px mobile leading slot even when timing fields arrive early. Mobile slots center the orb. Flat `MessageBody` rendering keeps lifecycle-unknown tool parts visible so this contract starts with the call row itself.
- Consecutive `skill` calls collapse into one `SkillToolGroup` ("Load Skill" plus original names, max three, then localized overflow). A lone skill still uses this header so the next name can flip-animate. Skill is not a context-group tool and must not join Explored collapse.
- For `read` / `skill` rows, the whole row is the hit target (same as Edit/Write). On dedicated mobile, clicks call `mobileActions.openFile` and open the same gesture `MobileResizableSheet` used by direct Edit/Write diffs (phone) or the right Files panel (iPad); desktop still uses context-panel `openContextFile`.
- Do **not** revive multi-target chip merge (`+N` hidden targets on one static row). A lone non-skill static tool stays one call per row. Only context tools share an Explored header; consecutive skills share a Skill header.
- Sorted Activity keeps Task tools at their original position as expandable rows. `MessageBody` suppresses every tool already projected into a sorted Activity segment, preventing a second flat Task row; live mode continues to render Task through its established standalone path.
- Each sorted turn uses one Activity container with the same full-width clickable header DOM, layout, typography, spacing, mobile behavior, and ARIA disclosure contract while collapsed and expanded. Live-active presentation (latest turn while the session is working) always starts expanded for untouched turns regardless of `activityRenderMode`; settled turns use that setting for the untouched default (`summary` open, `collapsed` closed). The newest turn stays open until the projection confirms its final body (`turn.hasConfirmedFinalBody`: terminal stop with zero continuation tools, no error, plus model-produced text); confirmation of an untouched live turn then re-applies the setting so `collapsed` auto-folds. Every click reverses the current per-turn value, and touched values survive later setting and disposition changes. Before toggling, the header captures its viewport top; the next layout synchronously compensates `[data-scrollbar="chat"]` and performs one frame-level correction after virtualizer measurement, keeping the control under the pointer. Collapsed turns render only this header; expanded turns render the complete ordered detail timeline. Active headers apply `animate-text-shimmer` to localized Working text with `--oc-text-shimmer-base: var(--status-info)` and do **not** show a live duration (elapsed while working is owned only by `WorkingPlaceholder` on the status row, so the foldable activity header and status row never race two counters). Normal and abnormal completed headers keep localized Processed text plus the authoritative duration across both disclosure states. An undefined completion disposition shows localized Processing details. Task inputs contribute their robustly parsed `subagent_type` to unbordered square avatars (up to two on mobile, three on desktop) separated by a small gap. Localized status text uses the authoritative total: active headers count running and pending Tasks, and completed headers count every participating Task. The disclosure header is a single-line full-width flex row: the left cluster (icon + status + duration) uses `flex-1` to absorb free space; the right trailer (agents when present + chevron) uses `ml-auto` so it stays on the trailing edge. Desktop keeps chip `px-2` so hover wash padding is symmetric; mobile only drops right padding (`pr-0` + slight chevron `-mr`) so the glyph has no dead trailing slot.
- Tool titles (including Shell Command) render immediately at full opacity while running. Busy opacity shine (`MinDurationShineText`) is not used on tool headers; only Task tools keep `animate-text-shimmer` for active subagent work. Shell still shows a live duration ticker next to the title.
- Tool rows render synchronously without entrance, fade, wipe, or tail-text animation. Shell completion can update tool output and row height without an animation-driven Activity flash.
- `edit` / `multiedit` / `write` stay in `ToolPart` for title + path + diff-stats chrome and use **non-expandable file navigation**. Web/Desktop and dedicated mobile `edit` / `multiedit` / `write` clicks open the selected tool's single-file patch (`write` / `create` / `file_write` synthesize a full added-file patch from the written content; the opened patch path is normalized to the click target so single-file views can find the file); `apply_patch` clicks open every renderable file patch from that tool invocation. The initial target scrolls to its first changed line, and the existing bounded stacked-diff policy limits how many large patches mount at once. Web/Desktop renderable-patch fallback opens the target file from the owning turn, or the working-tree change for writes (brand-new files are often absent from the turn snapshot). Dedicated mobile uses the closable Motion sheet on phones and the right Changes panel on iPad; standard file Changes handles edit fallback, while apply-patch fallback presents every file from the owning turn. VS Code opens the primary file in its native diff editor. Patch records lacking a complete renderable file set open the owning turn's complete diff. No chevron / expanded diff body.
- Every other tool, including web search/fetch, OpenCode built-ins, custom tools, plugins, and MCP tools, is **expandable** and renders through `ToolPart`. Context-group tools (`glob`/`grep`/`list`) are the exception: they join Explored grouping even though they are not static navigation tools.
- Mobile expandable tools share one compact content boundary: the timeline shell keeps the common rail inset, content shells remove their extra horizontal padding, and scroll surfaces use zero padding. Todo keeps its list dividers and zero-padding list surface through the same shared layout rules. Mobile Shell input and highlighted output use a `1.25rem` line height with a tighter gap between the two blocks; desktop spacing remains unchanged.
- `ToolPart` defers expanded content after a user toggle, preventing large tool input/output payloads from mounting during the initial chat render.
- Virtualized history uses a `MarkdownHydrationProvider` per stable turn entry. The visible window is released as one batch ordered from bottom to top, so entering a session reaches its final layout in a single commit instead of remeasuring and re-anchoring the virtualizer once per turn. Only once the viewport is fully released does upward scrolling preload the nearest three mounted turns above it, one turn per commit.
- Historical Markdown/tool hydration state updates run in React transitions. Hiding the owning `Activity` cancels queued frame work and aborts the Markdown pipeline before subsequent blocks can parse or commit.
- Shiki worker requests carry an `AbortSignal` plus `visible`/`background` priority. Cancelled hidden-session jobs are removed before they start, while current visible work overtakes queued historical highlighting. A Shiki call already executing is the single non-preemptible worker unit; its cancelled result is discarded.
- Historical Markdown that has not been released renders a bounded skeleton over an invisible `white-space: pre-wrap` size spacer. Raw Markdown syntax is never visually exposed, while the spacer preserves approximately the same pre-hydration row height. It does not mount the lazy rich renderer, run marked/DOMPurify/decoration, or attach Markdown interactions yet.
- Historical user text enables the installed-skills query only when its text can contain a slash skill token. Static tool rows enable it only for the `skill` tool. Unrelated history rendering therefore consumes a warm Query snapshot without starting catalog traffic on the chat first-paint path.
- Markdown file references classify file content before opening. Binary files use the desktop system handler, while image paths continue through the in-app preview path.
- Mobile surfaces annotate previewable text and image paths. Other binary paths remain plain text.
- User-message Markdown containing Session, Skill, Command, image, or attachment references keeps each Markdown text segment in the same inline formatting context as its reference chip. Segment renderer roots use inline width, Markdown containers use `display: contents`, and paragraph/spacer descendants use inline display, so block wrappers cannot force a reference onto its own line. Visible Session titles recover their exact identity from the same message's synthetic Session context; image citations recover their icon identity from sibling file parts. Both render through the shared trigger-icon size contract.
- Assistant/tool Markdown images and message file images open the shared image preview with gallery navigation. Direct and LAN transports preserve browser-native Markdown image loading. In Relay, DOMPurify keeps `file:` image locators in `data-md-image-source` while removing the browser-owned `src`; file URLs plus absolute or effective-directory-relative local paths then mount as focusable image placeholders that auto-load on first paint and subsequent DOM commits through `streamRelayImageDisplayUrl` (`runtimeFetch('/api/fs/raw')` → native `openAsset` returns a virtual URL immediately so `<img>` can request it while a background body reader continues `writeChunk` backpressure and `endAsset`, else Blob object URL). Transport keys and host paths stay in the renderer; native bridges receive only opaque `assetId`, MIME, and bounded chunks. Each binary read retries through transient tunnel reconnects, loading is deduped while in flight, failures retain a retryable placeholder (click or Enter/Space retries), and activation of a loaded image opens the shared preview. Assets have TTL, size ceilings, Abort/cancel, transport-change cleanup, and write backpressure; background pump failures abort/release the native asset without unhandled rejections. Each Markdown renderer captures its transport when it mounts; the image-interaction layout effect arms reconcile before Morphdom's first-paint layout commit so placeholders load without a user click. Initial and streaming DOM commits decorate image placeholders explicitly, while commit reconciliation cancels removed reads, releases their display URLs, and starts loads for newly present runtime-file images. External HTTP(S), data, and blob images render directly in every runtime, and preview payloads retain the original source URL.
- Mobile primary chat omits the synthetic subtask prompt disclosure, keeping child-agent prompt folding out of the home conversation surface. Panel and embedded transcripts retain the disclosure.
- After a row is released, the first layout pass sync-paints Markdown and reveals before the browser paints (so a streaming-tail → history remount does not flash the skeleton over already-rendered content). Async morphdom still upgrades to the rich DOM afterward. The target subtree remains exclusively imperative-owned.
- Hydration state is keyed by stable turn/message entry keys rather than virtual indexes, so prepending older pages does not shift the wrong rows into the hydrated set. The newest entry stays hydrated immediately; streaming-tail Markdown remains immediate.
- Thinking duration is hidden in `sorted` mode (handled in `ReasoningPart.tsx`).
- Native mobile haptics follow visible AI output during an active message lifecycle: each Reasoning or Tool part fires once when it appears, while assistant text, including intermediate text projected into Activity, fires for every visible content change. The native `OpenChamberHaptics` hot path invokes each accepted event directly without timers, queues, or cadence scheduling.

## "I want to change description for Perplexity" (example recipe)

If task is: "change text shown near Read or Skill in compact mode":

1. Edit `ProgressiveGroup.tsx` -> `getToolShortDescription(activity)`.
2. Update the branch that handles `read` or `skill` in `StaticToolRow`.
3. Keep all other tool header/output behavior in `ToolPart.tsx`.
4. Keep icon changes (if any) in `toolPresentation.tsx`.

Why: only navigation tools use the compact static path; all other tools need observable input and output.

## "I want tool to become expandable" (example)

1. Update `toolRenderUtils.ts`:
   - add/remove a tool name from `STATIC_TOOL_NAMES` only when it has a reliable direct in-app navigation action
2. Ensure `ToolPart.tsx` supports desired header + expanded output format for that tool.
3. Validate both modes (`sorted` and `live`).

## Safe editing checklist

- Do not duplicate icon logic; keep it in `toolPresentation.tsx`.
- For static tool copy changes, prefer `ProgressiveGroup.tsx` first.
- For expanded output changes, edit `ToolPart.tsx`.
- Keep historical Markdown scheduling at the `MessageList` entry boundary. Do not add one `IntersectionObserver` per Markdown block or reverse virtual-row DOM order.
- After edits run:
  - `bun run type-check`
  - `bun run lint`
  - `bun run build`

## Context panel transcript verification

- `components/layout/contextPanelSessionSurface.test.ts` covers strict panel
  navigation planning, runtime-scoped geometry keys, retained-view cache limits,
  close cleanup, and viewed-session resolution.
- Keep browser and preview iframe behavior outside this transcript contract.

## Quick map of files in this folder

- Text: `AssistantTextPart.tsx`, `UserTextPart.tsx`
- Tools: `ToolPart.tsx`, `ProgressiveGroup.tsx`, `ContextToolGroup.tsx`, `SkillToolGroup.tsx`, `toolPresentation.tsx`, `toolRowChrome.ts`, `toolRenderUtils.ts`
- Reasoning/justification: `ReasoningPart.tsx`, `JustificationBlock.tsx`
- Status/placeholders: `WorkingPlaceholder.tsx`, `SessionActiveSpinner.tsx`, `MigratingPart.tsx`, `BusyDots.tsx`, `LatticeOrb.tsx`, `MorphOrb.tsx` (the live-status icon follows the aicss.dev Orbs M3 “Unfolding” eight-dot quarter-turn reference implementation, with its stage radius raised from 7 to 10.5 so the 28px geometry fills the 14px desktop / 12px mobile box; elapsed turn time comes from the latest user message's server `time.created`). `WorkingPlaceholder` uses the same fixed leading-icon slot and responsive gap as tool rows and `ProgressiveGroup`, keeping their text axes aligned. Generic status phrases queue behind the 1200ms display window (never paint immediately over a specific tool status); after `isWorking` drops the last phrase lingers ~600ms so step gaps do not collapse the status row. That linger is skipped the moment the last assistant has a confirmed final body (`isTurnSettled` / `hasConfirmedFinalBody` — the same authority that reveals Changes chrome): the hint unmounts in that commit so it cannot flash after the turn has already settled.
- Utility renderers: `VirtualizedCodeBlock.tsx`
