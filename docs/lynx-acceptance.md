# Lynx mobile rewrite — acceptance

Independent track: **`work/lynx-native`**. Do **not** merge to `main`. Do **not** hand verification to the user as the plan.

This file defines when a Lynx change is done. It is stricter than “the PR builds”. The only ship bit is **真机过**.

---

## 三关

| # | Gate | Owner | Pass | Fail examples |
|---|---|---|---|---|
| 1 | **代码接上** | The author of the slice | Real OpenChamber / OpenCode routes, real identity, failure surfaces as failure | Demo catalog, fixture session rows, hardcoded tokens, fetch error painted as empty |
| 2 | **CI绿** | Track CI on `work/lynx-native` | The jobs that match the claim are green on that SHA | Linux analyze only; ignored red iOS; “works on my laptop” |
| 3 | **真机过** | Author + written device log | Physical iPhone and/or Android, real server, the claimed path exercised | Simulator, emulator, golden PNG, “please try this” in the PR |

**Only 真机过 = done.** 代码接上 + CI绿 without a device log stays on `docs/lynx-gap-board.md` as 真机残差 or missing.

A cloud / Linux agent that cannot run Xcode or adb must:

1. Still complete 代码接上 and as much CI as the environment allows.
2. Add a **self-built harness** (below) so a later device run is mechanical, not improvisational.
3. Write `真机过: not executed (environment: …)` on the gap board. Never tick it.

---

## What “代码接上” means

Copied from Cap/web invariants (`AGENTS.md`, `ui-api-decoupling`):

- Official OpenCode calls go through the SDK shape, not a guessed REST client.
- OpenChamber routes are the real paths (`/health`, `/auth/session`, `/api/openchamber/session-index`, pairing redeem, assistants snapshot, …).
- Transport identity and directory are captured **at call time**. Instance switch clears client state.
- Failure ≠ empty success. One failed provider/quota/project must not erase the others.
- Pairing persists the **full** LAN + relay candidate set. Relay-only payloads must not sit on a LAN headstart timer.
- Tokens live in Keychain/Keystore. Logs never print them.
- Chat list is 1.19 LegendList semantics (`docs/lynx-feature-inventory.md`). A TanStack-style split list is an automatic 代码接上 fail.

Definition of done for a settings slug: the page reads and writes the same blob/route Cap uses, or the row is absent. A pretty empty form is not 接上.

---

## What “CI绿” means

Until Lynx CI exists, **CI绿 is itself missing** (`docs/lynx-gap-board.md` → Next item 7). Target shape, modeled on `packages/mobile/HANDOFF.md` and the Flutter track’s lesson that Linux-only is never green:

| Job | Required for |
|---|---|
| Typecheck / lint / unit tests (Lynx + any host glue) | every PR |
| Android `assembleDebug` (or Lynx Android package) producing an APK with `com.yee94.openchamber.debug` or a **documented** new id that is also in `google-services.json` | any Android claim |
| iOS simulator build (no codesign) | any iOS claim |
| List-engine / IME / connect harness tests | chat or connect slices |

Forbidden CI theater:

- Green analyze + skipped native jobs
- Citing a red iOS run as “mostly green”
- Reusing Capacitor `mobile-ci.yml` as proof that Lynx works

Capacitor CI remaining green on `main` is **unrelated**. This track must not break `packages/mobile` while adding Lynx.

---

## What “真机过” means

Write a short log in the gap board or the PR, not a vibe:

```text
device: <model, OS>
build: <git SHA, version>
server: <LAN and/or relay; no secrets>
path: <connect → projects → chat send → back>
result: pass | fail + residual
```

Minimum paths when the slice claims them:

| Slice | Device path |
|---|---|
| Connect | QR or pasted v2 link; kill app; auto-reconnect; delete-active → connect |
| Projects | Real session-index rows; open a session; back to dock |
| Chat | Send, stream, Stop, queue-while-busy, load-older button, Chinese IME compose + send |
| Keyboard | Focus composer, type, hide keyboard, occupancy of queue/Changes unchanged |
| Push (if claimed) | Background notification tap → correct session |
| Share (if claimed) | Generic Android share → picker → composer (no silent default) |

iOS glass and Android blur are **different** passes. An iPhone 真机过 does not cover Android.

---

## Own acceptance vs official WebView

Lynx is a **rewrite**, not a WebView skin. Acceptance is **parity of product behavior** with Capacitor `MobileApp`, not pixel-identical WKWebView.

### Compare against

| Official source | Use for |
|---|---|
| Capacitor / shared UI on `main` | Behavior, routes, slugs, list semantics |
| `docs/references/mobile_projects.png` | Projects IA: collapsing title, cards, dock, session rows |
| `docs/references/mobile_schedules.png` | Scheduled IA |
| `docs/references/mobile_chat.png`, `chat_mobile_dark.png` | Chat IA: pushed page, composer foot, no fifth tab |
| `packages/mobile/README.md` | Native contracts (share, back, Live Activity, package id) |
| This doc + pitfalls | Gates and forbids |

