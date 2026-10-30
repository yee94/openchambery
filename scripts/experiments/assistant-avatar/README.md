# Assistant procedural avatar experiment

## Current engine: procedural renderer with independent non-sphere geometry

The active implementation uses the vendored player and animation recipes in
`packages/ui/src/lib/assistant-avatar/vendor/grok-anatomy/`. The Open Mascot runtime and
hand-authored screen-space eye rotations have been removed. All evidence below
the historical heading belongs to earlier attempts, not to this engine.

- The engine's eye projection, expression/clip evaluator, state machine,
  blink tracks, bridge transitions, springs and DOM renderer are reused.
- `geometry.ts` independently fills the missing non-sphere branch using a
  solid / extrusion / loft / seat pipeline. Missing contour generators
  are independently authored; these shapes are not claimed to match the original
  application frame-for-frame. No original app bundle is needed or included.
- All nineteen persisted shapes render (sixteen picker choices); default Bots
  remain round with only pigment variation. Legacy eye/expression preferences
  remain round-trippable but cannot randomize eye dimensions or angles.
- Busy wrappers use the source working clips for left/right observation, not the
  three-dot thinking morph. Explicit idle/thinking/happy states remain available.
  Live changes preserve the source state machine and springs.
- Rest faces share pure static SVG/native PNG rendering, reference static settle,
  and fixed per-shape artboards at 94% longest-axis occupancy. Live excursions
  uniformly fit the entire scene to the slot, never individual eyes.
- Meshes are lazy and catalog-bounded (eighteen); rest models/artboards have at
  most nineteen entries each, with up to two rest paint variants per shape.
  Graphite uses the source light painted-eye mode; other pigments use cutouts,
  without changing eye geometry. Static image caching remains 128 entries / 1 MiB.
  Visible live faces share the existing 30Hz clock, with no per-frame React state,
  network fetch or SVG path parsing. One window-scoped pointer tracker coalesces
  mouse movement anywhere in the page; active faces batch geometry reads before
  paints. The last inactive face removes the tracker. Hover composes one bounded
  .65-second whole-avatar shrink/rebound plus head sway, without changing the eye
  descriptors or working clip. Shrink reaches 82%; rebound uses up to 104% where
  the slot permits, after the ordinary containment fit.

## Motion/runtime and independent performance gate (2026-10-30)

- `lib/assistant-avatar/runtime.ts` now owns the player, renderer, pointer lease
  and frame subscriptions. The React leaf supplies `{ active, motion, size }`
  and an optional hover target; work/size updates do not recreate the player.
  Disposal is idempotent, respects saved motion-off and only removes its own SVG.
- The private RAF loop is replaced by Motion's shared `frame.read`/`frame.render`
  phases, still capped at 30 geometry paints/second with all reads before writes.
  Existing 3D eye/body geometry and hover/working/ambient behavior are unchanged.
  Live React faces no longer serialize a static image URI that they never use.
- Run `bun run test:avatar-performance` independently of the workspace suite.
  It builds the production engine, real CSS and production profiling React facade
  in isolated Chromium, with no Yuri/OpenCode service or real data. Missing Chrome
  fails explicitly. One ambient / twenty idle / twenty working batches have p95
  CPU ceilings of 4/8/10ms for generation + SVG writes; lifecycle, zero per-frame
  React commits, fifty unrelated updates, pointer coalescing and reduced-motion
  cleanup are also asserted. Related PRs have a dedicated CI job; CI was not run
  locally and the native-runtime acceptance caveats below still apply.
- Before the scheduler extraction, warm p95 samples were .8/3.6/5.5ms; after it,
  .6/3.7/5.6ms on the same machine. These are effectively unchanged geometry costs,
  not evidence that Motion made SVG projection faster. The material changes are
  shared scheduling, simpler ownership and an executable regression budget.

## Global gaze / hover / working follow-up (2026-10-30)

- The navigation face now has an opt-in ambient shape cycle. Every 4–7 seconds
  of active player time it picks a different allowed shape and uses Anatomy's
  existing body spring to blend. Stored Bot recipes, color assignment and
  new-contact defaults do not change. Historical faces remain static; navigation
  respects saved motion-off, reduced motion, document visibility and intersection.
  No interval, per-frame React update or activity-derived animation is added.
- 219 focused tests pass, including every round-to-picker-shape transition,
  containment, bounded resume, navigation query isolation and lifecycle cleanup.
  UI/Web type-check, focused ESLint, Web/lab builds and the dead-code scan ran.
  No navigation/avatar dead-code findings were reported.
