# Official mobile WebView vs Flutter — Linux/cloud self-compare

For Flutter 负责人. Inspected `yee94/openchambery` `main` at `fad0278f8` (`v1.19.5-beta.1`). No Flutter branch was edited. No merge.

Mac Capacitor Simulator was unavailable. This is the Linux/cloud substitute: code truth on `packages/ui` + `packages/mobile`, plus hosted `mobile.html` at a 390×844 phone viewport.

---

## Part 3 — Flutter must-match bullets (read this first)

- **Do not port WebView keyboard push.** Official Capacitor WebView manually translates/pads the composer (`translate3d` FLIP on Android, `--oc-kb-layout` shell shrink on iOS, cached IME height ratios, `visualViewport` helpers). Flutter native IME (`viewInsets` / scaffold resize / standard `TextField`) already owns that. Delete any Flutter copy of FLIP, keyboard-height padding, safe-area-as-IME, or `visualViewport` composer lift.
- **Shipping mobile composer has no voice input and no TTS.** Official `ChatInput` mounts `ComposerDictation` with `renderTrigger={false}` (no mic button). TTS is a **message** action (`volume-up`), default **off** (`showMessageTTSButtons`). Do not ship mic / TTS in the Flutter composer.
- **Composer extras are not “mic / TTS / paperclip only”.** Official mobile footer is: **paperclip** (`attachment-2` via `ComposerAttachmentControls`) + optional permission/goal + **Agent** + **Model** + **Send/Stop**. Paperclip is the only media affordance in the shipping footer.
- **「已处理」 header is high-contrast, not washed gray.** Completed label uses `text-foreground/85` + `typography-meta`. Duration is the only muted bit (`text-muted-foreground`). Tool **titles** use `--tools-title` (theme foreground). Descriptions use `--tools-description` (muted at 60% opacity) — do not gray the whole row.
- **Expanded body has a real icon column.** Under the header: `ml-2 pl-3` + 1px `--tools-border` rail. Mobile row block is `py-1`. Icon well is 16px (`size-4`) on mobile. Skill uses `book`. Bash/terminal uses `terminal-box` (zh-CN title **运行**). Skill groups use `book` + chevron.

---

## Part 1 — Code truth

### 1. Manual composer keyboard lift (DELETE on Flutter)

These exist **only** because Capacitor WebView uses `Keyboard.resize: 'none'` and does not shrink the visual viewport like a normal browser. Flutter should not reimplement them.

| File | What it does | Flutter action |
|---|---|---|
| `packages/ui/src/apps/composerKeyboardLift.ts` | Decides whether focus is inside `.oc-mobile-composer`; Android IME open/cache/field; `cssPxFromNativeImeHeight` (native px → CSS px via `devicePixelRatio`) | **DELETE** entire module from any Flutter port |
| `packages/ui/src/apps/MobileApp.tsx` `useNativeMobileChrome` | Capacitor-only. Sets `--oc-keyboard-inset`, `--oc-kb-layout`, `--oc-kb-scroll-inset`. **Android:** `translate3d(0, -slide, 0)` FLIP (~200ms show / ~100ms hide) from cached IME ratio (`openchamber.androidImeHeightRatio.v2`, clamp 0.28–0.68, default 0.39). **iOS:** immediate shell height `100dvh - --oc-kb-layout`, `scrollIntoView({block:'end'})`, no FLIP. Native iOS composer class skips FLIP and only unwinds leftover vars | **DELETE** — use IME insets only |
| `packages/ui/src/styles/mobile.css` (~L2976–3170+) | `:root.oc-capacitor-app` shell height, overlay `bottom: var(--oc-keyboard-inset)`, composer `will-change: transform`, Android scroller `bottom`/`padding-bottom` for FLIP, iOS `--oc-kb-scroll-inset` for question cards | **DELETE** equivalent CSS |
| `packages/mobile/capacitor.config.ts` | `Keyboard.resize: 'none'`, `resizeOnFullScreen: false` — forces JS to own IME geometry | N/A (Capacitor-only). Flutter: keep default IME resize |
| `packages/mobile/android/.../ImeSyncBridge.java` | Zeroes WebView parent padding so SystemBars cannot IME-pad; emits `oc:ime-state` height; paints backdrop above keyboard. Explicitly **does not** `translationY` the WebView (that would drag the header) | **DELETE** — Flutter `WindowInsets.ime` is enough |
| `packages/mobile/ios/.../OpenChamberComposerPlugin.swift` | Native `UITextView` overlay pins to keyboard overlap (`willShow`/`willHide`/`changeFrame`). Not a WebView FLIP, but still a custom IME choreography | **Do not port.** Flutter `TextField` + inset is the native equivalent |
| `packages/ui/src/components/chat/ChatInput.tsx` | Capacitor-only `marginBottom: inputBarOffset` when unfocused | **DELETE** |
| `packages/ui/src/components/chat/useMobileAutocompleteMaxHeight.ts` | `visualViewport.height` / `offsetTop` to clamp slash/@ lists above the IME | **DELETE** — Flutter overlay follows IME |
| `packages/ui/src/components/chat/QuestionCard.tsx` | `visualViewport` reveal; comment: Capacitor `resize:none` keeps a full-height viewport | **DELETE** for Flutter question cards |

