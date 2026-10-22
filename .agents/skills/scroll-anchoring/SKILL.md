---
name: scroll-anchoring
description: Use when changing transcript scrolling, history prepend/load-more, reading-anchor compensation, bottom auto-follow, virtualizer measurement, row render keys, or late image/Markdown growth in primary chat or Assistant contact transcripts; and when diagnosing a viewport that jumps, jitters, or drifts.
---

# Scroll Anchoring

The reader's row must not move unless the reader moved it. Every frame, the reading row's on-screen offset changes only by the user's own input (a wheel notch, a finger step); any extra movement is a **passive jump**, and passive jumps are the bug class this skill exists to stop.

## Owners

One scroll writer per transcript. Find it before editing; read its module doc for the full contract.

| Surface | Owner | Contract |
|---|---|---|
| Primary chat (virtualized) | TanStack virtualizer + `shouldAdjustHistoryScrollOnItemSizeChange` + `installBatchedResizeItem` | `packages/ui/src/components/chat/DOCUMENTATION.md` |
| Primary chat (mobile prepend) | `StaticHistoryList` quiet-window hold | same |
| Assistant contact | `useAssistantContactAutoFollow` (anchor + resize observer) | `packages/ui/src/components/assistants/DOCUMENTATION.md` |

A new compensation lives inside the owner. A second writer (rAF loop, MutationObserver, watchdog) fights the first and produces exactly the jitter it was added to fix.

- Activity-hidden lists must reattach their virtualizer after re-show and parent ref attachment, then reconcile the current viewport and rendered range.

## Root causes, in order of likelihood

Work down this list; each has caused a real regression.

0. **Content that can change height after first paint.** Remove growth at the source before compensating it. Transcript images use `LoadingImage contentFrame`: one fixed height in every phase, image contained, full size in the preview. Keep sizing on the frame, with no competing height utilities on the child image. Verify the image rectangle as well as the frame rectangle with production theme CSS loaded: unlayered Markdown rules can override layered image sizing and paint over the next message even when the frame height is correct. `imageGeometry.chrome.test.ts` guards both geometry and phase stability. Keep the frame compact; its size is owned by `--oc-content-image-height`.
1. **Growth above the reader goes uncompensated.** Markdown hydration, images, and cards change height after a prepend. TanStack's default skips rows fully above the viewport while scrolling backward — the reason for the custom rule. A hand-rolled anchor fails the same way when it re-captures its baseline after layout and before compensating.
2. **Input subtracted twice, or not at all.** Compensation measures how far the row moved since capture. The user's scroll since capture must be excluded from that delta (record `scrollTop` with the anchor), otherwise a wheel step is undone or growth in the same frame is adopted as the new position.
3. **Unstable or duplicate row keys.** Two rows with one React key make React reorder the DOM during a prepend; it reads as a jump. Keys stay unique per row and stable across preview→authoritative handoff. Server bubble indexes are not unique within a turn: text bubbles and cards reuse them.
4. **Writing `scrollTop` during a held touch.** A write mid-pan cancels the native gesture on iOS. Under a finger, re-capture only; compensate at lift or defer the DOM change (the mobile quiet window).
5. **First virtualization switch.** Normal-flow → virtualized at the threshold relocates rows; the transition anchor seeds the range. Expect residual offset here first.

## Measure before and after

Unit tests drive synthetic geometry and cannot see these bugs. Measure in a real browser against a production build and a real long transcript.

```sh
# Build once, serve with API proxy, then probe (desktop wheel; add --mobile for touch).
bun scripts/perf/scroll-jump-probe.mjs --url <page> --scroller '<css>' [--mobile] [--max-jumps 0]
```

- Primary chat scroller: `.chat-scroll`. Assistant contact: `[data-assistant-contact-transcript]`.
- Phone surfaces ignore deep session paths on cold start; pass `--open-title <session title>`.
- `loads` must be > 0 — zero loads means the run measured nothing. A dev server can serve a stale bundle after edits; rebuild and confirm the bundle contains your change.
- `prependJumps` attributes a jump to a load; other jumps are late growth.
- Run each side at least 3 times, before and after. One clean run proves nothing.
- Chrome touch emulation does not exercise WebKit's deferred compensation. iOS changes also run `IOS_HISTORY_SIM=1` on `ChatHistoryScroll.chrome.test.ts` (needs a booted simulator and `serve-sim`).

## Lock the fix in

Every fix lands with a guard that goes red on revert. Prove it: revert the source, run the test, watch it fail, restore.

- Behavioral regression in the owner's unit test, modeling the exact frame: growth and input together.
- Wiring contract when the fix is a configuration hook that silently no-ops if removed (see `historyItemSizeAdjustment.test.ts`).
- Key-uniqueness assertion with the server's real message shape when render keys change.
- The owning `DOCUMENTATION.md` records the rule and its known gaps.

## Exit checklist

- [ ] One owner writes scroll; no new writer added.
- [ ] Probe numbers before/after, desktop and mobile, ≥3 runs each, `loads` > 0.
- [ ] Each new test fails with the fix reverted.
- [ ] Owning doc updated; remaining jumps reported with their cause.