- Production Chromium showed the actual sidebar face changing from round to a
  shield/other outlines. 207 observed paints stayed inside the SVG; reduced
  motion left zero further attribute writes. The mobile web dock also changed
  shape and preserved its 28.75px painted SVG box. An instrumented single-nav
  frame callback measured median 1.1ms / p95 5.5ms / max 33.7ms (186 warm samples).
  The unfocused browser was throttled; these are scripting timings, not a frame
  rate/compositor guarantee. Native iOS system tabs are unchanged; no Electron,
  VS Code or native-device acceptance/release was performed for this follow-up.

- Contact-row hover also covers text and empty space. Desktop list buttons and
  mobile cards pass a stable `hoverTarget` ref to the live avatar; one native
  pointerenter subscription triggers the existing shrink/rebound without hover
  state or parent rerenders. Moving within the card cannot trigger a second
  bounce. Mounted tests cover touch/reduced-motion/offscreen cleanup, target
  replacement and fifty unrelated renders without listener churn or player reset.
  Production desktop text/whitespace entry and mobile-page whitespace entry were
  verified: scale fell to about .82 and returned to 1; other cards stayed above
  .96 and moving within the same card did not retrigger the bounce. This mobile
  check used a mouse in Chromium, not native touch-device acceptance.

- Mouse movement anywhere in the owning window drives visible live faces. One
  shared sample coalesces events, and all geometry reads precede all SVG writes.
  No rectangle reads happen in the pointer event handler. Blur/window leave and
  touch clear gaze; the last inactive face removes all window input listeners.
- Hover now visibly shrinks the entire scene by up to 18%, rebounds up to 4% where
  containment permits, and returns to the ongoing pose in .65 seconds. Scale is
  applied after containment so fitting cannot erase the shrink. Re-entry cannot
  stack; touch/reduced-motion faces do not trigger it.
- Busy wrappers and `animated` select Working_A–F, not the three-dot thinking
  state. Explicit thinking remains separately available. The working clip keeps
  running through mouse follow and hover; neither interaction restarts it.
- CPU profiling exposed redundant non-sphere outline mixing and projection of
  interior vertices. Only silhouette vertices are now projected; compact,
  single-body, non-morph frames bypass cross-body mixing/angle sorting, using
  exact solid hull vertices or the reference 192 base rays for concave bodies.
  Eighteen shape tests compare those samples against the full reference builder.
- 164 focused UI tests pass, including shared listeners, event coalescing,
  read-before-write order, scroll/layout freshness, hover amplitude/return,
  containment and working transitions. UI/Web type-check, focused ESLint, Web
  and lab builds pass. The dead-code scan has no avatar-module findings.
- Production Chromium confirmed page-wide left/right eye movement, twenty active
  working faces with zero thinking-dot circles, one pointer listener while active
  and zero under reduced motion. A real hover sampled scale 1 -> .826 -> 1.021 -> 1.
  Static/live-rest/PNG pixels still match in 38 iris/graphite cases, and 456 compact
  gaze/hover/working scene samples stayed in-frame.
- A deterministic twenty-face benchmark with mouse gaze (80 warm samples/state)
  measured idle median 3.5ms / p95 4.1ms and working median 4.7ms / p95 6.0ms for
  model generation plus SVG writes. This is not a compositor/frame-rate or native
  device guarantee. No native runtime acceptance or release was performed.

## Anatomy migration validation (2026-10-30, before global gaze/hover follow-up)

- 138 focused UI tests pass: all 1,824 stored-recipe combinations, source/data
  integrity, reference sphere frames, all nineteen shape/state transitions,
  graphite contrast without geometry changes, unique SVG IDs, Strict Mode cleanup,
  mouse/touch gaze, shared-clock scheduling and fifty unrelated parent updates.
- Fifteen avatar-related backend service tests pass (171 unrelated tests excluded
  by the focused name filter). UI/Web type-check, focused ESLint, Web production
  build and the production-component lab build pass. The dead-code report has no
  avatar-module findings; unrelated repository findings remain.
- Chromium: all nineteen shapes in iris and graphite (38 cases) have zero RGBA
  differences between static SVG, live-rest SVG and the 128px rasterized PNG.
  Rest artwork fills approximately 94% of its slot, including 16–44px previews.
  In 741 normal and 513 compact scene samples, rendered bounds stayed in-frame.
- The production lab exercised shape/color edits, the thinking morph, local
  save/reload and PNG creation. A 350px viewport has no horizontal overflow.
  Reduced motion yielded zero active faces and zero sampled SVG mutations.
