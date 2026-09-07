# iOS transcript overflow review — 2026-09-07

## Scope

Reviewed the supplied changes to `decorate.ts`, both `MarkdownRendererImpl` loading overlays, `MarkdownLoadingSkeleton`, `GeneratedJsonResultCard`, the bounded subagent notification in `MessageBody`, and `AssistantConversationSurface` scroll CSS.

Corrections are limited to `mobile.css`, the existing `markdownCodeMobileStyles.test.ts`, and owning documentation:

- Current code/result shells retain `clip/clip`. Compatibility overrides target the two named `.overflow-hidden` card shells and use `clip` on both axes.
- Descendant Markdown containers retain their own scrolling. The broad Markdown descendant clipper selector was removed.
- Code-body Y remains `hidden`; the existing wrap-state class controls X.
- The cascade test loads the complete repository `mobile.css`. Its small Tailwind utility fixture expands `overflow-clip` longhands for happy-dom's shorthand limitation.

The loading overlays are positioned/flex clipping surfaces. Code/result cards retain their borders, radius and content sizing; code `pre` margins are explicitly zero. The changed `MessageBody` preview remains bounded at `max-h-16` and opens its session through the enclosing control. Other expandable message surfaces retain their existing state and overflow paths.

## Red → green

### Repository CSS cascade

```sh
bunx --no-install vitest run --project @openchamber/ui \
  packages/ui/src/components/chat/markdown/markdownCodeMobileStyles.test.ts
```

The strengthened test against the incoming fixer CSS produced **2 failed / 3 passed**: the broad selector remained present, and the named card computed Y was `hidden` with expected `clip`. After correcting CSS and explicitly expanding fixture utility longhands, the same file produced **5 passed**. This verifies happy-dom cascade and DOM contracts.

### iOS Safari

Environment: iPhone 17 Pro Simulator, iOS **26.5**, Safari **26.5**, 402 CSS-pixel screen width. Safari's compatibility UA reports `CPU iPhone OS 18_7`; the installed Simulator runtime is the version source.

An independent static fixture loads the complete actual `mobile.css`, plus small utility/geometry rules and representative card/body/preview DOM. Three variants were exercised:

- `original`: incoming CSS with only the supplied transcript clipper/body-selector additions removed, and the original `overflow-hidden` card/preview classes restored. This is a narrowly reconstructed baseline; source control was untouched.
- `review`: exact incoming fixer CSS.
- `fixed`: final repository CSS.

The cached serve-sim JavaScript launcher failed to resolve `ws`. The existing cached **0.1.43 native helper** successfully supplied framebuffer capture, accessibility lookup, and HID touch input through `/ws`. Node's built-in WebSocket sent the helper's touch protocol. Browser events reported `isTrusted: true`.

| Surface / operation | Original | Incoming fixer | Final |
|---|---|---|---|
| Code card computed X/Y | `hidden/auto` | `hidden/hidden` | `clip/clip` |
| Code body, unwrapped | `auto/auto` | — | `auto/hidden` |
| Bounded preview | `hidden/auto` | — | `clip/clip` |
| Independent nested vertical container | `hidden/auto` | `hidden/hidden` | `hidden/auto` |
| Preview upward gesture | preview top **138**, transcript **0** | — | preview **0**, transcript **138** |
| Code horizontal gesture | code left **420**, transcript top **0** | — | code left **422**, transcript top **0** |
| Nested vertical gesture | — | nested **0**, transcript **69** | nested **69**, transcript **0** |
| Table horizontal gesture | — | — | table left **425**, transcript top **0** |
| Wrap toggle | — | — | X `auto → hidden → auto`; height `120 → 620 → 120`; wrapped scroll width equals client width **370** |
| Preview expand | — | — | client height `64 → 360`, matching full scroll height |

Six assertions on Safari's posted reports produced an explicit **original: 2 passed / 4 failed, exit 1**, followed by **fixed: 6 passed / 0 failed, exit 0**. The checks cover card/body/preview overflow, independent nested overflow, trusted horizontal pan, and preview-gesture ownership.

## Visual and viewport evidence

