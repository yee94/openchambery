# Assistant procedural avatar experiment

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
for twenty live-list entries and scroll to verify offscreen suspension.

Production integration lives in `AssistantsSettingsPage` and the shared
`AgentAvatar kind="assistant"` boundary. Configurations use the existing
revision-checked `avatarSeed` mutation and SQLite persistence, not this demo key.
Primary coding-agent faces and app branding remain unchanged.

Browser acceptance: choose shape tiles and color swatches; reset; save and
reload; change light/dark and language; check 350px touch and desktop widths;
emulate reduced motion; scroll faces out of view; verify that native PNG and the
saved static face match. Native-device share-sheet painting and full desktop,
VS Code and Capacitor runtime acceptance remain separate checks.

## Experiment evidence (2026-10-30)

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