Hosted `mobile.html` in a **browser** does **not** add `oc-capacitor-app`. It relies on `dvh` / `interactive-widget`. The FLIP path is Capacitor WebView-only. Flutter is native, so it should behave like “standard IME only,” not like the WebView.

Cached IME hacks to delete if copied:

- `localStorage openchamber.androidImeHeightRatio.v2`
- `localStorage openchamber.iosImeHeightRatio.v1`
- CSS vars `--oc-keyboard-inset`, `--oc-kb-layout`, `--oc-kb-scroll-inset`, `--oc-kb-shift`
- Classes `oc-keyboard-open`, `oc-kb-animating`, `oc-kb-hide`, `oc-kb-caret-hold`
- Events `oc:keyboard-intent`, `oc:keyboard-anim`, `oc:keyboard-settled`, `oc:ime-state`

### 2. Composer affordances (mic / TTS / paperclip)

**Confirmed: official shipping mobile composer does not show mic or TTS.**

Paperclip **is** present. Mic trigger is wired but **hidden**. TTS is not a composer control.

| Affordance | Official shipping mobile? | Component / cite |
|---|---|---|
| Paperclip / attach | **Yes** | `ComposerAttachmentControls` in `ChatInput.tsx` — `Icon name="attachment-2"` (`chat.chatInput.actions.attachFiles`). Compact pill slot `data-mobile-composer-compact-slot="attach"`. Expansion menu flag `ATTACHMENT_EXPANSION_MENU_ENABLED = false` (direct file pick only) |
| Mic / dictation | **No visible button** | `ComposerDictation` (`packages/ui/src/components/dictation/ComposerDictation.tsx`) has a `mic` trigger, but both mobile and desktop `ChatInput` pass `renderTrigger={false}`. Component returns `null` unless `supported && dictationEnabled`. Mobile still mounts the engine+overlay so a recording could survive expand, but there is no footer mic |
| TTS / read-aloud | **Not in composer** | `useMessageTTS` + `MessageBody` `volume-up` action, gated by `showMessageTTSButtons` (**default false** in `useConfigStore`). Voice settings live under Settings, not the composer |
| Agent + model | Yes | `MemoMobileAgentButton` + `MemoMobileModelButton` in `composer-mobile-model-controls` |
| Send / Stop | Yes | `ComposerActionButtons` / `SendCircleIcon` / `StopIcon` |
| Permission auto-accept / Goal | Conditional | `PermissionAutoAcceptButton`, `SessionGoalButton` — not media controls |

`ChatPromptComposer.tsx` also has a default left `attachment-2` button; primary chat uses `ChatInput`’s footer, not that default, for mobile.

**Flutter shipping composer:** paperclip + agent + model + send/stop. No mic. No TTS.

### 3. Expanded activity / tool / skill row (under 「已处理」)

Owner: `TurnActivity` → `ProgressiveGroup` (`packages/ui/src/components/chat/components/TurnActivity.tsx`, `message/parts/ProgressiveGroup.tsx`). Shared chrome: `toolRowChrome.ts`. Icons: `toolPresentation.tsx` `getToolIcon`. Tokens: `cssGenerator.ts` `--tools-*`.

zh-CN:

- `chat.activity.completedStatus` → **已处理**
- `chat.activity.active` → **正在处理**
- `chat.activity.title` → **处理详情**
- `chat.tools.display.skill` → **加载技能**
- `chat.tools.display.bash` → **运行**

#### Header (one full-width row)

- Icon: live non-compaction → `LatticeOrb`; settled → `stack` (`h-3.5 w-3.5`); compaction → `fold-vertical`
- Icon well color: `var(--tools-icon)` (default mutedForeground)
- Status: mobile `typography-meta h-5`. Active → shimmer `--status-info`. **Completed → `text-foreground/85` (high contrast, not washed gray)**
- Duration (settled only): `formatActivityDuration` → `3s` or `1m 12s`, `typography-meta tabular-nums text-muted-foreground`
- Trailer: up to **2** task avatars on mobile (12px), then chevron `arrow-right-s` / `arrow-down-s` (`size-3`, `text-muted-foreground opacity-70`)
- Spacing: mobile `gap-x-1` in the header; icon well `h-5 w-4`; `pr-0` so the chevron has no dead trailing slot
- Geometry: `oc-tool-row -mx-2 rounded-lg px-2 py-0.5`. Hover wash is `color-mix(--surface-foreground 6%, transparent)` — idle rows stay flush with the message body