- Twenty visible production faces were observed with no recipe network request.
  A short 25-paint callback sample measured median 7.9ms / p95 10.1ms, excluding
  browser layout/paint. Later viewport/focus changes and background throttling
  prevented a sustained frame-rate measurement. These figures do not establish
  stable 30fps, physical-device battery usage or composer/IME responsiveness.
- Full Electron, VS Code, Capacitor and native share-sheet runtime acceptance were
  not run. No release was made in that validation.

## Running the current production-component lab

Run from the repository root, using installed workspace dependencies:

```sh
bunx vite --config scripts/experiments/assistant-avatar/vite.config.mts
```

For a production-mode preview:

```sh
bunx vite build --config scripts/experiments/assistant-avatar/vite.config.mts
bunx vite preview --config scripts/experiments/assistant-avatar/vite.config.mts --port 5187 --strictPort
```

The terminal prints the loopback preview address. This isolated lab renders the
**production** avatar editor, working-avatar wrapper, theme tokens and native PNG
rasterizer. It does not start an OpenCode service, connect to a Yuri backend,
or modify real assistants. Save persists only `yuri:avatar-lab:seed:v1` on the
preview origin. The two share previews are the saved SVG and a freshly rasterized
PNG; edit the recipe, Save, then reload to exercise local recovery. Add `?stress`
for twenty live-list entries and scroll to verify offscreen suspension. Add
`?stress&shapes` for mixed non-sphere production-component stress coverage.

Production integration lives in `AssistantsSettingsPage` and the shared
`AgentAvatar kind="assistant"` boundary. Configurations use the existing
revision-checked `avatarSeed` mutation and SQLite persistence, not this demo key.
Primary coding-agent faces and app branding remain unchanged.

Browser acceptance: choose shape tiles and color swatches; randomize; save and
reload; change light/dark and language; check 350px touch and desktop widths;
emulate reduced motion; scroll faces out of view; verify that native PNG and the
saved static face match. Native-device share-sheet painting and full desktop,
VS Code and Capacitor runtime acceptance remain separate checks.

## Historical evidence — superseded engines (2026-10-30)

The remaining sections record earlier experiments only. They are not the current
implementation contract, source provenance, validation results or release approval.

- The focused UI tests include all 1,824 recipe
  combinations, malformed/future seeds, vendored-source integrity, one-clock
  scheduling, dynamic reduced motion, visibility/unmount cleanup, 50 unrelated
  parent renders, revision-failure draft retention and static navigation isolation.
- The broader Assistant/UI/native-share selection passed 333 of 334 tests.
  `AssistantUI.test.ts:957` fails an old `client.session.prompt` source assertion;
  the identical failure reproduces in the original working tree without these
  changes. It is not suppressed or changed by this experiment.
- Four focused backend avatar tests pass, including real SQLite recipe persistence,
  revision conflict, restart recovery, legacy seeds and on-demand tool guidance.
  The complete contact-tool suite also passes (30 tests), as does the existing
  closed-composer-picker scale guard (4 tests).
- UI type-check, UI lint (existing warnings only), Web production build, Settings
  design audit, repository-neutrality check and dead-code scan ran. The dead-code
  report contained no findings for the new avatar modules; unrelated existing
  findings were left untouched.
- Ego/Chromium production lab: customized shape/color/eyes, saved and reloaded
  the recipe, switched Chinese/English, generated a native PNG, and checked
  light/dark themes. Rendering the saved SVG and its native PNG into 128×128
  canvases produced 0 differing RGBA channels out of 65,536. At 350px with
  `mobile-pointer`, controls and cards remain in bounds and the page has no
  horizontal overflow. A 21-live-face stress view dropped to 4 active / 17 paused
  after scrolling to the end at phone width. Emulated system reduced motion
  yielded 0 active faces and 0 SVG frame writes in the sampling window.
- This browser environment delivered only a few animation callbacks per second
  even for a native RAF counter after focus, so it cannot establish real 30fps,
  robust timing percentiles or physical-device battery/input responsiveness.
  Unit tests prove the scheduling upper bound, not actual hardware throughput.
  Full Electron, VS Code, iOS/Android share-sheet painting and primary-composer
  timing/IME acceptance were not run. The experiment is not a release approval.

## Expanded silhouettes

The compact picker now offers 16 shapes (19 remain renderable for saved recipes).
Tall, compact and large are retired from selection without changing existing
faces or color-edit behavior. Twelve added connected geometric
outlines are Yuri-owned, not copied from Grok/bloub reference artwork; Open Mascot
continues to provide expression/motion sampling. No package was added and no
upstream source was modified. Existing opaque seeds keep the original seven-shape
mapping and saved v1 recipes keep their identity. Static and live rendering share
`buildAssistantAvatarScene`; full-body affine motion keeps the eyes attached.

