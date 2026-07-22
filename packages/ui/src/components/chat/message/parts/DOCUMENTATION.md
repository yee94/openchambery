# Chat Message Parts: Rendering Architecture

This folder contains renderers for chat message parts (text, tools, reasoning, placeholders) and shared tool presentation helpers.

Use this doc when you ask an agent to change tool/header/description behavior.

## High-level flow

- Message parts are rendered from `MessageBody.tsx`.
- There are two tool rendering paths:
  - **Static grouped tools** -> `StaticToolRow` in `ProgressiveGroup.tsx`
  - **Expandable tools** -> `ToolPart.tsx`
- Shared tool icon mapping is centralized in `toolPresentation.tsx` (`getToolIcon`).

## Which file controls what

- `ProgressiveGroup.tsx`
  - Renders grouped Activity rows and grouped static tools.
  - Contains `StaticToolRow`.
  - Contains static tool short description logic (`getToolShortDescription`).
  - If you want to change how `read/grep/perplexity/webfetch/...` look in compact/grouped mode, edit here.

- `ToolPart.tsx`
  - Renders expandable tool rows (bash/edit/write/question/task + fallback).
  - Controls expandable header title/description/diff stats/timer and expanded output body.
  - Task tools (`task`) show `AgentAvatar` + subagent nickname (`input.subagent_type`) in the
    leading icon column (same slot as the expand chevron). Idle = avatar; hover = chevron only when
    Settings → Visual → "Show Sub-agent Work Details" (`showSubagentTaskDetails`) is on.
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
  - Nested task-session navigation delegates to `SessionSurfaceContext`. In an
    ContextPanel transcript, the strict read-only panel surface accepts
    same-directory local navigation and preserves the primary session selection.
  - If you want to change expandable tool layout, edit here.

- `taskToolModel.ts`
  - Owns Task metadata parsing and child-session summary projection.
  - `part.state.metadata.sessionId` is the only live identity contract between a Task and its child session.
  - A running Task may briefly have no `sessionId`; render it as waiting until the authoritative part update arrives. Never match parallel children by order, title, timestamp, or status.
  - Part-level metadata and output parsing exist only for older persisted records and never override state metadata.

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
    - `getStaticGroupToolName`
  - If a tool should switch between static vs expandable, change it here.

- `ReasoningPart.tsx`
  - Thinking block UI (`ReasoningTimelineBlock`), summary + optional duration.

- `JustificationBlock.tsx`
  - Justification block wrapper over `ReasoningTimelineBlock`.

## Current important behavior

- `read` and `skill` are **static navigation tools** and render via `StaticToolRow`.
- `edit` / `multiedit` / `write` stay in `ToolPart` for title + path + diff-stats chrome and use **non-expandable file navigation**. Web/Desktop and dedicated mobile `edit` / `multiedit` clicks open the selected tool's single-file patch; `apply_patch` clicks open every renderable file patch from that tool invocation. The initial target scrolls to its first changed line, and the existing bounded stacked-diff policy limits how many large patches mount at once. Web/Desktop renderable-patch fallback opens the target file from the owning turn. Dedicated mobile uses the closable Motion sheet on phones and the right Changes panel on iPad; standard file Changes handles edit fallback, while apply-patch fallback presents every file from the owning turn. VS Code opens the primary file in its native diff editor. Patch records lacking a complete renderable file set open the owning turn's complete diff. No chevron / expanded diff body.
- Every other tool, including search/fetch, OpenCode built-ins, custom tools, plugins, and MCP tools, is **expandable** and renders through `ToolPart`.
- Mobile expandable tools share one compact content boundary: the timeline shell keeps the common rail inset, content shells remove their extra horizontal padding, and scroll surfaces use zero padding. Todo keeps its list dividers and zero-padding list surface through the same shared layout rules. Mobile Shell input and highlighted output use a `1.25rem` line height with a tighter gap between the two blocks; desktop spacing remains unchanged.
- `ToolPart` defers expanded content after a user toggle, preventing large tool input/output payloads from mounting during the initial chat render.
- Virtualized history uses a `MarkdownHydrationProvider` per stable turn entry. The newest visible turns are released first, from bottom to top; upward scrolling additionally preloads only the nearest three mounted turns above the viewport.
- Historical Markdown/tool hydration state updates run in React transitions. Hiding the owning `Activity` cancels queued frame work and aborts the Markdown pipeline before subsequent blocks can parse or commit.
- Shiki worker requests carry an `AbortSignal` plus `visible`/`background` priority. Cancelled hidden-session jobs are removed before they start, while current visible work overtakes queued historical highlighting. A Shiki call already executing is the single non-preemptible worker unit; its cancelled result is discarded.
- Historical Markdown that has not been released renders a bounded skeleton over an invisible `white-space: pre-wrap` size spacer. Raw Markdown syntax is never visually exposed, while the spacer preserves approximately the same pre-hydration row height. It does not mount the lazy rich renderer, run marked/DOMPurify/decoration, or attach Markdown interactions yet.
- Historical user text enables the installed-skills query only when its text can contain a slash skill token. Static tool rows enable it only for the `skill` tool. Unrelated history rendering therefore consumes a warm Query snapshot without starting catalog traffic on the chat first-paint path.
- After a row is released, the first layout pass sync-paints Markdown and reveals before the browser paints (so a streaming-tail → history remount does not flash the skeleton over already-rendered content). Async morphdom still upgrades to the rich DOM afterward. The target subtree remains exclusively imperative-owned.
- Hydration state is keyed by stable turn/message entry keys rather than virtual indexes, so prepending older pages does not shift the wrong rows into the hydrated set. The newest entry stays hydrated immediately; streaming-tail Markdown remains immediate.
- Thinking/Justification duration is hidden in `sorted` mode (handled in `ReasoningPart.tsx` + `JustificationBlock.tsx`).
- Native mobile haptics follow visible AI output during an active message lifecycle: each Reasoning or Tool part fires once when it appears, while assistant and Justification text fire for every visible content change. The native `OpenChamberHaptics` hot path invokes each accepted event directly without timers, queues, or cadence scheduling.

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
- Tools: `ToolPart.tsx`, `ProgressiveGroup.tsx`, `toolPresentation.tsx`, `toolRowChrome.ts`, `toolRenderUtils.ts`, `ToolRevealOnMount.tsx`
- Reasoning/justification: `ReasoningPart.tsx`, `JustificationBlock.tsx`
- Status/placeholders: `WorkingPlaceholder.tsx`, `SessionActiveSpinner.tsx`, `MigratingPart.tsx`, `BusyDots.tsx`
- Utility renderers: `VirtualizedCodeBlock.tsx`, `MinDurationShineText.tsx`