- Saved and reviewed framebuffer screenshots before, during, and after the final preview gesture. The code-card border and rounded background remain clipped, and the transcript visibly advances.
- Saved the same gesture and a subsequent growth action to `overflow-fixed-gesture.mp4` for replay. Video capture completed; frame-by-frame video analysis remains open.
- The recorded repeat gesture advances transcript top `0 → 143`. Across **150 requestAnimationFrame samples**, `visualViewport.offsetTop = 0`, `window.scrollY = 0`, and `card.getBoundingClientRect().y + transcript.scrollTop` has **0px drift**.
- A subsequent controlled tail growth raises transcript scroll height `1562 → 1762`, preserving top **143** and the sampled viewport coordinates.

These observations establish static CSS and gesture ownership. The bounded preview's original inner scroll consumption is directly observed. A general iOS `scrollTop` freeze remains an unverified hypothesis. Production streaming flicker, compositor-only blank frames, momentum/resize interactions, image hydration, keyboard changes, and virtualized full-app behavior remain open. Physical devices, older iOS releases, Capacitor WKWebView, and Android were outside this run. Chrome results from the preceding fixer were retained as prior evidence.

## Final checks

```sh
bunx --no-install vitest run --project @openchamber/ui \
  packages/ui/src/components/chat/markdown \
  packages/ui/src/components/chat/MarkdownRendererImpl.test.ts \
  packages/ui/src/components/chat/MarkdownRenderer.deferred.test.tsx \
  packages/ui/src/components/chat/MarkdownRenderer.markstream.test.ts \
  packages/ui/src/components/chat/message/parts/generatedJsonResult.test.ts \
  packages/ui/src/components/chat/message/parts/UserTextPart.test.ts \
  packages/ui/src/components/assistants/AssistantConversationSurface.scroll.test.tsx
bun run --cwd packages/ui type-check
bun run --cwd packages/ui lint
```

- Focused suite: **17 files / 163 tests passed**.
- UI type-check: **exit 0**.
- UI lint: **exit 0**, **0 errors / 158 warnings**, reported across existing unrelated surfaces.
- Dead-code skipped: this review adds documentation only; existing source files, exports, imports, types, and entrypoints retain their shape. Temporary QA scripts are outside the repository.
- Full application builds and broader workspace tests were outside the assigned lightweight scope. Git, release operations and dependency installation were excluded.

## Local evidence / replay

The session's pre-approved temporary QA directory contains:

- `mobile-overflow-before-review.css`
- `overflow-webkit.mjs` — static server; run from repository root
- `overflow-gesture.mjs` — existing native helper HID protocol client
- `overflow-webkit-assert.mjs` — report assertions (`original` / `fixed`)
- `overflow-capture.mjs` — framebuffer/video capture automation
- `overflow-webkit-reports.json` — computed styles, trusted touch events, positions and frame samples
- `overflow-fixed-{initial,before,during,after}.png`, `overflow-fixed-gesture.mp4`
- `overflow-webkit-{red,green}.log`, `overflow-final-{vitest,type-check,lint}.log`

Saved Safari reports support offline assertion replay:

```sh
node "$QA_DIR/overflow-webkit-assert.mjs" original # exit 1: four failures
node "$QA_DIR/overflow-webkit-assert.mjs" fixed    # exit 0: six passes
```

The fixture server and native helper were stopped, and the Simulator was returned to its initial shutdown state. Other existing local services were preserved.

With `$QA_DIR` set to that directory, run `node "$QA_DIR/overflow-webkit.mjs"`, open `http://127.0.0.1:3199/?mode=original` or `?mode=fixed` in Simulator Safari, inspect `/ax`, and repeat the recorded gestures. The original/final first comparison uses horizontal `(0.8, 0.30) → (0.2, 0.30)` followed by vertical `(0.5, 0.435) → (0.5, 0.26)`, with 3 seconds of settling after each. Coordinates are normalized to this Simulator screen and follow the inspected accessibility bounds.

Next acceptance step: replay a representative long assistant conversation with live code/image growth in the full iOS app while recording both native frames and transcript scroll writes.