Expanded-shape validation: 74 focused UI tests and 15 focused backend avatar
tests pass, including SQLite persistence/restart for every new shape. UI type
checking, focused ESLint, Settings audit, repository-neutrality, production lab
and full Web builds pass. The dead-code scan has no avatar-module findings.
Chromium checked 384 combinations of new silhouette/eye style/expression setting/
working-animation time: sampled eye boundaries remained inside the connected body
in every case. All twelve shapes rasterized to native PNG with zero differing
RGBA channels versus the source SVG at 128×128. The 350px mobile picker has 16
choices and no horizontal overflow. These are browser/contract checks, not
physical-device frame-rate, power or native-share-sheet acceptance.

## New Bot defaults and one eye specification (2026-10-30)

New Bot defaults are a round body, capsule eyes, neutral rest pose and enabled
animation; only pigment and nonce vary. UI drafts preview the complete recipe and
retain their initial seed for Reset. Backend creates without a caller seed
persist the same v1 recipe, including tool and first-run creation. Explicit
customization is preserved, and existing contacts keep their shape/color.

The first fixed-eye attempt (rejected after visual review) used one specification:
18 × 40 engine units, 52-unit center gap and a backslash lean (-26 degrees in SVG
coordinates). The old two-eye-style
and random-rest-expression metadata stays decodable, but cannot change rendered
eye dimensions. Live blinking and gaze/body projection remain; expression
templates cannot independently enlarge, shrink or rotate the eyes. No reference
project's implementation or extracted motion assets were added.

Public main-branch Atom feeds were compared on 2026-10-30 (GitHub's unauthenticated
API was rate-limited). Latest visible commits:

| Project | Latest commit | Activity in the visible feed |
| --- | --- | --- |
| [Agent Robot Avatar](https://github.com/CX-ArtLab/agent-robot-avatar/commits/main) | 2026-10-29, `d6d46c2` | 20 entries span Oct 5–29, with functional changes, fixes and releases |
| [Grok Bot Avatar Engine](https://github.com/RongleCat/grok-bot-avatar-engine/commits/main) | 2026-10-16, `5b6fc03` | One initial-publication entry |
| [bloub-react](https://github.com/ShunquanWang/bloub-react/commits/main) | 2026-09-04, `d67d8c8` | Last 20 entries are concentrated on Sep 4 |
| [Open Mascot Studio](https://github.com/0oooh/open-mascot-studio/commits/main) | 2026-08-19, `b83ca38` | Last visible activity is Aug 19 |
| [bloub](https://github.com/jeremy-prt/bloub/commits/main) | 2026-08-17, `b4bb3c1` | Last visible activity is Aug 17 |

Agent Robot Avatar is the most actively maintained in this recent sample, but
its core idle eyes are round (54 × 58), not the desired slender Grok-like capsules.
It informs the single-spec approach, not a blind copy of its appearance. For the
capsule proportions, [bloub's pinned measurements](https://github.com/jeremy-prt/bloub/blob/b4bb3c1b5f93c7b87a2e8d620f667c4093d97749/docs/measurements.md)
and [face constants](https://github.com/jeremy-prt/bloub/blob/b4bb3c1b5f93c7b87a2e8d620f667c4093d97749/src/bot/face.ts)
report width/radius 0.186, height/radius 0.412 (aspect ≈ 0.45), 15.46-degree
half-separation and an approximately 26-degree projected rest lean. The common
Yuri geometry follows that aspect/spacing direction without adopting the measured
motion profiles or claiming a pixel-identical reproduction.

That earlier fixed-eye validation: 62 focused UI tests pass, including uniform geometry,
screen-space lean direction, new-draft preview/Reset/save and legacy recipes.
The complete service/contact-tool selection passes 213 tests (3 skipped), covering
the six new-create pigments and SQLite restart persistence. UI type-check and
focused ESLint pass. Chromium verified 171 rest/idle/thinking scenes across all
19 shapes: all 21,888 sampled eye-boundary points remain inside the body. Native
PNG and static SVG match at 128×128 for every shape (0 differing channels out of
1,245,184). At 350px with `mobile-pointer`, the picker has 16 shape choices, no
out-of-bounds buttons and no horizontal overflow. Physical-device performance,
power and native share-sheet acceptance remain unverified.

## DS-Bot visual iteration (2026-10-30)

Reference: [Fei2411/DS-Bot, `f823773`](https://github.com/Fei2411/DS-Bot/tree/f823773b07ec6ca29d60b31c31af30218a68000d).
The reference checkout is inspection-only outside this repository; no DS-Bot
code, character paths, shaded layers or extracted motion assets are bundled.
The project is Apache-2.0, not MIT. Its reference characters were rendered at
the same color and compared alongside Yuri at large, 44px and 36px sizes.

Key evidence:

- `ds-bot/dev/characters.mjs`: offline SDF models, fixed three-quarter camera
  (yaw 34°, pitch 16°, roll 10°), surface-tangent eyes projected into a 100-unit
  box. Runtime avatars are layered SVG, not live WebGL meshes.
- `ds-bot/src/client/characters.js:96–120`: capsules are centered in placement
  groups, with separate gaze and eye groups in a mask. The squircle's eye entries
  are `[52.6,52.4,8.4,22.1,-10]` and `[67.3,46.9,8.4,22.1,-10]`: close spacing,
  a height difference and only a slight lean, not equal-height 26° slashes.
- `ds-bot/src/client/mark.js:19–43`: pointer events are RAF-coalesced into CSS
  gaze variables; `46–79` keeps historical transcript faces static, while live
  faces receive motion and deterministic per-Bot timing offsets.
- `ds-bot/src/client/styles.js:25–40,55–101`: placement, gaze, eye blinking and
  body transforms are separate. Idle uses a five-second double-blink cycle with
  ~260ms blinks, 3% closed height and 6% reopening overshoot at the lively level.
  Thinking uses a 2.2s ponder/squint; searching scans in 1.6s; working uses bob,
  wiggle or squash plus a 2.4s blink. Sending dashes; waiting eyes orbit; completion
  settles over 1.8s. Reduced motion disables animations and transitions.

Yuri now uses one 24×58 capsule specification, center gap 38, -10° lean, pair
offset `(16,-6)` and ±7 vertical staggering. Shape/color persistence and the
new-Bot round default are unchanged. Clover/sparkle seat the pair lower without
changing dimensions; the drop uses the same upstream 2D rig for body and eyes.
No extra eye-style choices are exposed. This iteration changes geometry only;
DS-Bot's nine-state animation vocabulary, masking, petting and CSS keyframes are
research findings, not newly implemented Yuri behavior. Yuri retains its current
idle/thinking/happy sampling, pointer-local events, static transcript/PNG path,
shared 30fps upper-bound clock, visibility suspension and reduced-motion gate.

This iteration passes 66 focused UI tests, UI type-check, focused ESLint and the
full Web production build. Chromium sampled 2,337 idle/thinking/happy scenes over
10 seconds for all 19 shapes: all 224,352 eye-boundary samples stayed inside the
body. Every shape's 128×128 native PNG matched its source SVG with zero differing
channels. The 350px mobile picker retained 16 choices and no horizontal overflow.
The before/after/reference board is a visual comparison, not user acceptance or
proof of physical-device animation throughput.

## Centered eyes and full-size artwork (2026-10-30)

The oblique same-direction eye pair was rejected. The shared pair now has a level,
centered baseline with mirrored -8°/+8° inward lean, rather than two parallel
slashes or a staggered gaze. Dimensions remain 24×58 with gap 38; no per-Bot eye
randomization is restored. Expression templates no longer roll the whole face.

The shared 432-unit canvas left the round body at only 65% occupancy (a 36px slot
painted a roughly 23px body). Recipe-owned per-shape art bounds now give all 19
outlines approximately 94% occupancy and share one fixed viewBox across static,
live, navigation and PNG output. Bounds are precomputed source metadata; there
is no runtime DOM measurement, per-frame path parsing or growing cache. External
rounded masks have been removed from the leaf, working wrapper and Settings
avatar instances so small non-round silhouettes are not clipped into circles.

Validation: 77 focused UI tests pass, including static/live framing at 16/28/36/44px,
mirrored eye direction and unchanged scheduling/visibility guards. UI type-check,
focused ESLint, Settings audit and full Web build pass; the dead-code scan has no
avatar-module findings. Chromium measured 93.4–94.0% longest-axis occupancy across
all 19 shapes. In 342 sampled idle/thinking/happy scenes, body bounds stayed inside
the fixed frame and eye boundaries stayed inside their bodies. All 19 native PNGs
match their source SVG at 128×128. These are geometry/contract checks, not measured
physical-device animation throughput or native share-sheet acceptance.