### Do not compare against

| Source | Why |
|---|---|
| Flutter `docs/flutter-native-screenshots/` goldens | Sibling track; different runtime; their “精致” loop is not this gate |
| Expo / generic Lynx gallery apps | Wrong product |
| Desktop `MainLayout` | Different IA |
| A locally restyled WebView | That is Cap, not Lynx |

### Parity rules

1. **IA first:** four tabs, chat pushed, 21 settings slugs, pairing v2. Visual polish is later.
2. **Behavior over pixels:** send/queue/abort, session index, relay fallback, failure handling.
3. **Glass is embedding-dependent** (`docs/lynx-ia-ui.md`). A full-page Lynx glass dock is wrong if the host already owns `UITabBar`.
4. **Android is allowed to look lesser** (gap board Android降级). It is not allowed to be unable to connect, send, or list sessions.
5. Official WebView remaining the production client does **not** lower Lynx’s bar. “Users can still use Cap” is not acceptance.

When IA conflicts: **code on `main` + official `docs/references/mobile_*.png` win**. Flutter screenshots and agent taste lose.

---

## Self-built performance harness (do not dump this on the user)

The author of a chat/list/navigation slice owns a harness that can run without a reviewer improvising DevTools.

### Required harnesses (add as the slice lands)

| Harness | Purpose | Precedent |
|---|---|---|
| **Session-open / switch** | Time-to-first-stable-frame at live edge; no pin yank after markdown hydrate | `docs/performance/session-switch-2026-07-11.md` + `scripts/perf/analyze-session-switch-trace.py` |
| **List prepend** | Load-older keeps the same turn under the finger (`maintainVisibleContentPosition`) | `TimelineList.tsx` contract tests |
| **Streaming grow** | `maintainScrollAtEnd` while pinned; no follow when user scrolled away | LegendList flags, not a watchdog timer |
| **IME occupancy** | Collapsed composer height published; queue/Changes do not jump on keyboard | Cap occupancy CSS variables — re-specify in Lynx units |
| **Connect race** | LAN headstart then relay; relay-only skips the wait | `packages/lynx/src/connection/probe.test.ts` (Lynx) / `mobileConnections.ts` (Cap) |
| **Instance switch** | Query/runtime identity cleared; no token leak across servers | `packages/lynx/src/session-index/store.test.ts` + ui-api-decoupling |

### How to run them without a user

1. **Unit / component tests** in the Lynx package (list math, pairing parse, back-stack, settings slug map). These are gate 2.
2. **Scripted host harness** (preferred for 真机): a debug build that accepts `openchamber://` + a JSON scenario (open session, send fixture, scroll, load-older) and writes timings to a file the PR can attach.
3. **Trace analysis** if Lynx/DevTool can export a trace: reuse the session-switch script’s *metrics*, not its Electron assumptions.

Do not:

- Ask the maintainer to “just scroll a big chat and see”
- Treat WidgetTester / screenshot MAE as performance
- Claim Cap’s session-switch numbers as Lynx numbers

Until a harness exists, a chat slice cannot be 真机过 for performance — only for smoke (“I sent one message”).

### Suggested first metrics (record, then tighten)

| Metric | Starting budget (smoke) | Notes |
|---|---|---|
| Session open → live-edge visible | measure first, then cap | Hidden until seed markdown ready (Cap `markdownPinReveal`) is allowed |
| History prepend jump | 0 visible yank of the anchor turn | Hard fail if the live edge jumps |
| Keyboard show → composer settled | measure | No FLIP guess |
| Connect LAN success | < pairing timeout | Must not wait the LAN headstart when the payload is relay-only |

Budgets become gates only after two device traces exist. Inventing a p95 before a harness is theater.

---

## Host embedding vs system Tab / Nav chrome