#### Expanded body

- Wrapper: `relative ml-2 pl-3` (8px + 12px). Left rail: 1px `var(--tools-border)` at 40% opacity
- Each row block: `getToolRowBlockClass(true)` → `flow-root py-1` (**4px** vertical rhythm on mobile; desktop is `py-1.5`)
- Static/skill/context rows: `flex … gap-x-1.5`, icon `size-4` mobile, title `--tools-title` + `opacity-85`, description `--tools-description`
- Default token fallbacks: icon = mutedForeground; **title = surface.foreground**; description = mutedForeground @ 60%; border = interactive.border @ 30%

#### Skill / terminal icons (must match)

| Tool | Icon sprite | Notes |
|---|---|---|
| skill (group) | `book` 13×13 | `SkillToolGroup` — consecutive skills collapse; chevron expands children |
| skill (single static) | `book` | Same `getToolIcon('skill')` |
| bash / shell / cmd / terminal | `terminal-box` | zh-CN label **运行** |
| read | `file-text` | Whole-row nav to file sheet on mobile |
| edit / write | `pencil` / `file-edit` | Expandable `ToolPart` |
| grep / search | `menu-search` | Context group parent uses `search` |
| webfetch | `global` | |
| task | `ai-agent` | Avatars on the **header**, not the row |

Typography: `!text-[length:var(--text-meta)] !leading-5` (`TOOL_ROW_TEXT_CLASS`). Title is `font-medium`.

---

## Part 2 — Hosted `mobile.html` run (Linux)

### What was started

| Step | Result |
|---|---|
| `bun` 1.3.14 + `bun install` | OK (workspace lockfile) |
| `bun run start:web` (`packages/web` `node bin/cli.js serve`) | Needs `packages/web/dist` **and** an `opencode` binary. Dist was missing until `bun run build:web`. `opencode` is absent here; server blocks in `sh -lic command -v opencode` (`env-runtime.js`) so `/health` never returns |
| Documented equivalent `bun run dev` (HMR, Vite `:5180` + API `:3902`) | Vite served `mobile.html` HTML, but `/src/mobile-main.tsx` 404’d as a module while the API event loop was stuck on the OpenCode lookup |
| `bun run build:web` then static `dist/mobile.html` on `:4173` | **This is the official production mobile entry.** Puppeteer 390×844 captured it |

Chat/tabs were not reachable: no OpenCode, so `SessionAuthGate` cannot verify `/auth/session` against a live host. Official fallback is the splash, then **Unable to reach server**. That matches the task: capture the shell and finish Part 1 from code.

### Screenshots (filenames)

All under `docs/reviews/flutter-official-mobile-webview-linux/` (also copied to `/opt/cursor/artifacts/flutter-webview-parity/` for the PR).

| File | What it shows |
|---|---|
| `01-mobile-html-initial-390x844.png` | Hosted mobile splash: cream `#fffdf4` canvas + centered OpenChamber cube (official `mobile.html` pre-paint + `LoadingScreen`) |
| `02-mobile-html-settled-390x844.png` | Auth-gate error shell after session check fails: **Unable to reach server** heading (`typography-h3 text-foreground`) + muted body. High-contrast title, not washed gray |
| `03-mobile-html-intercept-shell-390x844.png` | Same splash after a longer wait (React mounted, `device-mobile` + `mobile-pointer` on `<html>`) |
| `08-mobile-html-dark-390x844.png` | Repeat splash frame (dark `localStorage` did not win over the light splash tokens in this headless pass) |

Viewport: 390×844, `deviceScaleFactor: 2`, iPhone UA, touch.

---

## Environment limits (so Flutter does not over-read the screenshots)

- No Mac Capacitor Simulator — no real IME, no native iOS composer glass, no Android `adjustNothing` FLIP on device.
- No `opencode` CLI — no projects/sessions/chat transcript, so activity rows and composer footer were **not** painted. Those contracts are cited from React source above.
- Hosted browser `mobile.html` never applies `oc-capacitor-app`, so keyboard FLIP CSS is inactive in these shots (correct: Flutter should also stay on standard IME).

Validated: `bun install`, `bun run build:web` (produced `dist/mobile.html`), Puppeteer capture against that bundle. Not validated: live Capacitor IME, native iOS overlay, or a real chat turn.