Lynx 3.8 can embed a page in a host `LynxView` with `auto-width` / `auto-height` (see [Lynx 3.8](https://lynxjs.org/next/blog/lynx-3-8)). **Full-page auto skin of Tab/Nav is not free.** It depends on who owns chrome.

| Embedding | Who paints Tab / Nav | Lynx page responsibility | Auto glass skin? |
|---|---|---|---|
| **A. Full-page Lynx** | Lynx (or Lynx `<blur-view>` dock) | Four tabs + safe areas + home indicator | Yes — Lynx may use official glass (`docs/lynx-ia-ui.md`) |
| **B. Host chrome** | iOS `UITabBarController` / Android system or Material nav | Content only; report occupancy / safe-area | **No** — do not draw a second dock |
| **C. Hybrid (Cap today)** | Web dock, optional iOS 26 overlay | JS still owns the tab id | Lynx should **not** copy this. Pick A or B |

Acceptance implications:

- A PR that adds both a host `UITabBar` **and** a Lynx floating dock has failed IA.
- Chat is never a tab item in A or B.
- Secondary pages (chat, assistant conversation, instances, settings detail) hide host tab chrome the same way Cap hides `OpenChamberTabBar` (`packages/mobile/README.md`).
- Sheets/overlays are not tab items and not push pages.

Chosen mode is written at the top of `packages/lynx/README.md` (Mode B iOS 26 host chrome; Mode A older iOS + Android). Gap board: scaffold landed; device host still missing.

---

## Slice acceptance templates

### Connect slice

- [ ] 代码接上: redeem v2 on a reachable candidate; persist lan+relay; auto-connect; password unlock
- [ ] CI绿: unit tests for payload parse (v1 rejected) + debug APK
- [ ] 真机过: QR on a phone against a real server; airplane mode → relay if claimed
- [ ] Harness: connect race test (relay-only does not sleep 1.5s)
- [ ] No Bonjour

### Chat list slice

- [ ] 代码接上: LegendList semantics; official send/abort; session-index identity
- [ ] CI绿: list contract tests (end open, prepend, no recycle)
- [ ] 真机过: long transcript, load-older, IME send
- [ ] Harness: session-open + prepend traces attached or command documented
- [ ] No TanStack 1.18 split

### Settings slug slice

- [ ] 代码接上: listed slugs hit real routes; failure preserved
- [ ] CI绿: slug map test equals `MOBILE_SETTINGS_PAGE_SLUGS`
- [ ] 真机过: search → page → mutate → reopen
- [ ] Voice either real or omitted

---

## Related

- `docs/lynx-feature-inventory.md` — what exists on Cap/web
- `docs/lynx-pitfalls.md` — 三关 + forbids
- `docs/lynx-gap-board.md` — where each row sits
- `docs/lynx-ia-ui.md` — glass + embedding
- `docs/performance/session-switch-2026-07-11.md` — how this repo already writes gates

## Notes — settings / connect / header / CI (2026-09-06)

- Settings slug DoD: wired pages use real `/api/config/settings` or list endpoints; catalog editors stay labeled stubs (never fake-success). Voice remains list-only-until-routes. No `iosNativeUi`.
- Connect welcome: splash while `autoConnectLastInstance` resolves; paste pairing v2; QR camera host stub.
- Projects header: Cap `MobileTabPageHeader` collapse contract (`--oc-mobile-title-collapse` spirit) with Lynx glass search chip + primary +.
- CI: `packages/lynx/ci/lynx-ci.yml` → install as `.github/workflows/lynx-ci.yml` (needs `workflow` token scope) is Linux type-check + vitest + rspeedy only. APK/iOS simulator jobs need Mac/Android runners — **do not claim 真机过** from this workflow.

## Notes — cards / swipe / share welcome / draft / list harness (2026-09-06)

- **Rich turn cards:** Cap message parts (`text` / `reasoning` / `tool` / `file` / `agent` + other rawType). Activity disclosure collapses detail rows (`collapsedPreviewCount = 0` spirit). Question/permission cards load Cap `/question` + `/permission` and reply on official paths — not invented part types.
- **Projects session menu:** `sessionMenuModel` order (pin / share / archive / delete). Long-press sheet calls real pin (session-index) + archive/delete (`PATCH`/`DELETE /session/:id`).
- **Share welcome:** Cap `AssistantShareWelcome` storage key + example cards on Assistant tab above share inbox.
- **Draft composer:** secondary `kind: 'draft'` body materializes via `POST /session` then `prompt_async` — never a fake chat id.
- **List perf harness:** `src/harness/listPerfHarness.ts` records synthetic streaming cadence and prepend-anchor retention. Cap cadence notes (`20/64` default, `100/128` Android from `streamingRenderCadence.ts`) are documented anchors — **`deviceMeasured: false`**; no invented 真机 p95.
- 真机过: **not executed** (Linux cloud agent).

## Notes — SSE live tail / IME contract / nested stack (2026-09-06)

- **SSE live tail:** Cap `/api/global/event` (SSE; WS sibling `/api/global/event/ws`). Lynx parses Cap/OpenCode envelopes (`liveEvents.ts`) and folds matching `message.*` / `session.status` into the **same** LegendList timeline — no TanStack split, no separate live overlay. Idle → queue flush + pending-card reload.
- **IME occupancy:** `imeOccupancy.ts` locks host-binds-IME, collapsed-height-only occupancy, Chinese composition passthrough, list-footer inset. **No** WebView FLIP / ImeSyncBridge. Host keyboard wiring still required for 真机过.
- **Nested child stack:** Cap `reconcileMobileChatPredecessor` + back pop mirrored (`reconcileLynxChatPredecessor`, ShellApp back decision). Predecessor chrome labeled on chat header.
- 真机过: **not executed** (Linux cloud agent).
