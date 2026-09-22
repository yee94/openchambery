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
- [x] Voice status + model download/delete (no invented ASR); mic/WS host-bound

---

## Related

- `docs/lynx-feature-inventory.md` — what exists on Cap/web
- `docs/lynx-pitfalls.md` — 三关 + forbids
- `docs/lynx-gap-board.md` — where each row sits
- `docs/lynx-ia-ui.md` — glass + embedding
- `docs/performance/session-switch-2026-07-11.md` — how this repo already writes gates

## Notes — settings / connect / header / CI (2026-09-06)

- Settings slug DoD: wired pages use real `/api/config/settings` or list endpoints; catalog editors stay labeled stubs (never fake-success). Voice = status + Cap LOCAL_STT model select (`sttLocalModel` PUT) + download/delete UI (no invented ASR; preview/browser TTS/say labeled unavailable). No `iosNativeUi`.
- Connect welcome: splash while `autoConnectLastInstance` resolves; paste pairing v2; QR camera host stub.
- Projects header: Cap `MobileTabPageHeader` collapse contract (`--oc-mobile-title-collapse` spirit) with Lynx glass search chip + primary +.
- CI: `.github/workflows/lynx-ci.yml` + `lynx-mobile-ci.yml` are **live** on tip (`work/lynx-native`). lynx-ci = Linux type-check + vitest + rspeedy (green). lynx-mobile-ci = Android sideload APK (`assembleRelease` + `.debug` applicationId) + prerelease `lynx-v2-debug-*` (e.g. `lynx-v2-debug-b170e47`). Android first-paint cream/globalProps mitigation is 代码接上 — **not** 真机过. iOS IPA / simulator still missing. **Do not claim 真机过** from CI alone. Product NOT DONE / 三关未齐.

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

## Notes — Voice STT select + Changes dirty badge (Next #34 / 2026-09-07)

- Tip / prerelease APK: `lynx-v2-debug-b170e47` (release exists; tip was previously documented as `1a5c899`).
- VoiceBody: Cap `LOCAL_STT_MODELS` radio → `PUT /api/config/settings` `{ sttLocalModel }` + status refresh with `localModel`; optional `dictationEnabled`; keep #71 download/progress/delete; preview / browser TTS / say labeled unavailable.
- Overflow Changes: Cap `dirtyChangeCount` from git status entry count when ok; no-runtime/failure → no fake badge.
- Product **NOT DONE** / 三关未齐 / not EXHAUSTED / 真机残差 empty / no 真机过 claim.

## Notes — PermissionCard metadata + permission auto-accept (Next #35 / 2026-09-07)

- Tip / prerelease APK: may still be `lynx-v2-debug-b170e47` until mobile-ci rebuilds — do not invent APK SHA.
- Permission metadata: Cap `metadata: Record<string, unknown>` parsed on pending `/permission`; LynxPermissionCard renders Cap bash/edit/write/webfetch/generic tool content as **plain Lynx text** (no WorkerHighlightedCode / DiffPreview DOM).
- Auto-accept: Cap `GET /api/permission-auto-accept` + `PUT …/sessions/:id` + nearest-ancestor lineage; Chat + Draft composer toggles; client auto-replies `once` when enabled; failed reply keeps the card (never fake-success). Cap server runtime remains authoritative.
- Product **NOT DONE** / 三关未齐 / not EXHAUSTED / 真机残差 empty / no 真机过 claim.

## Notes — Cap share-recipient picker (Next #36 / 2026-09-07)

- Tip / prerelease APK: `lynx-v2-debug-93b4355` (base tip `93b43558`); do not invent a newer APK SHA until mobile-ci rebuilds.
- JS picker: Cap `MobileShareRecipientPicker` full-page overlay (never a sheet) + `NativeShareDraft` Partial target + bridge unassigned→picker / assigned→POST share; cancel drops without inventing success; never silent-default Assistant.
- Host-only (separate): iOS Share Extension / Android `ShareReceiverActivity` — not claimed by this Linux-closable JS slice.
- Product **NOT DONE** / 三关未齐 / not EXHAUSTED / 真机残差 empty / no 真机过 claim.

## Notes — Projects menus + session share (Next #37 / 2026-09-07)

- Tip APK: `lynx-v2-debug-0b470a2` (work/lynx-native @ `0b470a21`). Do not invent a newer APK SHA until mobile-ci rebuilds.
- ProjectsHome wires Cap-parity project/worktree long-press menus + session share/copyLink/unshare against OpenCode `/session/:id/share`. Linux-closable newSession/sync/edit/close/worktree use real Cap HTTP when reachable; otherwise labeled unavailable (no fake-success).
- Product **NOT DONE** / 三关未齐 / not EXHAUSTED / 真机残差 empty / no 真机过 claim.

## Notes — QueuedMessageChips + SessionGoalRow (Next #38 / 2026-09-07)

- Tip APK: `lynx-v2-debug-905c42e` (work/lynx-native @ `905c42ef`). Do not invent a newer APK SHA until mobile-ci rebuilds.
- Queue chips: Cap `QueuedMessageChips` spirit above composer glass; Lynx local `composerActions` queue with remove / send-now / portable ↑/↓ reorder. Cap `@dnd-kit` + server `/api/openchamber/message-queue` deferred (documented).
- SessionGoal strip: Cap `SessionGoalRow` — status/objective/elapsed/tokens + pause/resume via GET+PATCH session metadata; objective file route when present; never fake-success.
- MobileSessionStatusBar: deferred in #38; slim strip landed in Next #39 (full Cap sheet still deferred).
- Product **NOT DONE** / 三关未齐 / not EXHAUSTED / 真机残差 empty / no 真机过 claim.

## Notes — MobileSessionStatusBar slim strip (Next #39 / 2026-09-08)

- Tip APK: `lynx-v2-debug-ca32a72` (work/lynx-native @ `ca32a72c`; release exists). Do not invent a newer APK SHA until mobile-ci rebuilds.
- Slim strip only: related session chips + Cap busy/working indicator above composer with SessionGoal + queue chips. Full Cap `MobileSessionStatusBar.tsx` (~1900 lines) sheet chrome deferred.
- Helpers: Cap filter / preserve-active-project resolvers + session-index related list; shell chip → openChat; "All" → Projects home analogue.
- Product **NOT DONE** / 三关未齐 / not EXHAUSTED / 真机残差 empty / no 真机过 claim.

## Notes — Cap server message-queue client (Next #41 / 2026-09-08)

- Tip APK: `lynx-v2-debug-c02f917` (work/lynx-native @ `c02f917f`; release exists). Do not invent a newer APK SHA until mobile-ci rebuilds.
- Thin Cap `/api/openchamber/message-queue` client (`messageQueueServer.ts`) over `LynxRuntimeFetch`: list/admit/reorder/remove/send-now (flush = send-now first). Honest parse; no-runtime/HTTP never fake-success.
- `composerActions` prefers server when reachable; unavailable → local queue. QueuedMessageChips keep portable ↑/↓ (no `@dnd-kit` / no TanStack).
- Full Cap sessions sheet / TanStack MQ sync still deferred; host-only unchanged.
- Product **NOT DONE** / 三关未齐 / not EXHAUSTED / 真机残差 empty / no 真机过 claim.

## Notes — Cap SessionsSheet two-step archive + unarchive undo (Next #45 / 2026-09-08)

- Tip APK: `lynx-v2-debug-a1ea85e` (work/lynx-native @ `a1ea85e0`; release exists). Was stale `fd333a0` — do not invent a newer APK SHA until mobile-ci rebuilds.
- `unarchiveLynxSession`: Cap `unarchiveSession` → PATCH `/session/:id` `{ time: { archived: 0 } }`; mirrors archive error shape; never fake-success.
- SessionsSheet: Cap two-step row archive (`confirmingArchive` / request / confirm) + portable ~10s undo banner/chip; long-press archive uses the same undo helper + session-index refresh.
- Deferred at #45 merge: Cap toast lib / bulk multi-select / ArchivedSessionsDialog (closed in #46) / smart-title / `@dnd-kit` / MobileWindowMotion / iPad sidebar / host-only.
- Product **NOT DONE** / 三关未齐 / not EXHAUSTED / 真机残差 empty / no 真机过 claim.

## Notes — Cap ArchivedSessionsDialog (Next #46 / 2026-09-08)

- `listLynxArchivedSessions`: Cap `experimental.session.list({ archived: true, roots: true })` → OpenChamber `GET /api/experimental/session`; paginated; failure ≠ empty.
- `LynxArchivedSessionsDialog`: Cap project-bucket → session list → restore (`unarchiveLynxSession`) + preview; honest empty/load/no-runtime.
- SessionsSheet entry: footer + undo-banner **View archived** (Cap secondary). Session-index supplies labels only (index drops archived roots).
- Deferred: bulk multi-select / smart-title / Cap toast lib / `@dnd-kit` / MobileWindowMotion / iPad sidebar / host-only.

## Notes — Cap MCP sheet live status + connect/disconnect (Next #54 / 2026-09-10)

- Tip APK: `lynx-v2-debug-7c5a135` (work/lynx-native @ `7c5a135a9`; release exists). Do not invent a newer APK SHA until mobile-ci rebuilds.
- Cap `McpDropdownContent` / `useMcpStore` parity: chat MCP sheet loads `GET /mcp` status ∪ `/api/config/mcp` configs; status disc + Cap Switch ON/OFF → `POST /mcp/{name}/connect|disconnect`; refresh; busy guard.
- Honesty: no-runtime / HTTP failure never fake ON; `needs_auth` / `needs_client_registration` labeled (OAuth system browser stays host-only — not invented).
- Vitest: `packages/lynx/src/chat/mcpSheet.test.ts`.
- Product **NOT DONE** / 三关未齐 / not EXHAUSTED; 真机残差 keeps Connect welcome style confirmation open for Yee; no 真机过 claim.

## Notes — Connect welcome elevated card chrome (Next #55 / 2026-09-10)

- Tip base: `5239dd7e6` (work/lynx-native after PR #93). Published APK honesty stays `lynx-v2-debug-7c5a135` — do not invent a newer APK SHA until mobile-ci rebuilds.
- Residual after cssVar→hex: cream `#fffdf4` ≈ elevated `#fbfaf2` made done-phase cards look flat on Android softemu. Chrome: 1px `interactive.selection` solid border + radius 12 + elevated fill + optional soft boxShadow on pending-password / paste / add-instance / scan-QR.
- Page background remains cream hex. No new palette colors; hex-only (no `var()`).
- Product **NOT DONE** / 三关未齐 / not EXHAUSTED; 真机残差 = Connect welcome **card chrome** confirmation for Yee; no 真机过 claim.

## Notes — Docs tip APK/SHA honesty (Next #56 / 2026-09-10)

- Tip / prerelease APK: `lynx-v2-debug-eca4a03` (work/lynx-native @ `eca4a0305`; PR #94 / Next #55 MERGED; release exists). Was stale `lynx-v2-debug-7c5a135` / tip bases `5239dd7e6`/`7c5a135a9`. Do not invent a newer APK SHA than the published tag.

## Notes — Cap header swipe → sessions + transcript sync hint (Next #57 / 2026-09-10)

- Cap `useHeaderSwipeToSessions` portable TS machine + ChatScreen/shell wire (`onOpenSessionsSheet` / back). Host pan via `headerSwipeDispatchRef` — same honesty as edge-swipe (do not fake native pan success).
- Cap `useMobileTranscriptSyncHint` resolve + show-delay/hide-grace smoother. Inputs: timeline hydrate / overflow refresh / SSE live-tail phase only — **no** Cap Zustand sync stores. Header subtitle when syncing.
- Tip / prerelease APK: `lynx-v2-debug-489336a` (work/lynx-native @ `489336a34`; PR #95 / Next #56 MERGED; release exists). Was stale `lynx-v2-debug-eca4a03` / tip `eca4a0305`. Do not invent a newer APK SHA than the published tag.
- Product **NOT DONE** / 三关未齐 / not EXHAUSTED. 真机残差 unchanged: Connect welcome **card chrome** confirm still open for Yee. No 真机过 claim.
- Cap phone skim found no new Linux-closable Cap product gap outside deferred thin leftovers (`@dnd-kit` / MobileWindowMotion / iPad sidebar / Cap toast sonner / bulk multi-select) and host-only — docs honesty only.
- Product **NOT DONE** / 三关未齐 / not EXHAUSTED; 真机残差 = Connect welcome **card chrome** confirmation for Yee; no 真机过 claim.

## Notes — Cap Files sheet search (Next #58 / 2026-09-10)

- Cap `MobileFilesSurface` search via `GET /api/find/file` — Lynx `searchLynxFiles` + Files sheet debounce ~250ms / maxResults 40; tap → text preview. failure ≠ empty; empty query stays browse.
- Base tip / prerelease APK at merge: `lynx-v2-debug-4d871ba` (work/lynx-native @ `4d871bad0`; PR #96 / Next #57 MERGED; release existed). Tip later advanced — see Next #59 tip honesty.
- Product **NOT DONE** / 三关未齐 / not EXHAUSTED. 真机残差 unchanged: Connect welcome **card chrome** confirm still open for Yee. No 真机过 claim.

## Notes — Docs tip APK/SHA honesty post-#58 (Next #59 / 2026-09-10)

- Tip / prerelease APK: `lynx-v2-debug-53ea9cd` (work/lynx-native @ `53ea9cdee4`; PR #97 / Next #58 MERGED; release exists). Was stale `lynx-v2-debug-4d871ba` / tip `4d871bad0`. Do not invent a newer APK SHA than the published tag.
- Cap phone skim (MobileApp / Files / Changes / SessionsSheet / chat header-swipe+sync / overflow vs `packages/lynx`) found no new Linux-closable Cap product gap outside deferred thin leftovers (`@dnd-kit` / MobileWindowMotion / iPad sidebar / Cap toast sonner / bulk multi-select) and host-only — docs honesty only.
- Product **NOT DONE** / 三关未齐 / not EXHAUSTED. 真机残差 unchanged: Connect welcome **card chrome** confirm still open for Yee on tip APK `lynx-v2-debug-53ea9cd`. No 真机过 claim. Host-only unchanged (Keychain/camera/IME/Pierre/WKWebView/Mode B/Share ext/iOS IPA).

## Notes — Docs tip APK/SHA honesty post-#59 (Next #60 / 2026-09-10)

- Tip / prerelease APK: `lynx-v2-debug-5ae491f` (work/lynx-native @ `5ae491f6a3`; PR #98 / Next #59 MERGED; release exists). Was stale `lynx-v2-debug-53ea9cd` / tip `53ea9cdee4`. Do not invent a newer APK SHA than the published tag.
- Cap phone skim (MobileApp / Files / Changes / SessionsSheet / chat header-swipe+sync / overflow / MCP vs `packages/lynx`) found no new Linux-closable Cap product gap outside deferred thin leftovers (`@dnd-kit` / MobileWindowMotion / iPad sidebar / Cap toast sonner / bulk multi-select) and host-only — docs honesty only.
- Product **NOT DONE** / 三关未齐 / not EXHAUSTED. 真机残差 unchanged: Connect welcome **card chrome** confirm still open for Yee on tip APK `lynx-v2-debug-5ae491f`. No 真机过 claim. Host-only unchanged (Keychain/camera/IME/Pierre/WKWebView/Mode B/Share ext/iOS IPA).

## Notes — Docs tip APK/SHA honesty post-#61 (Next #62 / 2026-09-11)

- Tip / prerelease APK: `lynx-v2-debug-773dd98` (work/lynx-native @ `773dd989b9`; PR #100 / Next #61 MERGED; release exists). Was stale `lynx-v2-debug-5ae491f` / tip bases `5ae491f6a3` / `c8a72d6025`. Do not invent a newer APK SHA than the published tag.
- Cap phone skim (MobileApp / Files / Changes / SessionsSheet / chat header-overflow / MCP / ProjectsHome / Assistant / Scheduled / Settings key flows vs `packages/lynx`) found no new Linux-closable Cap product gap outside deferred thin leftovers (`@dnd-kit` / MobileWindowMotion / iPad sidebar / Cap toast sonner / bulk multi-select) and host-only — docs honesty only.
- Product **NOT DONE** / 三关未齐 / not EXHAUSTED. 真机残差 unchanged: Connect welcome **card chrome** confirm still open for Yee on tip APK `lynx-v2-debug-773dd98`. No 真机过 claim. Host-only unchanged (Keychain/camera/IME/Pierre/WKWebView/Mode B/Share ext/iOS IPA/FCM for lynx.debug / Live Activity).
## Notes — Docs tip APK/SHA honesty post-#62 (Next #63 / 2026-09-11)

- Tip / prerelease APK: `lynx-v2-debug-dda945b` (work/lynx-native @ `dda945b12`; PR #101 / Next #62 MERGED; release exists). Was stale `lynx-v2-debug-773dd98` / tip `773dd989b9`. Do not invent a newer APK SHA than the published tag.
- Cap phone skim (MobileApp overflow / Files / Changes incl. stageAll/unstageAll/revertAll / SessionsSheet / chat header-swipe+sync hint / MCP sheet / ProjectsHome / Assistant / Scheduled / Settings key flows vs `packages/lynx`) found no new Linux-closable Cap product gap outside deferred thin leftovers (`@dnd-kit` / MobileWindowMotion / iPad sidebar / Cap toast sonner / bulk multi-select) and host-only — docs honesty only.
- Product **NOT DONE** / 三关未齐 / not EXHAUSTED. 真机残差 unchanged: Connect welcome **card chrome** confirm still open for Yee on tip APK `lynx-v2-debug-dda945b`. No 真机过 claim. Host-only unchanged (Keychain/camera/IME/Pierre/WKWebView/Mode B/Share ext/ShareReceiverActivity/iOS IPA/FCM for lynx.debug/Live Activity/clipboard host).

## Notes — Docs tip APK/SHA honesty post-#63 (Next #64 / 2026-09-11)

- Tip / prerelease APK: `lynx-v2-debug-2384ea6` (work/lynx-native @ `2384ea6c95`; PR #102 / Next #63 MERGED; release exists). Was stale `lynx-v2-debug-dda945b` / tip `dda945b12`. Do not invent a newer APK SHA than the published tag.
- Cap phone skim (MobileApp overflow / Files / Changes incl. stageAll/unstageAll/revertAll / SessionsSheet / chat header-swipe+sync hint / MCP sheet / ProjectsHome / Assistant / Scheduled / Settings key flows vs `packages/lynx`) found no new Linux-closable Cap product gap outside deferred thin leftovers (`@dnd-kit` / MobileWindowMotion / iPad sidebar / Cap toast sonner / bulk multi-select) and host-only — docs honesty only.
- Product **NOT DONE** / 三关未齐 / not EXHAUSTED. 真机残差 unchanged: Connect welcome **card chrome** confirm still open for Yee on tip APK `lynx-v2-debug-2384ea6`. No 真机过 claim. Host-only unchanged (Keychain/camera/IME/Pierre/WKWebView/Mode B/Share ext/ShareReceiverActivity/iOS IPA/FCM for lynx.debug/Live Activity/clipboard host).

## Notes — Docs tip APK/SHA honesty post-#64 (Next #65 / 2026-09-11)

- Tip / prerelease APK: `lynx-v2-debug-3f15ea4` (work/lynx-native @ `3f15ea4196`; PR #103 / Next #64 MERGED; release exists). Was stale `lynx-v2-debug-2384ea6` / tip `2384ea6c95`. Do not invent a newer APK SHA than the published tag.
- Cap phone skim (MobileApp overflow / Files / Changes incl. stageAll/unstageAll/revertAll / SessionsSheet / chat header-swipe+sync hint / MCP sheet / ProjectsHome / Assistant / Scheduled / Settings key flows vs `packages/lynx`) found no new Linux-closable Cap product gap outside deferred thin leftovers (`@dnd-kit` / MobileWindowMotion / iPad sidebar / Cap toast sonner / bulk multi-select) and host-only — docs honesty only.
- Product **NOT DONE** / 三关未齐 / not EXHAUSTED. 真机残差 unchanged: Connect welcome **card chrome** confirm still open for Yee on tip APK `lynx-v2-debug-3f15ea4`. No 真机过 claim. Host-only unchanged (Keychain/camera/IME/Pierre/WKWebView/Mode B/Share ext/ShareReceiverActivity/iOS IPA/FCM for lynx.debug/Live Activity/clipboard host).

## Notes — Docs tip APK/SHA honesty post-#65 (Next #66 / 2026-09-11)

- Tip / prerelease APK: `lynx-v2-debug-8ba8989` (work/lynx-native @ `8ba89898a31`; PR #104 / Next #65 MERGED; release exists). Was stale `lynx-v2-debug-3f15ea4` / tip `3f15ea4196`. Do not invent a newer APK SHA than the published tag.
- Cap phone skim (MobileApp overflow / Files / Changes incl. stageAll/unstageAll/revertAll / SessionsSheet / chat header-swipe+sync hint / MCP sheet / ProjectsHome / Assistant / Scheduled / Settings key flows vs `packages/lynx`) found no new Linux-closable Cap product gap outside deferred thin leftovers (`@dnd-kit` / MobileWindowMotion / iPad sidebar / Cap toast sonner / bulk multi-select) and host-only — docs honesty only.
- Product **NOT DONE** / 三关未齐 / not EXHAUSTED. 真机残差 unchanged: Connect welcome **card chrome** confirm still open for Yee on tip APK `lynx-v2-debug-8ba8989`. No 真机过 claim. Host-only unchanged (Keychain/camera/IME/Pierre/WKWebView/Mode B/Share ext/ShareReceiverActivity/iOS IPA/FCM for lynx.debug/Live Activity/clipboard host).

## Notes — Docs tip APK/SHA honesty post-#66 (Next #67 / 2026-09-11)

- Tip / prerelease APK: `lynx-v2-debug-538c312` (work/lynx-native @ `538c31239fa4`; PR #105 / Next #66 MERGED; release exists). Was stale `lynx-v2-debug-8ba8989` / tip `8ba89898a31`. Do not invent a newer APK SHA than the published tag.
- Cap phone skim (MobileApp overflow / Files / Changes incl. stageAll/unstageAll/revertAll / SessionsSheet / chat header-swipe+sync hint / MCP sheet / ProjectsHome / Assistant / Scheduled / Settings key flows vs `packages/lynx`) found no new Linux-closable Cap product gap outside deferred thin leftovers (`@dnd-kit` / MobileWindowMotion / iPad sidebar / Cap toast sonner / bulk multi-select) and host-only — docs honesty only.
- Product **NOT DONE** / 三关未齐 / not EXHAUSTED. 真机残差 unchanged: Connect welcome **card chrome** confirm still open for Yee on tip APK `lynx-v2-debug-538c312`. No 真机过 claim. Host-only unchanged (Keychain/camera/IME/Pierre/WKWebView/Mode B/Share ext/ShareReceiverActivity/iOS IPA/FCM for lynx.debug/Live Activity/clipboard host).

## Notes — Docs tip APK/SHA honesty post-#67 (Next #68 / 2026-09-11)

- Tip / prerelease APK: `lynx-v2-debug-cd074ee` (work/lynx-native @ `cd074ee2b2b3`; PR #106 / Next #67 MERGED; release exists). Was stale `lynx-v2-debug-538c312` / tip `538c31239fa4`. Do not invent a newer APK SHA than the published tag.
- Cap phone skim (MobileApp overflow / Files / Changes incl. stageAll/unstageAll/revertAll / SessionsSheet / chat header-swipe+sync hint / MCP sheet / ProjectsHome / Assistant / Scheduled / Settings key flows vs `packages/lynx`) found no new Linux-closable Cap product gap outside deferred thin leftovers (`@dnd-kit` / MobileWindowMotion / iPad sidebar / Cap toast sonner / bulk multi-select) and host-only — docs honesty only.
- Product **NOT DONE** / 三关未齐 / not EXHAUSTED. 真机残差 unchanged: Connect welcome **card chrome** confirm still open for Yee on tip APK `lynx-v2-debug-cd074ee`. No 真机过 claim. Host-only unchanged (Keychain/camera/IME/Pierre/WKWebView/Mode B/Share ext/ShareReceiverActivity/iOS IPA/FCM for lynx.debug/Live Activity/clipboard host).

## Notes — Docs tip APK/SHA honesty post-#68 (Next #69 / 2026-09-11)

- Tip / prerelease APK: `lynx-v2-debug-50fa262` (work/lynx-native @ `50fa2626e946`; PR #107 / Next #68 MERGED; release exists). Was stale `lynx-v2-debug-cd074ee` / tip `cd074ee2b2b3`. Do not invent a newer APK SHA than the published tag.
- Cap phone skim (MobileApp overflow / Files / Changes incl. stageAll/unstageAll/revertAll / SessionsSheet / chat header-swipe+sync hint / MCP sheet / ProjectsHome / Assistant / Scheduled / Settings key flows vs `packages/lynx`) found no new Linux-closable Cap product gap outside deferred thin leftovers (`@dnd-kit` / MobileWindowMotion / iPad sidebar / Cap toast sonner / bulk multi-select) and host-only — docs honesty only.
- Product **NOT DONE** / 三关未齐 / not EXHAUSTED. 真机残差 unchanged: Connect welcome **card chrome** confirm still open for Yee on tip APK `lynx-v2-debug-50fa262`. No 真机过 claim. Host-only unchanged (Keychain/camera/IME/Pierre/WKWebView/Mode B/Share ext/ShareReceiverActivity/iOS IPA/FCM for lynx.debug/Live Activity/clipboard host).

## Notes — Docs tip APK/SHA honesty post-#69 (Next #70 / 2026-09-12)

- Cap phone skim (MobileApp overflow / Files / Changes incl. stageAll/unstageAll/revertAll / SessionsSheet / chat header-swipe+sync hint / MCP sheet / ProjectsHome / Assistant / Scheduled / Settings key flows vs `packages/lynx`) found **no** new Linux-closable Cap product gap outside deferred thin leftovers (`@dnd-kit` / MobileWindowMotion / iPad sidebar / Cap toast sonner / bulk multi-select) and host-only (Keychain/camera/IME/Pierre/WKWebView/Mode B/Share ext/ShareReceiverActivity/iOS IPA/FCM for lynx.debug/Live Activity/clipboard host).
- Tip / prerelease APK: `lynx-v2-debug-fb9a969` (work/lynx-native @ `fb9a969c7c0d`; PR #108 / Next #69 MERGED; release exists). Was stale `lynx-v2-debug-50fa262` / tip `50fa2626e946`. Do not invent a newer APK SHA than the published tag.
- Product **NOT DONE** / 三关未齐 / not EXHAUSTED. 真机残差 unchanged: Connect welcome **card chrome** confirm still open for Yee on tip APK `lynx-v2-debug-fb9a969`. No 真机过 claim. Host-only unchanged (Keychain/camera/IME/Pierre/WKWebView/Mode B/Share ext/ShareReceiverActivity/iOS IPA/FCM for lynx.debug/Live Activity/clipboard host).

## Notes — Docs tip APK/SHA honesty post-#70 (Next #71 / 2026-09-12)

- Cap phone skim (MobileApp overflow / Files / Changes incl. stageAll/unstageAll/revertAll / SessionsSheet / chat header-swipe+sync hint / MCP sheet / ProjectsHome / Assistant / Scheduled / Settings key flows vs `packages/lynx`) found **no** new Linux-closable Cap product gap outside deferred thin leftovers (`@dnd-kit` / MobileWindowMotion / iPad sidebar / Cap toast sonner / bulk multi-select) and host-only (Keychain/camera/IME/Pierre/WKWebView/Mode B/Share ext/ShareReceiverActivity/iOS IPA/FCM for lynx.debug/Live Activity/clipboard host).
- Tip / prerelease APK: `lynx-v2-debug-68b1919` (work/lynx-native @ `68b1919a566c`; PR #109 / Next #70 MERGED; release exists). Was stale `lynx-v2-debug-fb9a969` / tip `fb9a969c7c0d`. Do not invent a newer APK SHA than the published tag.
- Product **NOT DONE** / 三关未齐 / not EXHAUSTED. 真机残差 unchanged: Connect welcome **card chrome** confirm still open for Yee on tip APK `lynx-v2-debug-68b1919`. No 真机过 claim. Host-only unchanged (Keychain/camera/IME/Pierre/WKWebView/Mode B/Share ext/ShareReceiverActivity/iOS IPA/FCM for lynx.debug/Live Activity/clipboard host).

## Notes — Docs tip APK/SHA honesty post-#71 (Next #72 / 2026-09-12)

- Cap phone skim (MobileApp overflow / Files / Changes incl. stageAll/unstageAll/revertAll / SessionsSheet / chat header-swipe+sync hint / MCP sheet / ProjectsHome / Assistant / Scheduled / Settings key flows vs `packages/lynx`) found **no** new Linux-closable Cap product gap outside deferred thin leftovers (`@dnd-kit` / MobileWindowMotion / iPad sidebar / Cap toast sonner / bulk multi-select) and host-only (Keychain/camera/IME/Pierre/WKWebView/Mode B/Share ext/ShareReceiverActivity/iOS IPA/FCM for lynx.debug/Live Activity/clipboard host).
- Tip / prerelease APK: `lynx-v2-debug-3b2ae4c` (work/lynx-native @ `3b2ae4c1283700794d3b5124605cee914c4dc545`; PR #110 / Next #71 MERGED; release exists). Was stale `lynx-v2-debug-68b1919` / tip `68b1919a566c`. Do not invent a newer APK SHA than the published tag.
- Product **NOT DONE** / 三关未齐 / not EXHAUSTED. 真机残差 unchanged: Connect welcome **card chrome** confirm still open for Yee on tip APK `lynx-v2-debug-3b2ae4c`. No 真机过 claim. Host-only unchanged (Keychain/camera/IME/Pierre/WKWebView/Mode B/Share ext/ShareReceiverActivity/iOS IPA/FCM for lynx.debug/Live Activity/clipboard host).

## Notes — Cap Scheduled Run now + Delete (Next #73 / 2026-09-12)

- Cap `runScheduledTaskNow` + `deleteScheduledTask` 代码接上 in `cursor/lynx-scheduled-run-delete-local` (PR #112). Base tip / published APK at merge: `ea6349303` / `lynx-v2-debug-3b2ae4c` (do not invent newer at that slice). Tip later advanced — see Next #74 tip honesty.
- Product **NOT DONE** / 三关未齐 / not EXHAUSTED. 真机残差 unchanged: Connect welcome **card chrome** confirm still open for Yee. No 真机过 claim. Host-only unchanged (Keychain/camera/IME/Pierre/WKWebView/Mode B/Share ext/ShareReceiverActivity/iOS IPA/FCM for lynx.debug/Live Activity/clipboard host).

## Notes — Docs tip APK/SHA honesty post-#73 (Next #74 / 2026-09-12)

- Cap phone skim (MobileApp overflow / Files / Changes incl. stageAll/unstageAll/revertAll / SessionsSheet / chat header-swipe+sync hint / MCP sheet / ProjectsHome / Assistant / Scheduled list/editor/run/delete/history / Settings key flows vs `packages/lynx`) found **no** new Linux-closable Cap product gap outside deferred thin leftovers (`@dnd-kit` / MobileWindowMotion / iPad sidebar / Cap toast sonner / bulk multi-select) and host-only (Keychain/camera/IME/Pierre/WKWebView/Mode B/Share ext/ShareReceiverActivity/iOS IPA/FCM for lynx.debug/Live Activity/clipboard host).
- Tip / prerelease APK: `lynx-v2-debug-0a56dbe` (work/lynx-native @ `0a56dbedd1635ebe3cc31ed40fa5f428bc677bfc`; PR #112 / Next #73 MERGED; release exists). Was stale `lynx-v2-debug-3b2ae4c` / tip bases `3b2ae4c1283700794d3b5124605cee914c4dc545` / `ea6349303`. Do not invent a newer APK SHA than the published tag.
- Product **NOT DONE** / 三关未齐 / not EXHAUSTED. 真机残差 unchanged: Connect welcome **card chrome** confirm still open for Yee on tip APK `lynx-v2-debug-0a56dbe`. No 真机过 claim. Host-only unchanged (Keychain/camera/IME/Pierre/WKWebView/Mode B/Share ext/ShareReceiverActivity/iOS IPA/FCM for lynx.debug/Live Activity/clipboard host).

## Notes — Docs tip APK/SHA honesty post-#74 (Next #75 / 2026-09-12)

- Cap phone skim (MobileApp overflow / Files / Changes incl. stageAll/unstageAll/revertAll / SessionsSheet / chat header-swipe+sync hint / MCP sheet / ProjectsHome / Assistant / Scheduled list/editor/run/delete/history / Settings key flows vs `packages/lynx`) found **no** new Linux-closable Cap product gap outside deferred thin leftovers (`@dnd-kit` / MobileWindowMotion / iPad sidebar / Cap toast sonner / bulk multi-select) and host-only (Keychain/camera/IME/Pierre/WKWebView/Mode B/Share ext/ShareReceiverActivity/iOS IPA/FCM for lynx.debug/Live Activity/clipboard host). Incremental leftovers (not new product API wires): Scheduled history first-page list already 代码接上; Cap load-more/`nextCursor` + per-task filter stay thin polish. Settings search filter is wired (`filterLynxSettingsPages`).
- Tip / prerelease APK: `lynx-v2-debug-b798684` (work/lynx-native @ `b7986841cc7341800880febf6958299e65d50592`; PR #113 / Next #74 MERGED; release exists). Was stale `lynx-v2-debug-0a56dbe` / tip `0a56dbedd1635ebe3cc31ed40fa5f428bc677bfc`. Do not invent a newer APK SHA than the published tag.
- Product **NOT DONE** / 三关未齐 / not EXHAUSTED. 真机残差 unchanged: Connect welcome **card chrome** confirm still open for Yee on tip APK `lynx-v2-debug-b798684`. No 真机过 claim. Host-only unchanged (Keychain/camera/IME/Pierre/WKWebView/Mode B/Share ext/ShareReceiverActivity/iOS IPA/FCM for lynx.debug/Live Activity/clipboard host).

## Notes — Docs tip APK/SHA honesty post-#75 (Next #76 / 2026-09-12)

- Cap phone skim (MobileApp overflow / Files / Changes incl. stageAll/unstageAll/revertAll / SessionsSheet / chat header-swipe+sync hint / MCP sheet / ProjectsHome / Assistant / Scheduled list/editor/run/delete/history / Settings / Connect welcome vs `packages/lynx`) found **no** new Linux-closable Cap product gap outside deferred thin leftovers (`@dnd-kit` / MobileWindowMotion / iPad sidebar / Cap toast sonner / bulk multi-select) and host-only (Keychain/camera/IME/Pierre/WKWebView/Mode B/Share ext/ShareReceiverActivity/iOS IPA/FCM for lynx.debug/Live Activity/clipboard host). Incremental leftovers (not new product API wires): Scheduled history first-page list already 代码接上; Cap load-more/`nextCursor` + per-task filter stay thin polish. Settings search filter is wired (`filterLynxSettingsPages`). PR #115 bound auto-connect splash already landed on tip (Connect welcome after timeout — not a remaining gap).
- Tip / prerelease APK: `lynx-v2-debug-51ab13b` (work/lynx-native @ `51ab13b832164fac30956bb1297e2f1d93ed430b`; PR #115 auto-connect timeout MERGED; PR #114 / Next #75 MERGED; release exists). Was stale `lynx-v2-debug-b798684` / tip `b7986841cc7341800880febf6958299e65d50592`. Do not invent a newer APK SHA than the published tag.
- Product **NOT DONE** / 三关未齐 / not EXHAUSTED. 真机残差 unchanged: Connect welcome **card chrome** confirm still open for Yee on tip APK `lynx-v2-debug-51ab13b`. No 真机过 claim. Host-only unchanged (Keychain/camera/IME/Pierre/WKWebView/Mode B/Share ext/ShareReceiverActivity/iOS IPA/FCM for lynx.debug/Live Activity/clipboard host).

## Notes — Docs tip APK/SHA honesty post-#76 (Next #77 / 2026-09-12)

- Cap phone skim (MobileApp overflow / Files / Changes incl. stageAll/unstageAll/revertAll / SessionsSheet / chat header-swipe+sync hint / MCP sheet / ProjectsHome / Assistant / Scheduled list/editor/run/delete/history / Settings / Connect welcome vs `packages/lynx`) found **no** new Linux-closable Cap product gap outside deferred thin leftovers (`@dnd-kit` / MobileWindowMotion / iPad sidebar / Cap toast sonner / bulk multi-select) and host-only (Keychain/camera/IME/Pierre/WKWebView/Mode B/Share ext/ShareReceiverActivity/iOS IPA/FCM for lynx.debug/Live Activity/clipboard host). Incremental leftovers (not new product API wires): Scheduled history first-page list already 代码接上; Cap load-more/`nextCursor` + per-task filter stay thin polish. Settings search filter is wired (`filterLynxSettingsPages`). SessionsSheet/ProjectsHome row Stop is extra affordance (`abortSession` already wired from composer/goal). Active Show more beyond session-index snapshot is the same class as Scheduled history `nextCursor`. `GET /api/client-auth/connection/candidates` is post-connect lifecycle leftover, not welcome-blocking.
- Tip / prerelease APK: `lynx-v2-debug-896bd12` (work/lynx-native @ `896bd125704d86d11089ee138ccdd841a8a21a94`; PR #116 / Next #76 MERGED; release exists). Was stale `lynx-v2-debug-51ab13b` / tip `51ab13b832164fac30956bb1297e2f1d93ed430b`. Do not invent a newer APK SHA than the published tag.
- Product **NOT DONE** / 三关未齐 / not EXHAUSTED. 真机残差 unchanged: Connect welcome **card chrome** confirm still open for Yee on tip APK `lynx-v2-debug-896bd12`. No 真机过 claim. Host-only unchanged (Keychain/camera/IME/Pierre/WKWebView/Mode B/Share ext/ShareReceiverActivity/iOS IPA/FCM for lynx.debug/Live Activity/clipboard host).

## Notes — Docs tip APK/SHA honesty post-#77 (Next #78 / 2026-09-12)

- Cap phone skim (MobileApp overflow / Files / Changes incl. stageAll/unstageAll/revertAll / SessionsSheet / chat header-swipe+sync hint / MCP sheet / ProjectsHome / Assistant / Scheduled list/editor/run/delete/history / Settings / Connect welcome vs `packages/lynx`) found **no** new Linux-closable Cap product gap outside deferred thin leftovers (`@dnd-kit` / MobileWindowMotion / iPad sidebar / Cap toast sonner / bulk multi-select) and host-only (Keychain/camera/IME/Pierre/WKWebView/Mode B/Share ext/ShareReceiverActivity/iOS IPA/FCM for lynx.debug/Live Activity/clipboard host). Incremental leftovers (not new product API wires): Scheduled history first-page list already 代码接上; Cap load-more/`nextCursor` + per-task filter stay thin polish. Settings search filter is wired (`filterLynxSettingsPages`). SessionsSheet/ProjectsHome row Stop is extra affordance (`abortSession` already wired from composer/goal). Active Show more beyond session-index snapshot is the same class as Scheduled history `nextCursor`. `GET /api/client-auth/connection/candidates` is post-connect lifecycle leftover, not welcome-blocking.
- Tip / prerelease APK: `lynx-v2-debug-51870e1` (work/lynx-native @ `51870e1d175114ce0d4ad820db41311bd702d083`; PR #117 / Next #77 MERGED; release exists). Was stale `lynx-v2-debug-896bd12` / tip `896bd125704d86d11089ee138ccdd841a8a21a94`. Do not invent a newer APK SHA than the published tag.
- Product **NOT DONE** / 三关未齐 / not EXHAUSTED. 真机残差 unchanged: Connect welcome **card chrome** confirm still open for Yee on tip APK `lynx-v2-debug-51870e1`. No 真机过 claim. Host-only unchanged (Keychain/camera/IME/Pierre/WKWebView/Mode B/Share ext/ShareReceiverActivity/iOS IPA/FCM for lynx.debug/Live Activity/clipboard host).

## Notes — Docs tip APK/SHA honesty post-#78 (Next #79 / 2026-09-13)

- Cap phone skim (MobileApp overflow / Files / Changes incl. stageAll/unstageAll/revertAll / SessionsSheet / chat header-swipe+sync hint / MCP sheet / ProjectsHome / Assistant / Scheduled list/editor/run/delete/history / Settings / Connect welcome vs `packages/lynx`) found **no** new Linux-closable Cap product gap outside deferred thin leftovers (`@dnd-kit` / MobileWindowMotion / iPad sidebar / Cap toast sonner / bulk multi-select) and host-only (Keychain/camera/IME/Pierre/WKWebView/Mode B/Share ext/ShareReceiverActivity/iOS IPA/FCM for lynx.debug/Live Activity/clipboard host). Incremental leftovers (not new product API wires): Scheduled history first-page list already 代码接上; Cap load-more/`nextCursor` + per-task filter stay thin polish. Settings search filter is wired (`filterLynxSettingsPages`). SessionsSheet/ProjectsHome row Stop is extra affordance (`abortSession` already wired from composer/goal). Active Show more beyond session-index snapshot is the same class as Scheduled history `nextCursor`. `GET /api/client-auth/connection/candidates` is post-connect lifecycle leftover, not welcome-blocking.
- Tip / prerelease APK: `lynx-v2-debug-4643585` (work/lynx-native @ `46435859225186b343d439d0744385f651c1d9a2`; PR #118 / Next #78 MERGED; release exists). Was stale `lynx-v2-debug-51870e1` / tip `51870e1d175114ce0d4ad820db41311bd702d083`. Do not invent a newer APK SHA than the published tag.
- Product **NOT DONE** / 三关未齐 / not EXHAUSTED. 真机残差 unchanged: Connect welcome **card chrome** confirm still open for Yee on tip APK `lynx-v2-debug-4643585`. No 真机过 claim. Host-only unchanged (Keychain/camera/IME/Pierre/WKWebView/Mode B/Share ext/ShareReceiverActivity/iOS IPA/FCM for lynx.debug/Live Activity/clipboard host).

## Notes — Docs tip APK/SHA honesty post-#79 (Next #80 / 2026-09-13)

- Cap phone skim (MobileApp overflow / Files / Changes incl. stageAll/unstageAll/revertAll / SessionsSheet / chat header-swipe+sync hint / MCP sheet / ProjectsHome / Assistant / Scheduled list/editor/run/delete/history / Settings / Connect welcome vs `packages/lynx`) found **no** new Linux-closable Cap product gap outside deferred thin leftovers (`@dnd-kit` / MobileWindowMotion / iPad sidebar / Cap toast sonner / bulk multi-select) and host-only (Keychain/camera/IME/Pierre/WKWebView/Mode B/Share ext/ShareReceiverActivity/iOS IPA/FCM for lynx.debug/Live Activity/clipboard host). Incremental leftovers (not new product API wires): Scheduled history first-page list already 代码接上; Cap load-more/`nextCursor` + per-task filter stay thin polish. Settings search filter is wired (`filterLynxSettingsPages`). SessionsSheet/ProjectsHome row Stop is extra affordance (`abortSession` already wired from composer/goal). Active Show more beyond session-index snapshot is the same class as Scheduled history `nextCursor`. `GET /api/client-auth/connection/candidates` is post-connect lifecycle leftover, not welcome-blocking.
- Tip / prerelease APK: `lynx-v2-debug-cf705f5` (work/lynx-native @ `cf705f5d1458824ac1a8270d498cd83b3e44ff94`; PR #119 / Next #79 MERGED; release exists). Was stale `lynx-v2-debug-4643585` / tip `46435859225186b343d439d0744385f651c1d9a2`. Do not invent a newer APK SHA than the published tag.
- Product **NOT DONE** / 三关未齐 / not EXHAUSTED. 真机残差 unchanged: Connect welcome **card chrome** confirm still open for Yee on tip APK `lynx-v2-debug-cf705f5`. No 真机过 claim. Host-only unchanged (Keychain/camera/IME/Pierre/WKWebView/Mode B/Share ext/ShareReceiverActivity/iOS IPA/FCM for lynx.debug/Live Activity/clipboard host).

## Notes — Docs tip APK/SHA honesty post-#80 (Next #81 / 2026-09-13)

- Cap phone skim (MobileApp overflow / Files / Changes incl. stageAll/unstageAll/revertAll / SessionsSheet / chat header-swipe+sync hint / MCP sheet / ProjectsHome / Assistant / Scheduled list/editor/run/delete/history / Settings / Connect welcome vs `packages/lynx`) found **no** new Linux-closable Cap product gap outside deferred thin leftovers (`@dnd-kit` / MobileWindowMotion / iPad sidebar / Cap toast sonner / bulk multi-select) and host-only (Keychain/camera/IME/Pierre/WKWebView/Mode B/Share ext/ShareReceiverActivity/iOS IPA/FCM for lynx.debug/Live Activity/clipboard host). Incremental leftovers (not new product API wires): Scheduled history first-page list already 代码接上; Cap load-more/`nextCursor` + per-task filter stay thin polish. Settings search filter is wired (`filterLynxSettingsPages`). SessionsSheet/ProjectsHome row Stop is extra affordance (`abortSession` already wired from composer/goal). Active Show more beyond session-index snapshot is the same class as Scheduled history `nextCursor`. `GET /api/client-auth/connection/candidates` is post-connect lifecycle leftover, not welcome-blocking.
- Tip / prerelease APK: `lynx-v2-debug-267ba62` (work/lynx-native @ `267ba627842656370ae9b1295c4b59ff9c505c38`; PR #120 / Next #80 MERGED; release exists). Was stale `lynx-v2-debug-cf705f5` / tip `cf705f5d1458824ac1a8270d498cd83b3e44ff94`. Do not invent a newer APK SHA than the published tag.
- Product **NOT DONE** / 三关未齐 / not EXHAUSTED. 真机残差 unchanged: Connect welcome **card chrome** confirm still open for Yee on tip APK `lynx-v2-debug-267ba62`. No 真机过 claim. Host-only unchanged (Keychain/camera/IME/Pierre/WKWebView/Mode B/Share ext/ShareReceiverActivity/iOS IPA/FCM for lynx.debug/Live Activity/clipboard host).

## Notes — Docs tip APK/SHA honesty post-#81 (Next #82 / 2026-09-13)

- Cap phone skim (MobileApp overflow / Files / Changes incl. stageAll/unstageAll/revertAll / SessionsSheet / chat header-swipe+sync hint / MCP sheet / ProjectsHome / Assistant / Scheduled list/editor/run/delete/history / Settings / Connect welcome vs `packages/lynx`) found **no** new Linux-closable Cap product gap outside deferred thin leftovers (`@dnd-kit` / MobileWindowMotion / iPad sidebar / Cap toast sonner / bulk multi-select) and host-only (Keychain/camera/IME/Pierre/WKWebView/Mode B/Share ext/ShareReceiverActivity/iOS IPA/FCM for lynx.debug/Live Activity/clipboard host). Incremental leftovers (not new product API wires): Scheduled history first-page list already 代码接上; Cap load-more/`nextCursor` + per-task filter stay thin polish. Settings search filter is wired (`filterLynxSettingsPages`). SessionsSheet/ProjectsHome row Stop is extra affordance (`abortSession` already wired from composer/goal). Active Show more beyond session-index snapshot is the same class as Scheduled history `nextCursor`. `GET /api/client-auth/connection/candidates` is post-connect lifecycle leftover, not welcome-blocking.
- Tip / prerelease APK: `lynx-v2-debug-0b47a71` (work/lynx-native @ `0b47a71f14d8a1945dae14e333ba695451707950`; PR #121 / Next #81 MERGED; release exists). Was stale `lynx-v2-debug-267ba62` / tip `267ba627842656370ae9b1295c4b59ff9c505c38`. Do not invent a newer APK SHA than the published tag.
- Product **NOT DONE** / 三关未齐 / not EXHAUSTED. 真机残差 unchanged: Connect welcome **card chrome** confirm still open for Yee on tip APK `lynx-v2-debug-0b47a71`. No 真机过 claim. Host-only unchanged (Keychain/camera/IME/Pierre/WKWebView/Mode B/Share ext/ShareReceiverActivity/iOS IPA/FCM for lynx.debug/Live Activity/clipboard host).

## Notes — Docs tip APK/SHA honesty post-#82 (Next #83 / 2026-09-13)

- Cap phone skim (MobileApp overflow / Files / Changes incl. stageAll/unstageAll/revertAll / SessionsSheet / chat header-swipe+sync hint / MCP sheet / ProjectsHome / Assistant / Scheduled list/editor/run/delete/history / Settings / Connect welcome vs `packages/lynx`) found **no** new Linux-closable Cap product gap outside deferred thin leftovers (`@dnd-kit` / MobileWindowMotion / iPad sidebar / Cap toast sonner / bulk multi-select) and host-only (Keychain/camera/IME/Pierre/WKWebView/Mode B/Share ext/ShareReceiverActivity/iOS IPA/FCM for lynx.debug/Live Activity/clipboard host). Incremental leftovers (not new product API wires): Scheduled history first-page list already 代码接上; Cap load-more/`nextCursor` + per-task filter stay thin polish. Settings search filter is wired (`filterLynxSettingsPages`). SessionsSheet/ProjectsHome row Stop is extra affordance (`abortSession` already wired from composer/goal). Active Show more beyond session-index snapshot is the same class as Scheduled history `nextCursor`. `GET /api/client-auth/connection/candidates` is post-connect lifecycle leftover, not welcome-blocking.
- Tip / prerelease APK: `lynx-v2-debug-5287db7` (work/lynx-native @ `5287db7438ae51bad0033ee6614c83fee7ad6f2a`; PR #122 / Next #82 MERGED; release exists). Was stale `lynx-v2-debug-0b47a71` / tip `0b47a71f14d8a1945dae14e333ba695451707950`. Do not invent a newer APK SHA than the published tag.
- Product **NOT DONE** / 三关未齐 / not EXHAUSTED. 真机残差 unchanged: Connect welcome **card chrome** confirm still open for Yee on tip APK `lynx-v2-debug-5287db7`. No 真机过 claim. Host-only unchanged (Keychain/camera/IME/Pierre/WKWebView/Mode B/Share ext/ShareReceiverActivity/iOS IPA/FCM for lynx.debug/Live Activity/clipboard host).

## Notes — Docs tip APK/SHA honesty post-#83 (Next #84 / 2026-09-13)

- Cap phone skim (MobileApp overflow / Files / Changes incl. stageAll/unstageAll/revertAll / SessionsSheet / chat header-swipe+sync hint / MCP sheet / ProjectsHome / Assistant / Scheduled list/editor/run/delete/history / Settings / Connect welcome vs `packages/lynx`) found **no** new Linux-closable Cap product gap outside deferred thin leftovers (`@dnd-kit` / MobileWindowMotion / iPad sidebar / Cap toast sonner / bulk multi-select) and host-only (Keychain/camera/IME/Pierre/WKWebView/Mode B/Share ext/ShareReceiverActivity/iOS IPA/FCM for lynx.debug/Live Activity/clipboard host). Incremental leftovers (not new product API wires): Scheduled history first-page list already 代码接上; Cap load-more/`nextCursor` + per-task filter stay thin polish. Settings search filter is wired (`filterLynxSettingsPages`). SessionsSheet/ProjectsHome row Stop is extra affordance (`abortSession` already wired from composer/goal). Active Show more beyond session-index snapshot is the same class as Scheduled history `nextCursor`. `GET /api/client-auth/connection/candidates` is post-connect lifecycle leftover, not welcome-blocking.
- Tip / prerelease APK: `lynx-v2-debug-3d0d768` (work/lynx-native @ `3d0d7683a14c5695f9d2ba1705b14ef5614dbc1f`; PR #123 / Next #83 MERGED; release exists). Was stale `lynx-v2-debug-5287db7` / tip `5287db7438ae51bad0033ee6614c83fee7ad6f2a`. Do not invent a newer APK SHA than the published tag.
- Product **NOT DONE** / 三关未齐 / not EXHAUSTED. 真机残差 unchanged: Connect welcome **card chrome** confirm still open for Yee on tip APK `lynx-v2-debug-3d0d768`. No 真机过 claim. Host-only unchanged (Keychain/camera/IME/Pierre/WKWebView/Mode B/Share ext/ShareReceiverActivity/iOS IPA/FCM for lynx.debug/Live Activity/clipboard host).

## Notes — Docs tip APK/SHA honesty post-#84 (Next #85 / 2026-09-14)

- Cap phone skim (MobileApp overflow / Files / Changes incl. stageAll/unstageAll/revertAll / SessionsSheet / chat header-swipe+sync hint / MCP sheet / ProjectsHome / Assistant / Scheduled list/editor/run/delete/history / Settings / Connect welcome vs `packages/lynx`) found **no** new Linux-closable Cap product gap outside deferred thin leftovers (`@dnd-kit` / MobileWindowMotion / iPad sidebar / Cap toast sonner / bulk multi-select) and host-only (Keychain/camera/IME/Pierre/WKWebView/Mode B/Share ext/ShareReceiverActivity/iOS IPA/FCM for lynx.debug/Live Activity/clipboard host). Incremental leftovers (not new product API wires): Scheduled history first-page list already 代码接上; Cap load-more/`nextCursor` + per-task filter stay thin polish. Settings search filter is wired (`filterLynxSettingsPages`). SessionsSheet/ProjectsHome row Stop is extra affordance (`abortSession` already wired from composer/goal). Active Show more beyond session-index snapshot is the same class as Scheduled history `nextCursor`. `GET /api/client-auth/connection/candidates` is post-connect lifecycle leftover, not welcome-blocking.
- Tip / prerelease APK: `lynx-v2-debug-607eaf6` (work/lynx-native @ `607eaf6dfc726f7d18fd6eac2b44542e39365b09`; PR #124 / Next #84 MERGED; release exists). Was stale `lynx-v2-debug-3d0d768` / tip `3d0d7683a14c5695f9d2ba1705b14ef5614dbc1f`. Do not invent a newer APK SHA than the published tag.
- Product **NOT DONE** / 三关未齐 / not EXHAUSTED. 真机残差 unchanged: Connect welcome **card chrome** confirm still open for Yee on tip APK `lynx-v2-debug-607eaf6`. No 真机过 claim. Host-only unchanged (Keychain/camera/IME/Pierre/WKWebView/Mode B/Share ext/ShareReceiverActivity/iOS IPA/FCM for lynx.debug/Live Activity/clipboard host).

## Notes — Docs tip APK/SHA honesty post-#85 (Next #86 / 2026-09-14)

- Cap phone skim (MobileApp overflow / Files / Changes incl. stageAll/unstageAll/revertAll / SessionsSheet / chat header-swipe+sync hint / MCP sheet / ProjectsHome / Assistant / Scheduled list/editor/run/delete/history / Settings / Connect welcome vs `packages/lynx`) found **no** new Linux-closable Cap product gap outside deferred thin leftovers (`@dnd-kit` / MobileWindowMotion / iPad sidebar / Cap toast sonner / bulk multi-select) and host-only (Keychain/camera/IME/Pierre/WKWebView/Mode B/Share ext/ShareReceiverActivity/iOS IPA/FCM for lynx.debug/Live Activity/clipboard host). Incremental leftovers (not new product API wires): Scheduled history first-page list already 代码接上; Cap load-more/`nextCursor` + per-task filter stay thin polish. Settings search filter is wired (`filterLynxSettingsPages`). SessionsSheet/ProjectsHome row Stop is extra affordance (`abortSession` already wired from composer/goal). Active Show more beyond session-index snapshot is the same class as Scheduled history `nextCursor`. `GET /api/client-auth/connection/candidates` is post-connect lifecycle leftover, not welcome-blocking.
- Tip / prerelease APK: `lynx-v2-debug-edaec0d` (work/lynx-native @ `edaec0d9bbab4f132a51e4fde3259dd994b49369`; PR #125 / Next #85 MERGED; release exists). Was stale `lynx-v2-debug-607eaf6` / tip `607eaf6dfc726f7d18fd6eac2b44542e39365b09`. Do not invent a newer APK SHA than the published tag.
- Product **NOT DONE** / 三关未齐 / not EXHAUSTED. 真机残差 unchanged: Connect welcome **card chrome** confirm still open for Yee on tip APK `lynx-v2-debug-edaec0d`. No 真机过 claim. Host-only unchanged (Keychain/camera/IME/Pierre/WKWebView/Mode B/Share ext/ShareReceiverActivity/iOS IPA/FCM for lynx.debug/Live Activity/clipboard host).

## Notes — Docs tip APK/SHA honesty post-#86 (Next #87 / 2026-09-14)

- Cap phone skim (MobileApp overflow / Files / Changes incl. stageAll/unstageAll/revertAll / SessionsSheet / chat header-swipe+sync hint / MCP sheet / ProjectsHome / Assistant / Scheduled list/editor/run/delete/history / Settings / Connect welcome vs `packages/lynx`) found **no** new Linux-closable Cap product gap outside deferred thin leftovers (`@dnd-kit` / MobileWindowMotion / iPad sidebar / Cap toast sonner / bulk multi-select) and host-only (Keychain/camera/IME/Pierre/WKWebView/Mode B/Share ext/ShareReceiverActivity/iOS IPA/FCM for lynx.debug/Live Activity/clipboard host). Incremental leftovers (not new product API wires): Scheduled history first-page list already 代码接上; Cap load-more/`nextCursor` + per-task filter stay thin polish. Settings search filter is wired (`filterLynxSettingsPages`). SessionsSheet/ProjectsHome row Stop is extra affordance (`abortSession` already wired from composer/goal). Active Show more beyond session-index snapshot is the same class as Scheduled history `nextCursor`. `GET /api/client-auth/connection/candidates` is post-connect lifecycle leftover, not welcome-blocking.
- Tip / prerelease APK: `lynx-v2-debug-dbad742` (work/lynx-native @ `dbad742588da5f7c575d23c5269b3317dd1cd1ce`; PR #126 / Next #86 MERGED; release exists). Was stale `lynx-v2-debug-edaec0d` / tip `edaec0d9bbab4f132a51e4fde3259dd994b49369`. Do not invent a newer APK SHA than the published tag.
- Product **NOT DONE** / 三关未齐 / not EXHAUSTED. 真机残差 unchanged: Connect welcome **card chrome** confirm still open for Yee on tip APK `lynx-v2-debug-dbad742`. No 真机过 claim. Host-only unchanged (Keychain/camera/IME/Pierre/WKWebView/Mode B/Share ext/ShareReceiverActivity/iOS IPA/FCM for lynx.debug/Live Activity/clipboard host).

## Notes — Docs tip APK/SHA honesty post-#87 (Next #88 / 2026-09-14)

- Cap phone skim (MobileApp overflow / Files / Changes incl. stageAll/unstageAll/revertAll / SessionsSheet / chat header-swipe+sync hint / MCP sheet / ProjectsHome / Assistant / Scheduled list/editor/run/delete/history / Settings / Connect welcome vs `packages/lynx`) found **no** new Linux-closable Cap product gap outside deferred thin leftovers (`@dnd-kit` / MobileWindowMotion / iPad sidebar / Cap toast sonner / bulk multi-select) and host-only (Keychain/camera/IME/Pierre/WKWebView/Mode B/Share ext/ShareReceiverActivity/iOS IPA/FCM for lynx.debug/Live Activity/clipboard host). Incremental leftovers (not new product API wires): Scheduled history first-page list already 代码接上; Cap load-more/`nextCursor` + per-task filter stay thin polish. Settings search filter is wired (`filterLynxSettingsPages`). SessionsSheet/ProjectsHome row Stop is extra affordance (`abortSession` already wired from composer/goal). Active Show more beyond session-index snapshot is the same class as Scheduled history `nextCursor`. `GET /api/client-auth/connection/candidates` is post-connect lifecycle leftover, not welcome-blocking.
- Tip / prerelease APK: `lynx-v2-debug-4d16bf8` (work/lynx-native @ `4d16bf8070865883c79b0e13a3c47e63d573311c`; PR #127 / Next #87 MERGED; release exists). Was stale `lynx-v2-debug-dbad742` / tip `dbad742588da5f7c575d23c5269b3317dd1cd1ce`. Do not invent a newer APK SHA than the published tag.
- Product **NOT DONE** / 三关未齐 / not EXHAUSTED. 真机残差 unchanged: Connect welcome **card chrome** confirm still open for Yee on tip APK `lynx-v2-debug-4d16bf8`. No 真机过 claim. Host-only unchanged (Keychain/camera/IME/Pierre/WKWebView/Mode B/Share ext/ShareReceiverActivity/iOS IPA/FCM for lynx.debug/Live Activity/clipboard host).

## Notes — Docs tip APK/SHA honesty post-#88 (Next #89 / 2026-09-14)

- Cap phone skim (MobileApp overflow / Files / Changes incl. stageAll/unstageAll/revertAll / SessionsSheet / chat header-swipe+sync hint / MCP sheet / ProjectsHome / Assistant / Scheduled list/editor/run/delete/history / Settings / Connect welcome vs `packages/lynx`) found **no** new Linux-closable Cap product gap outside deferred thin leftovers (`@dnd-kit` / MobileWindowMotion / iPad sidebar / Cap toast sonner / bulk multi-select) and host-only (Keychain/camera/IME/Pierre/WKWebView/Mode B/Share ext/ShareReceiverActivity/iOS IPA/FCM for lynx.debug/Live Activity/clipboard host). Incremental leftovers (not new product API wires): Scheduled history first-page list already 代码接上; Cap load-more/`nextCursor` + per-task filter stay thin polish. Settings search filter is wired (`filterLynxSettingsPages`). SessionsSheet/ProjectsHome row Stop is extra affordance (`abortSession` already wired from composer/goal). Active Show more beyond session-index snapshot is the same class as Scheduled history `nextCursor`. `GET /api/client-auth/connection/candidates` is post-connect lifecycle leftover, not welcome-blocking.
- Tip / prerelease APK: `lynx-v2-debug-8ec0384` (work/lynx-native @ `8ec03842faed8caa6c255a237e617ef1ddf2e89f`; PR #128 / Next #88 MERGED; release exists). Was stale `lynx-v2-debug-4d16bf8` / tip `4d16bf8070865883c79b0e13a3c47e63d573311c`. Do not invent a newer APK SHA than the published tag.
- Product **NOT DONE** / 三关未齐 / not EXHAUSTED. 真机残差 unchanged: Connect welcome **card chrome** confirm still open for Yee on tip APK `lynx-v2-debug-8ec0384`. No 真机过 claim. Host-only unchanged (Keychain/camera/IME/Pierre/WKWebView/Mode B/Share ext/ShareReceiverActivity/iOS IPA/FCM for lynx.debug/Live Activity/clipboard host).

## Notes — Cap Settings archived-sessions slug + page body (Next #90 / 2026-09-14)

- Cap **main** `MOBILE_SETTINGS_PAGE_SLUGS` is 22 including `archived-sessions` (`ArchivedSessionsPage` + `ArchivedSessionsManager mode="page"`). Tip Cap `packages/ui` still lists 21 — Lynx implements against Cap main.
- Settings in-tab push reuses `listLynxArchivedSessions` / `unarchiveLynxSession` / `LynxArchivedSessionsManager` (SessionsSheet dialog unchanged). Failure ≠ empty; honest no-runtime; no Cap toast / no invented ASR.
- Slug/metadata tests lock 22. Base tip `c451d696b` (PR #129 / Next #89 MERGED). Published APK honesty stays `lynx-v2-debug-8ec0384` (release exists for tip `8ec03842f`) — do not invent a newer APK for this PR head.
- Product **NOT DONE** / 三关未齐 / not EXHAUSTED. 真机残差 unchanged: Connect welcome **card chrome** confirm still open for Yee. No 真机过 claim. Host-only unchanged. Out of scope at merge: Assistant unread + mark-all-read (closed in Next #91); `@dnd-kit`; merge to main.

## Notes — Cap Assistant unread + mark-all-read (Next #91 / 2026-09-14)

- Cap **main** `AssistantUnreadBadge` / `AssistantMarkAllReadButton` / `AssistantReadMarker` + `POST /api/openchamber/assistants/:id/contact/read` `{ generation, ordinal, messageID }`. Mark-all fans out `unreadCount > 0 && readTip` in batches of 4 and returns `{ failed }`.
- Lynx parse defaults absent `unreadCount` to 0; rejects malformed counts/positions. Real POST only; refresh snapshot after; no Cap toast (portable banner). Catalog row badges + dock Assistant-tab total (99+). Portable open/latest-visible mark uses snapshot `readTip` while viewing that assistant conversation. Cap IntersectionObserver / scroll-bottom / focus geometry is a documented host residual — never fake mark-success.
- Base tip `4cc762cd2` (PR #130 / Next #90 MERGED). Published APK honesty stays `lynx-v2-debug-8ec0384` (release exists for tip `8ec03842f`) — do not invent a newer APK for this PR head.
- Product **NOT DONE** / 三关未齐 / not EXHAUSTED. 真机残差 unchanged: Connect welcome **card chrome** confirm still open for Yee. No 真机过 claim. Host-only unchanged (Keychain/camera/IME/Pierre/WKWebView/Mode B/Share ext/iOS IPA/@dnd-kit/MobileWindowMotion/iPad/Cap toast/bulk).

## Notes — Docs tip APK/SHA honesty post-#91 (Next #92 / 2026-09-14)

- Cap phone skim (MobileApp overflow / Files / Changes incl. stageAll/unstageAll/revertAll / SessionsSheet / chat header-swipe+sync hint / MCP sheet / ProjectsHome / Assistant / Scheduled list/editor/run/delete/history / Settings / Connect welcome vs `packages/lynx`) found **no** new Linux-closable Cap product gap outside deferred thin leftovers (`@dnd-kit` / MobileWindowMotion / iPad sidebar / Cap toast sonner / bulk multi-select) and host-only (Keychain/camera/IME/Pierre/WKWebView/Mode B/Share ext/ShareReceiverActivity/iOS IPA/FCM for lynx.debug/Live Activity/clipboard host). Incremental leftovers (not new product API wires): Scheduled history first-page list already 代码接上; Cap load-more/`nextCursor` + per-task filter stay thin polish. Settings search filter is wired (`filterLynxSettingsPages`). SessionsSheet/ProjectsHome row Stop is extra affordance (`abortSession` already wired from composer/goal). Active Show more beyond session-index snapshot is the same class as Scheduled history `nextCursor`. `GET /api/client-auth/connection/candidates` is post-connect lifecycle leftover, not welcome-blocking.
- Next #90 archived-sessions **MERGED** as PR #130; Next #91 Assistant unread **MERGED** as PR #131.
- Tip / published APK: tip `work/lynx-native` @ `3fda6eb3f2f72580c7a25036c413fa8e5c17ab65` (PR #131 / Next #91 MERGED). Published prerelease APK `lynx-v2-debug-4cc762c` (release exists for tip after PR #130 / `4cc762cd2`). No `lynx-v2-debug-3fda6eb` at write time — do not invent. Mobile CI may later publish for newer tip. Was stale `lynx-v2-debug-8ec0384` / tip bases `8ec03842f` / `c451d696b` / `4cc762cd2` docs that predated this hop.
- Product **NOT DONE** / 三关未齐 / not EXHAUSTED. 真机残差 unchanged: Connect welcome **card chrome** confirm still open for Yee on published tip APK `lynx-v2-debug-4cc762c`. No 真机过 claim. Host-only unchanged (Keychain/camera/IME/Pierre/WKWebView/Mode B/Share ext/ShareReceiverActivity/iOS IPA/FCM for lynx.debug/Live Activity/clipboard host).

## Notes — Docs tip APK/SHA honesty post-#92 (Next #93 / 2026-09-14)

- Cap phone skim (MobileApp overflow / Files / Changes incl. stageAll/unstageAll/revertAll / SessionsSheet / chat header-swipe+sync hint / MCP sheet / ProjectsHome / Assistant / Scheduled list/editor/run/delete/history / Settings / Connect welcome vs `packages/lynx`) found **no** new Linux-closable Cap product gap outside deferred thin leftovers (`@dnd-kit` / MobileWindowMotion / iPad sidebar / Cap toast sonner / bulk multi-select) and host-only (Keychain/camera/IME/Pierre/WKWebView/Mode B/Share ext/ShareReceiverActivity/iOS IPA/FCM for lynx.debug/Live Activity/clipboard host). Incremental leftovers (not new product API wires): Scheduled history first-page list already 代码接上; Cap load-more/`nextCursor` + per-task filter stay thin polish. Settings search filter is wired (`filterLynxSettingsPages`). SessionsSheet/ProjectsHome row Stop is extra affordance (`abortSession` already wired from composer/goal). Active Show more beyond session-index snapshot is the same class as Scheduled history `nextCursor`. `GET /api/client-auth/connection/candidates` is post-connect lifecycle leftover, not welcome-blocking. **NO_NEW_LINUX_CLOSABLE_PRODUCT_GAP**.
- Tip / prerelease APK: `lynx-v2-debug-63da3d6` (work/lynx-native @ `63da3d63aa354eb66677f6ff57d5dd546ddca24b`; PR #132 / Next #92 MERGED; release exists). Was stale `lynx-v2-debug-4cc762c` / tip `3fda6eb3f2f72580c7a25036c413fa8e5c17ab65`. Do not invent a newer APK SHA than the published tag.
- Product **NOT DONE** / 三关未齐 / not EXHAUSTED. 真机残差 unchanged: Connect welcome **card chrome** confirm still open for Yee on tip APK `lynx-v2-debug-63da3d6`. No 真机过 claim. Host-only unchanged (Keychain/camera/IME/Pierre/WKWebView/Mode B/Share ext/ShareReceiverActivity/iOS IPA/FCM for lynx.debug/Live Activity/clipboard host).

## Notes — Docs tip APK/SHA honesty post-#93 (Next #94 / 2026-09-14)

- Cap phone skim (MobileApp overflow / Files / Changes incl. stageAll/unstageAll/revertAll / SessionsSheet / chat header-swipe+sync hint / MCP sheet / ProjectsHome / Assistant / Scheduled list/editor/run/delete/history / Settings / Connect welcome vs `packages/lynx`) found **no** new Linux-closable Cap product gap outside deferred thin leftovers (`@dnd-kit` / MobileWindowMotion / iPad sidebar / Cap toast sonner / bulk multi-select) and host-only (Keychain/camera/IME/Pierre/WKWebView/Mode B/Share ext/ShareReceiverActivity/iOS IPA/FCM for lynx.debug/Live Activity/clipboard host). Incremental leftovers (not new product API wires): Scheduled history first-page list already 代码接上; Cap load-more/`nextCursor` + per-task filter stay thin polish. Settings search filter is wired (`filterLynxSettingsPages`). SessionsSheet/ProjectsHome row Stop is extra affordance (`abortSession` already wired from composer/goal). Active Show more beyond session-index snapshot is the same class as Scheduled history `nextCursor`. `GET /api/client-auth/connection/candidates` is post-connect lifecycle leftover, not welcome-blocking. **NO_NEW_LINUX_CLOSABLE_PRODUCT_GAP**.
- Tip / prerelease APK: `lynx-v2-debug-50af885` (work/lynx-native @ `50af885b81849d92bed38116930abc3ddbbf88ef`; PR #133 / Next #93 MERGED; release exists). Was stale `lynx-v2-debug-63da3d6` / tip `63da3d63aa354eb66677f6ff57d5dd546ddca24b`. Do not invent a newer APK SHA than the published tag.
- Product **NOT DONE** / 三关未齐 / not EXHAUSTED. 真机残差 unchanged: Connect welcome **card chrome** confirm still open for Yee on tip APK `lynx-v2-debug-50af885`. No 真机过 claim. Host-only unchanged (Keychain/camera/IME/Pierre/WKWebView/Mode B/Share ext/ShareReceiverActivity/iOS IPA/FCM for lynx.debug/Live Activity/clipboard host).

## Notes — Docs tip APK/SHA honesty post-#94 (Next #95 / 2026-09-15)

- Cap phone skim (MobileApp overflow / Files / Changes incl. stageAll/unstageAll/revertAll / SessionsSheet / chat header-swipe+sync hint / MCP sheet / ProjectsHome / Assistant / Scheduled list/editor/run/delete/history / Settings / Connect welcome vs `packages/lynx`) found **no** new Linux-closable Cap product gap outside deferred thin leftovers (`@dnd-kit` / MobileWindowMotion / iPad sidebar / Cap toast sonner / bulk multi-select) and host-only (Keychain/camera/IME/Pierre/WKWebView/Mode B/Share ext/ShareReceiverActivity/iOS IPA/FCM for lynx.debug/Live Activity/clipboard host). Incremental leftovers (not new product API wires): Scheduled history first-page list already 代码接上; Cap load-more/`nextCursor` + per-task filter stay thin polish. Settings search filter is wired (`filterLynxSettingsPages`). SessionsSheet/ProjectsHome row Stop is extra affordance (`abortSession` already wired from composer/goal). Active Show more beyond session-index snapshot is the same class as Scheduled history `nextCursor`. `GET /api/client-auth/connection/candidates` is post-connect lifecycle leftover, not welcome-blocking. **NO_NEW_LINUX_CLOSABLE_PRODUCT_GAP**.
- Tip / published APK: tip `work/lynx-native` @ `4520eb00be8bd1cc8faea2cca151d3d55ae39b91` (PR #134 / Next #94 MERGED). Published prerelease APK `lynx-v2-debug-50af885` (release exists; was the tip before this honesty merge / PR #133 / `50af885b81849d92bed38116930abc3ddbbf88ef`). Do NOT invent a newer APK than published (no `lynx-v2-debug-4520eb00`). Lynx Mobile CI on tip `4520eb00` FAILED at Setup Android SDK (`android-actions/setup-android@v3`: Failed to find package 'tools') — no newer published APK for `4520eb00`.
- Product **NOT DONE** / 三关未齐 / not EXHAUSTED. 真机残差 unchanged: Connect welcome **card chrome** confirm still open for Yee on published APK `lynx-v2-debug-50af885`. No 真机过 claim. Host-only unchanged (Keychain/camera/IME/Pierre/WKWebView/Mode B/Share ext/ShareReceiverActivity/iOS IPA/FCM for lynx.debug/Live Activity/clipboard host).

## Notes — Docs tip APK/SHA honesty post-#95 (Next #96 / 2026-09-15)

- Cap phone skim (MobileApp overflow / Files / Changes incl. stageAll/unstageAll/revertAll / SessionsSheet / chat header-swipe+sync hint / MCP sheet / ProjectsHome / Assistant / Scheduled list/editor/run/delete/history / Settings / Connect welcome vs `packages/lynx`) found **no** new Linux-closable Cap product gap outside deferred thin leftovers (`@dnd-kit` / MobileWindowMotion / iPad sidebar / Cap toast sonner / bulk multi-select) and host-only (Keychain/camera/IME/Pierre/WKWebView/Mode B/Share ext/ShareReceiverActivity/iOS IPA/FCM for lynx.debug/Live Activity/clipboard host). Incremental leftovers (not new product API wires): Scheduled history first-page list already 代码接上; Cap load-more/`nextCursor` + per-task filter stay thin polish. Settings search filter is wired (`filterLynxSettingsPages`). SessionsSheet/ProjectsHome row Stop is extra affordance (`abortSession` already wired from composer/goal). Active Show more beyond session-index snapshot is the same class as Scheduled history `nextCursor`. `GET /api/client-auth/connection/candidates` is post-connect lifecycle leftover, not welcome-blocking. **NO_NEW_LINUX_CLOSABLE_PRODUCT_GAP**.
- Tip / prerelease APK: `lynx-v2-debug-ee82d53` (work/lynx-native @ `ee82d53a736a321b6ad6fd4573b03575def90eeb`; PR #136 / Next #95 MERGED; includes PR #135 Mobile CI setup-android pin; release exists). Was stale `lynx-v2-debug-50af885` / tip `4520eb00be8bd1cc8faea2cca151d3d55ae39b91`. PR #135 pinned setup-android packages (`tools` removed upstream → `packages:platform-tools`); Mobile CI SUCCESS on tip after #135/#136 republished `lynx-v2-debug-ee82d53`. Do not invent a newer APK SHA than the published tag.
- Product **NOT DONE** / 三关未齐 / not EXHAUSTED. 真机残差 unchanged: Connect welcome **card chrome** confirm still open for Yee on tip APK `lynx-v2-debug-ee82d53`. No 真机过 claim. Host-only unchanged (Keychain/camera/IME/Pierre/WKWebView/Mode B/Share ext/ShareReceiverActivity/iOS IPA/FCM for lynx.debug/Live Activity/clipboard host).

## Notes — Docs tip APK/SHA honesty post-#96 (Next #97 / 2026-09-15)

- Cap phone skim (MobileApp overflow / Files / Changes incl. stageAll/unstageAll/revertAll / SessionsSheet / chat header-swipe+sync hint / MCP sheet / ProjectsHome / Assistant / Scheduled list/editor/run/delete/history / Settings / Connect welcome vs `packages/lynx`) found **no** new Linux-closable Cap product gap outside deferred thin leftovers (`@dnd-kit` / MobileWindowMotion / iPad sidebar / Cap toast sonner / bulk multi-select) and host-only (Keychain/camera/IME/Pierre/WKWebView/Mode B/Share ext/ShareReceiverActivity/iOS IPA/FCM for lynx.debug/Live Activity/clipboard host). Incremental leftovers (not new product API wires): Scheduled history first-page list already 代码接上; Cap load-more/`nextCursor` + per-task filter stay thin polish. Settings search filter is wired (`filterLynxSettingsPages`). SessionsSheet/ProjectsHome row Stop is extra affordance (`abortSession` already wired from composer/goal). Active Show more beyond session-index snapshot is the same class as Scheduled history `nextCursor`. `GET /api/client-auth/connection/candidates` is post-connect lifecycle leftover, not welcome-blocking. **NO_NEW_LINUX_CLOSABLE_PRODUCT_GAP**.
- Tip / prerelease APK: `lynx-v2-debug-d10c92d` (work/lynx-native @ `d10c92db2d5b6ad5c322a75bbfc8b9ca69c8d464`; PR #137 / Next #96 MERGED; release exists). Was stale `lynx-v2-debug-ee82d53` / tip `ee82d53a736a321b6ad6fd4573b03575def90eeb`. Lynx Mobile CI SUCCESS on tip `d10c92db` after #137 republished `lynx-v2-debug-d10c92d`. lynx-ci may not have re-fired on this docs-only tip push (OK; not claimed red). Do not invent a newer APK SHA than the published tag.
- Product **NOT DONE** / 三关未齐 / not EXHAUSTED. 真机残差 unchanged: Connect welcome **card chrome** confirm still open for Yee on tip APK `lynx-v2-debug-d10c92d`. No 真机过 claim. Host-only unchanged (Keychain/camera/IME/Pierre/WKWebView/Mode B/Share ext/ShareReceiverActivity/iOS IPA/FCM for lynx.debug/Live Activity/clipboard host).

## Notes — Docs tip APK/SHA honesty post-#97 (Next #98 / 2026-09-15)

- Cap phone skim (MobileApp overflow / Files / Changes incl. stageAll/unstageAll/revertAll / SessionsSheet / chat header-swipe+sync hint / MCP sheet / ProjectsHome / Assistant / Scheduled list/editor/run/delete/history / Settings / Connect welcome vs `packages/lynx`) found **no** new Linux-closable Cap product gap outside deferred thin leftovers (`@dnd-kit` / MobileWindowMotion / iPad sidebar / Cap toast sonner / bulk multi-select) and host-only (Keychain/camera/IME/Pierre/WKWebView/Mode B/Share ext/ShareReceiverActivity/iOS IPA/FCM for lynx.debug/Live Activity/clipboard host). Incremental leftovers (not new product API wires): Scheduled history first-page list already 代码接上; Cap load-more/`nextCursor` + per-task filter stay thin polish. Settings search filter is wired (`filterLynxSettingsPages`). SessionsSheet/ProjectsHome row Stop is extra affordance (`abortSession` already wired from composer/goal). Active Show more beyond session-index snapshot is the same class as Scheduled history `nextCursor`. `GET /api/client-auth/connection/candidates` is post-connect lifecycle leftover, not welcome-blocking. **NO_NEW_LINUX_CLOSABLE_PRODUCT_GAP**.
- Tip / prerelease APK: `lynx-v2-debug-a92b319` (work/lynx-native @ `a92b319a1ed1d79c326d662c3d8beca3e2ff05b8`; PR #138 / Next #97 MERGED; release exists). Was stale `lynx-v2-debug-d10c92d` / tip `d10c92db2d5b6ad5c322a75bbfc8b9ca69c8d464`. Lynx Mobile CI SUCCESS on tip `a92b319` (run 34943000499) after #138 republished `lynx-v2-debug-a92b319`. Do not invent a newer APK SHA than the published tag.
- Product **NOT DONE** / 三关未齐 / not EXHAUSTED. 真机残差 unchanged: Connect welcome **card chrome** confirm still open for Yee on tip APK `lynx-v2-debug-a92b319`. No 真机过 claim. Host-only unchanged (Keychain/camera/IME/Pierre/WKWebView/Mode B/Share ext/ShareReceiverActivity/iOS IPA/FCM for lynx.debug/Live Activity/clipboard host).

## Notes — Docs tip APK/SHA honesty post-#98 (Next #99 / 2026-09-15)

- Cap phone skim (MobileApp overflow / Files / Changes incl. stageAll/unstageAll/revertAll / SessionsSheet / chat header-swipe+sync hint / MCP sheet / ProjectsHome / Assistant / Scheduled list/editor/run/delete/history / Settings / Connect welcome vs `packages/lynx`) found **no** new Linux-closable Cap product gap outside deferred thin leftovers (`@dnd-kit` / MobileWindowMotion / iPad sidebar / Cap toast sonner / bulk multi-select) and host-only (Keychain/camera/IME/Pierre/WKWebView/Mode B/Share ext/ShareReceiverActivity/iOS IPA/FCM for lynx.debug/Live Activity/clipboard host). Incremental leftovers (not new product API wires): Scheduled history first-page list already 代码接上; Cap load-more/`nextCursor` + per-task filter stay thin polish. Settings search filter is wired (`filterLynxSettingsPages`). SessionsSheet/ProjectsHome row Stop is extra affordance (`abortSession` already wired from composer/goal). Active Show more beyond session-index snapshot is the same class as Scheduled history `nextCursor`. `GET /api/client-auth/connection/candidates` is post-connect lifecycle leftover, not welcome-blocking. **NO_NEW_LINUX_CLOSABLE_PRODUCT_GAP**.
- Tip / prerelease APK: `lynx-v2-debug-f1cf09e` (work/lynx-native @ `f1cf09ef9a3a085e8e2f0b2a2272e819795766e2`; PR #139 / Next #98 MERGED; release exists). Was stale `lynx-v2-debug-a92b319` / tip `a92b319a1ed1d79c326d662c3d8beca3e2ff05b8`. Lynx Mobile CI SUCCESS on tip `f1cf09ef` (run 34956940347) after #139 republished `lynx-v2-debug-f1cf09e`. Do not invent a newer APK SHA than the published tag.
- Product **NOT DONE** / 三关未齐 / not EXHAUSTED. 真机残差 unchanged: Connect welcome **card chrome** confirm still open for Yee on tip APK `lynx-v2-debug-f1cf09e`. No 真机过 claim. Host-only unchanged (Keychain/camera/IME/Pierre/WKWebView/Mode B/Share ext/ShareReceiverActivity/iOS IPA/FCM for lynx.debug/Live Activity/clipboard host).

## Notes — Docs tip APK/SHA honesty post-#99 (Next #100 / 2026-09-15)

- Cap phone skim (MobileApp overflow / Files / Changes incl. stageAll/unstageAll/revertAll / SessionsSheet / chat header-swipe+sync hint / MCP sheet / ProjectsHome / Assistant / Scheduled list/editor/run/delete/history / Settings / Connect welcome vs `packages/lynx`) found **no** new Linux-closable Cap product gap outside deferred thin leftovers (`@dnd-kit` / MobileWindowMotion / iPad sidebar / Cap toast sonner / bulk multi-select) and host-only (Keychain/camera/IME/Pierre/WKWebView/Mode B/Share ext/ShareReceiverActivity/iOS IPA/FCM for lynx.debug/Live Activity/clipboard host). Incremental leftovers (not new product API wires): Scheduled history first-page list already 代码接上; Cap load-more/`nextCursor` + per-task filter stay thin polish. Settings search filter is wired (`filterLynxSettingsPages`). SessionsSheet/ProjectsHome row Stop is extra affordance (`abortSession` already wired from composer/goal). Active Show more beyond session-index snapshot is the same class as Scheduled history `nextCursor`. `GET /api/client-auth/connection/candidates` is post-connect lifecycle leftover, not welcome-blocking. **NO_NEW_LINUX_CLOSABLE_PRODUCT_GAP**.
- Tip / prerelease APK: `lynx-v2-debug-41d632a` (work/lynx-native @ `41d632abebf2c62088d46371bb5761c73925dc7b`; PR #140 / Next #99 MERGED; release exists). Was stale `lynx-v2-debug-f1cf09e` / tip `f1cf09ef9a3a085e8e2f0b2a2272e819795766e2`. Lynx Mobile CI SUCCESS on tip `41d632ab` (run 34958905237) after #140 republished `lynx-v2-debug-41d632a`. Do not invent a newer APK SHA than the published tag.
- Product **NOT DONE** / 三关未齐 / not EXHAUSTED. 真机残差 unchanged: Connect welcome **card chrome** confirm still open for Yee on published APK `lynx-v2-debug-41d632a`. No 真机过 claim. Host-only unchanged (Keychain/camera/IME/Pierre/WKWebView/Mode B/Share ext/ShareReceiverActivity/iOS IPA/FCM for lynx.debug/Live Activity/clipboard host).

## Notes — Docs tip APK/SHA honesty post-#100 (Next #101 / 2026-09-15)

- Cap phone skim (MobileApp overflow / Files / Changes incl. stageAll/unstageAll/revertAll / SessionsSheet / chat header-swipe+sync hint / MCP sheet / ProjectsHome / Assistant / Scheduled list/editor/run/delete/history / Settings / Connect welcome vs `packages/lynx`) found **no** new Linux-closable Cap product gap outside deferred thin leftovers (`@dnd-kit` / MobileWindowMotion / iPad sidebar / Cap toast sonner / bulk multi-select) and host-only (Keychain/camera/IME/Pierre/WKWebView/Mode B/Share ext/ShareReceiverActivity/iOS IPA/FCM for lynx.debug/Live Activity/clipboard host). Incremental leftovers (not new product API wires): Scheduled history first-page list already 代码接上; Cap load-more/`nextCursor` + per-task filter stay thin polish. Settings search filter is wired (`filterLynxSettingsPages`). SessionsSheet/ProjectsHome row Stop is extra affordance (`abortSession` already wired from composer/goal). Active Show more beyond session-index snapshot is the same class as Scheduled history `nextCursor`. `GET /api/client-auth/connection/candidates` is post-connect lifecycle leftover, not welcome-blocking. **NO_NEW_LINUX_CLOSABLE_PRODUCT_GAP**.
- Tip / prerelease APK: `lynx-v2-debug-32aed54` (work/lynx-native @ `32aed54c6f1585f6da2a35c82ac16f78db92933e`; PR #141 / Next #100 MERGED; release exists). Was stale `lynx-v2-debug-41d632a` / tip `41d632abebf2c62088d46371bb5761c73925dc7b`. Lynx Mobile CI SUCCESS on tip `32aed54c` (run 34976026554) after #141 republished `lynx-v2-debug-32aed54`. Do not invent a newer APK SHA than the published tag.
- Product **NOT DONE** / 三关未齐 / not EXHAUSTED. 真机残差 unchanged: Connect welcome **card chrome** confirm still open for Yee on published APK `lynx-v2-debug-32aed54`. No 真机过 claim. Host-only unchanged (Keychain/camera/IME/Pierre/WKWebView/Mode B/Share ext/ShareReceiverActivity/iOS IPA/FCM for lynx.debug/Live Activity/clipboard host).

## Notes — Docs tip APK/SHA honesty post-#101 (Next #102 / 2026-09-15)

- Cap phone skim (MobileApp overflow / Files / Changes incl. stageAll/unstageAll/revertAll / SessionsSheet / chat header-swipe+sync hint / MCP sheet / ProjectsHome / Assistant / Scheduled list/editor/run/delete/history / Settings / Connect welcome vs `packages/lynx`) found **no** new Linux-closable Cap product gap outside deferred thin leftovers (`@dnd-kit` / MobileWindowMotion / iPad sidebar / Cap toast sonner / bulk multi-select) and host-only (Keychain/camera/IME/Pierre/WKWebView/Mode B/Share ext/ShareReceiverActivity/iOS IPA/FCM for lynx.debug/Live Activity/clipboard host). Incremental leftovers (not new product API wires): Scheduled history first-page list already 代码接上; Cap load-more/`nextCursor` + per-task filter stay thin polish. Settings search filter is wired (`filterLynxSettingsPages`). SessionsSheet/ProjectsHome row Stop is extra affordance (`abortSession` already wired from composer/goal). Active Show more beyond session-index snapshot is the same class as Scheduled history `nextCursor`. `GET /api/client-auth/connection/candidates` is post-connect lifecycle leftover, not welcome-blocking. **NO_NEW_LINUX_CLOSABLE_PRODUCT_GAP**.
- Tip / prerelease APK: `lynx-v2-debug-105884e` (work/lynx-native @ `105884e5067dd5ba26bb49c2957bb255deea92cd`; PR #142 / Next #101 MERGED; release exists). Was stale `lynx-v2-debug-32aed54` / tip `32aed54c6f1585f6da2a35c82ac16f78db92933e`. Lynx Mobile CI SUCCESS on tip `105884e` (run 35015640496) after #142 republished `lynx-v2-debug-105884e`. Do not invent a newer APK SHA than the published tag.
- Product **NOT DONE** / 三关未齐 / not EXHAUSTED. 真机残差 unchanged: Connect welcome **card chrome** confirm still open for Yee on published APK `lynx-v2-debug-105884e`. No 真机过 claim. Host-only unchanged (Keychain/camera/IME/Pierre/WKWebView/Mode B/Share ext/ShareReceiverActivity/iOS IPA/FCM for lynx.debug/Live Activity/clipboard host).

## Notes — Docs tip APK/SHA honesty post-#102 (Next #103 / 2026-09-16)

- Cap phone skim (MobileApp overflow / Files / Changes incl. stageAll/unstageAll/revertAll / SessionsSheet / chat header-swipe+sync hint / MCP sheet / ProjectsHome / Assistant / Scheduled list/editor/run/delete/history / Settings / Connect welcome vs `packages/lynx`) found **no** new Linux-closable Cap product gap outside deferred thin leftovers (`@dnd-kit` / MobileWindowMotion / iPad sidebar / Cap toast sonner / bulk multi-select) and host-only (Keychain/camera/IME/Pierre/WKWebView/Mode B/Share ext/ShareReceiverActivity/iOS IPA/FCM for lynx.debug/Live Activity/clipboard host). Incremental leftovers (not new product API wires): Scheduled history first-page list already 代码接上; Cap load-more/`nextCursor` + per-task filter stay thin polish. Settings search filter is wired (`filterLynxSettingsPages`). SessionsSheet/ProjectsHome row Stop is extra affordance (`abortSession` already wired from composer/goal). Active Show more beyond session-index snapshot is the same class as Scheduled history `nextCursor`. `GET /api/client-auth/connection/candidates` is post-connect lifecycle leftover, not welcome-blocking. **NO_NEW_LINUX_CLOSABLE_PRODUCT_GAP**.
- Tip / prerelease APK: `lynx-v2-debug-ac8b4c9` (work/lynx-native @ `ac8b4c99c5e821ac435bea83daec65eb8f7e7171`; PR #143 / Next #102 MERGED; release exists). Was stale `lynx-v2-debug-105884e` / tip `105884e5067dd5ba26bb49c2957bb255deea92cd`. Lynx Mobile CI SUCCESS on tip `ac8b4c99` (run 35031338604) after #143 republished `lynx-v2-debug-ac8b4c9`. Do not invent a newer APK SHA than the published tag.
- Product **NOT DONE** / 三关未齐 / not EXHAUSTED. 真机残差 unchanged: Connect welcome **card chrome** confirm still open for Yee on published APK `lynx-v2-debug-ac8b4c9`. No 真机过 claim. Host-only unchanged (Keychain/camera/IME/Pierre/WKWebView/Mode B/Share ext/ShareReceiverActivity/iOS IPA/FCM for lynx.debug/Live Activity/clipboard host).

## Notes — Docs tip APK/SHA honesty post-#103 (Next #104 / 2026-09-16)

- Cap phone skim (MobileApp overflow / Files / Changes incl. stageAll/unstageAll/revertAll / SessionsSheet / chat header-swipe+sync hint / MCP sheet / ProjectsHome / Assistant / Scheduled list/editor/run/delete/history / Settings / Connect welcome vs `packages/lynx`) found **no** new Linux-closable Cap product gap outside deferred thin leftovers (`@dnd-kit` / MobileWindowMotion / iPad sidebar / Cap toast sonner / bulk multi-select) and host-only (Keychain/camera/IME/Pierre/WKWebView/Mode B/Share ext/ShareReceiverActivity/iOS IPA/FCM for lynx.debug/Live Activity/clipboard host). Incremental leftovers (not new product API wires): Scheduled history first-page list already 代码接上; Cap load-more/`nextCursor` + per-task filter stay thin polish. Settings search filter is wired (`filterLynxSettingsPages`). SessionsSheet/ProjectsHome row Stop is extra affordance (`abortSession` already wired from composer/goal). Active Show more beyond session-index snapshot is the same class as Scheduled history `nextCursor`. `GET /api/client-auth/connection/candidates` is post-connect lifecycle leftover, not welcome-blocking. **NO_NEW_LINUX_CLOSABLE_PRODUCT_GAP**.
- Tip / prerelease APK: `lynx-v2-debug-bb7aad6` (work/lynx-native @ `bb7aad63b0ba4d3bb7a9627bf1780de1bdffbb76`; PR #144 / Next #103 MERGED; release exists). Was stale `lynx-v2-debug-ac8b4c9` / tip `ac8b4c99c5e821ac435bea83daec65eb8f7e7171`. Lynx Mobile CI SUCCESS on tip `bb7aad63` (run 35044475784) after #144 republished `lynx-v2-debug-bb7aad6`. Do not invent a newer APK SHA than the published tag.
- Product **NOT DONE** / 三关未齐 / not EXHAUSTED. 真机残差 unchanged: Connect welcome **card chrome** confirm still open for Yee on published APK `lynx-v2-debug-bb7aad6`. No 真机过 claim. Host-only unchanged (Keychain/camera/IME/Pierre/WKWebView/Mode B/Share ext/ShareReceiverActivity/iOS IPA/FCM for lynx.debug/Live Activity/clipboard host).

## Notes — Docs tip APK/SHA honesty post-#104 (Next #105 / 2026-09-16)

- Cap phone skim (MobileApp overflow / Files / Changes incl. stageAll/unstageAll/revertAll / SessionsSheet / chat header-swipe+sync hint / MCP sheet / ProjectsHome / Assistant / Scheduled list/editor/run/delete/history / Settings / Connect welcome vs `packages/lynx`) found **no** new Linux-closable Cap product gap outside deferred thin leftovers (`@dnd-kit` / MobileWindowMotion / iPad sidebar / Cap toast sonner / bulk multi-select) and host-only (Keychain/camera/IME/Pierre/WKWebView/Mode B/Share ext/ShareReceiverActivity/iOS IPA/FCM for lynx.debug/Live Activity/clipboard host). Incremental leftovers (not new product API wires): Scheduled history first-page list already 代码接上; Cap load-more/`nextCursor` + per-task filter stay thin polish. Settings search filter is wired (`filterLynxSettingsPages`). SessionsSheet/ProjectsHome row Stop is extra affordance (`abortSession` already wired from composer/goal). Active Show more beyond session-index snapshot is the same class as Scheduled history `nextCursor`. `GET /api/client-auth/connection/candidates` is post-connect lifecycle leftover, not welcome-blocking. **NO_NEW_LINUX_CLOSABLE_PRODUCT_GAP**.
- Tip / prerelease APK: `lynx-v2-debug-14211c0` (work/lynx-native @ `14211c02c298ebfcf4b0e2d1720ee5c9635358bf`; PR #145 / Next #104 MERGED; release exists). Was stale `lynx-v2-debug-bb7aad6` / tip `bb7aad63b0ba4d3bb7a9627bf1780de1bdffbb76`. Lynx Mobile CI SUCCESS on tip `14211c02` (run 35055816332) after #145 republished `lynx-v2-debug-14211c0`. Do not invent a newer APK SHA than the published tag.
- Product **NOT DONE** / 三关未齐 / not EXHAUSTED. 真机残差 unchanged: Connect welcome **card chrome** confirm still open for Yee on published APK `lynx-v2-debug-14211c0`. No 真机过 claim. Host-only unchanged (Keychain/camera/IME/Pierre/WKWebView/Mode B/Share ext/ShareReceiverActivity/iOS IPA/FCM for lynx.debug/Live Activity/clipboard host).

## Notes — Docs tip APK/SHA honesty post-#105 (Next #106 / 2026-09-16)

- Cap phone skim (MobileApp overflow / Files / Changes incl. stageAll/unstageAll/revertAll / SessionsSheet / chat header-swipe+sync hint / MCP sheet / ProjectsHome / Assistant / Scheduled list/editor/run/delete/history / Settings / Connect welcome vs `packages/lynx`) found **no** new Linux-closable Cap product gap outside deferred thin leftovers (`@dnd-kit` / MobileWindowMotion / iPad sidebar / Cap toast sonner / bulk multi-select) and host-only (Keychain/camera/IME/Pierre/WKWebView/Mode B/Share ext/ShareReceiverActivity/iOS IPA/FCM for lynx.debug/Live Activity/clipboard host). Incremental leftovers (not new product API wires): Scheduled history first-page list already 代码接上; Cap load-more/`nextCursor` + per-task filter stay thin polish. Settings search filter is wired (`filterLynxSettingsPages`). SessionsSheet/ProjectsHome row Stop is extra affordance (`abortSession` already wired from composer/goal). Active Show more beyond session-index snapshot is the same class as Scheduled history `nextCursor`. `GET /api/client-auth/connection/candidates` is post-connect lifecycle leftover, not welcome-blocking. **NO_NEW_LINUX_CLOSABLE_PRODUCT_GAP**.
- Tip / prerelease APK: `lynx-v2-debug-a9f6605` (work/lynx-native @ `a9f6605301df86cbe2b8b7ad124aaac02142a834`; PR #146 / Next #105 MERGED; release exists). Was stale `lynx-v2-debug-14211c0` / tip `14211c02c298ebfcf4b0e2d1720ee5c9635358bf`. Lynx Mobile CI SUCCESS on tip `a9f660530` (run 35069830726) after #146 republished `lynx-v2-debug-a9f6605`. Do not invent a newer APK SHA than the published tag.
- Product **NOT DONE** / 三关未齐 / not EXHAUSTED. 真机残差 unchanged: Connect welcome **card chrome** confirm still open for Yee on published APK `lynx-v2-debug-a9f6605`. No 真机过 claim. Host-only unchanged (Keychain/camera/IME/Pierre/WKWebView/Mode B/Share ext/ShareReceiverActivity/iOS IPA/FCM for lynx.debug/Live Activity/clipboard host).

## Notes — Docs tip APK/SHA honesty post-#106 (Next #107 / 2026-09-16)

- Cap phone skim (MobileApp overflow / Files / Changes incl. stageAll/unstageAll/revertAll / SessionsSheet / chat header-swipe+sync hint / MCP sheet / ProjectsHome / Assistant / Scheduled list/editor/run/delete/history / Settings / Connect welcome vs `packages/lynx`) found **no** new Linux-closable Cap product gap outside deferred thin leftovers (`@dnd-kit` / MobileWindowMotion / iPad sidebar / Cap toast sonner / bulk multi-select) and host-only (Keychain/camera/IME/Pierre/WKWebView/Mode B/Share ext/ShareReceiverActivity/iOS IPA/FCM for lynx.debug/Live Activity/clipboard host). Incremental leftovers (not new product API wires): Scheduled history first-page list already 代码接上; Cap load-more/`nextCursor` + per-task filter stay thin polish. Settings search filter is wired (`filterLynxSettingsPages`). SessionsSheet/ProjectsHome row Stop is extra affordance (`abortSession` already wired from composer/goal). Active Show more beyond session-index snapshot is the same class as Scheduled history `nextCursor`. `GET /api/client-auth/connection/candidates` is post-connect lifecycle leftover, not welcome-blocking. **NO_NEW_LINUX_CLOSABLE_PRODUCT_GAP**.
- Tip / prerelease APK: `lynx-v2-debug-7e4af21` (work/lynx-native @ `7e4af21a4f651fdf051905572188456fef28e72c`; PR #147 / Next #106 MERGED; release exists). Was stale `lynx-v2-debug-a9f6605` / tip `a9f6605301df86cbe2b8b7ad124aaac02142a834`. Lynx Mobile CI SUCCESS on tip `7e4af21` (run 35083475005) after #147 republished `lynx-v2-debug-7e4af21`. Do not invent a newer APK SHA than the published tag.
- Product **NOT DONE** / 三关未齐 / not EXHAUSTED. 真机残差 unchanged: Connect welcome **card chrome** confirm still open for Yee on published APK `lynx-v2-debug-7e4af21`. No 真机过 claim. Host-only unchanged (Keychain/camera/IME/Pierre/WKWebView/Mode B/Share ext/ShareReceiverActivity/iOS IPA/FCM for lynx.debug/Live Activity/clipboard host).

## Notes — Docs tip APK/SHA honesty post-#107 (Next #108 / 2026-09-16)

- Cap phone skim (MobileApp overflow / Files / Changes incl. stageAll/unstageAll/revertAll / SessionsSheet / chat header-swipe+sync hint / MCP sheet / ProjectsHome / Assistant / Scheduled list/editor/run/delete/history / Settings / Connect welcome vs `packages/lynx`) found **no** new Linux-closable Cap product gap outside deferred thin leftovers (`@dnd-kit` / MobileWindowMotion / iPad sidebar / Cap toast sonner / bulk multi-select) and host-only (Keychain/camera/IME/Pierre/WKWebView/Mode B/Share ext/ShareReceiverActivity/iOS IPA/FCM for lynx.debug/Live Activity/clipboard host). Incremental leftovers (not new product API wires): Scheduled history first-page list already 代码接上; Cap load-more/`nextCursor` + per-task filter stay thin polish. Settings search filter is wired (`filterLynxSettingsPages`). SessionsSheet/ProjectsHome row Stop is extra affordance (`abortSession` already wired from composer/goal). Active Show more beyond session-index snapshot is the same class as Scheduled history `nextCursor`. `GET /api/client-auth/connection/candidates` is post-connect lifecycle leftover, not welcome-blocking. **NO_NEW_LINUX_CLOSABLE_PRODUCT_GAP**.
- Tip / prerelease APK: `lynx-v2-debug-22a4bc7` (work/lynx-native @ `22a4bc746ef851bc05d0710662e65d298fee540f`; PR #148 / Next #107 MERGED; release exists). Was stale `lynx-v2-debug-7e4af21` / tip `7e4af21a4f651fdf051905572188456fef28e72c`. Lynx Mobile CI SUCCESS on tip `22a4bc7` (run 35090970058) after #148 republished `lynx-v2-debug-22a4bc7`. Do not invent a newer APK SHA than the published tag.
- Product **NOT DONE** / 三关未齐 / not EXHAUSTED. 真机残差 unchanged: Connect welcome **card chrome** confirm still open for Yee on published APK `lynx-v2-debug-22a4bc7`. No 真机过 claim. Host-only unchanged (Keychain/camera/IME/Pierre/WKWebView/Mode B/Share ext/ShareReceiverActivity/iOS IPA/FCM for lynx.debug/Live Activity/clipboard host).

## Notes — Docs tip APK/SHA honesty post-#108 (Next #109 / 2026-09-16)

- Cap phone skim (MobileApp overflow / Files / Changes incl. stageAll/unstageAll/revertAll / SessionsSheet / chat header-swipe+sync hint / MCP sheet / ProjectsHome / Assistant / Scheduled list/editor/run/delete/history / Settings / Connect welcome vs `packages/lynx`) found **no** new Linux-closable Cap product gap outside deferred thin leftovers (`@dnd-kit` / MobileWindowMotion / iPad sidebar / Cap toast sonner / bulk multi-select) and host-only (Keychain/camera/IME/Pierre/WKWebView/Mode B/Share ext/ShareReceiverActivity/iOS IPA/FCM for lynx.debug/Live Activity/clipboard host). Incremental leftovers (not new product API wires): Scheduled history first-page list already 代码接上; Cap load-more/`nextCursor` + per-task filter stay thin polish. Settings search filter is wired (`filterLynxSettingsPages`). SessionsSheet/ProjectsHome row Stop is extra affordance (`abortSession` already wired from composer/goal). Active Show more beyond session-index snapshot is the same class as Scheduled history `nextCursor`. `GET /api/client-auth/connection/candidates` is post-connect lifecycle leftover, not welcome-blocking. **NO_NEW_LINUX_CLOSABLE_PRODUCT_GAP**.
- Tip / prerelease APK: `lynx-v2-debug-d256387` (work/lynx-native @ `d256387d51cd4f166f86320d71b31804fe104243`; PR #149 / Next #108 MERGED; release exists). Was stale `lynx-v2-debug-22a4bc7` / tip `22a4bc746ef851bc05d0710662e65d298fee540f`. Lynx Mobile CI SUCCESS on tip `d256387` (run 35104578745) after #149 republished `lynx-v2-debug-d256387`. Do not invent a newer APK SHA than the published tag.
- Product **NOT DONE** / 三关未齐 / not EXHAUSTED. 真机残差 unchanged: Connect welcome **card chrome** confirm still open for Yee on published APK `lynx-v2-debug-d256387`. No 真机过 claim. Host-only unchanged (Keychain/camera/IME/Pierre/WKWebView/Mode B/Share ext/ShareReceiverActivity/iOS IPA/FCM for lynx.debug/Live Activity/clipboard host).

## Notes — Docs tip APK/SHA honesty post-#109 (Next #110 / 2026-09-17)

- Cap phone skim (MobileApp overflow / Files / Changes incl. stageAll/unstageAll/revertAll / SessionsSheet / chat header-swipe+sync hint / MCP sheet / ProjectsHome / Assistant / Scheduled list/editor/run/delete/history / Settings / Connect welcome vs `packages/lynx`) found **no** new Linux-closable Cap product gap outside deferred thin leftovers (`@dnd-kit` / MobileWindowMotion / iPad sidebar / Cap toast sonner / bulk multi-select) and host-only (Keychain/camera/IME/Pierre/WKWebView/Mode B/Share ext/ShareReceiverActivity/iOS IPA/FCM for lynx.debug/Live Activity/clipboard host). Incremental leftovers (not new product API wires): Scheduled history first-page list already 代码接上; Cap load-more/`nextCursor` + per-task filter stay thin polish. Settings search filter is wired (`filterLynxSettingsPages`). SessionsSheet/ProjectsHome row Stop is extra affordance (`abortSession` already wired from composer/goal). Active Show more beyond session-index snapshot is the same class as Scheduled history `nextCursor`. `GET /api/client-auth/connection/candidates` is post-connect lifecycle leftover, not welcome-blocking. **NO_NEW_LINUX_CLOSABLE_PRODUCT_GAP**.
- Tip / prerelease APK: `lynx-v2-debug-50934d8` (work/lynx-native @ `50934d8cf44a463310284d55a815a1d7426fb78b`; PR #150 / Next #109 MERGED; release exists). Was stale `lynx-v2-debug-d256387` / tip `d256387d51cd4f166f86320d71b31804fe104243`. Lynx Mobile CI SUCCESS on tip `50934d8` (run 35158475515) after #150 republished `lynx-v2-debug-50934d8`. Do not invent a newer APK SHA than the published tag.
- Product **NOT DONE** / 三关未齐 / not EXHAUSTED. 真机残差 unchanged: Connect welcome **card chrome** confirm still open for Yee on published APK `lynx-v2-debug-50934d8`. No 真机过 claim. Host-only unchanged (Keychain/camera/IME/Pierre/WKWebView/Mode B/Share ext/ShareReceiverActivity/iOS IPA/FCM for lynx.debug/Live Activity/clipboard host).

## Notes — Docs tip APK/SHA honesty post-#110 (Next #111 / 2026-09-17)

- Cap phone skim (MobileApp overflow / Files / Changes incl. stageAll/unstageAll/revertAll / SessionsSheet / chat header-swipe+sync hint / MCP sheet / ProjectsHome / Assistant / Scheduled list/editor/run/delete/history / Settings / Connect welcome vs `packages/lynx`) found **no** new Linux-closable Cap product gap outside deferred thin leftovers (`@dnd-kit` / MobileWindowMotion / iPad sidebar / Cap toast sonner / bulk multi-select) and host-only (Keychain/camera/IME/Pierre/WKWebView/Mode B/Share ext/ShareReceiverActivity/iOS IPA/FCM for lynx.debug/Live Activity/clipboard host). Incremental leftovers (not new product API wires): Scheduled history first-page list already 代码接上; Cap load-more/`nextCursor` + per-task filter stay thin polish. Settings search filter is wired (`filterLynxSettingsPages`). SessionsSheet/ProjectsHome row Stop is extra affordance (`abortSession` already wired from composer/goal). Active Show more beyond session-index snapshot is the same class as Scheduled history `nextCursor`. `GET /api/client-auth/connection/candidates` is post-connect lifecycle leftover, not welcome-blocking. **NO_NEW_LINUX_CLOSABLE_PRODUCT_GAP**.
- Tip / prerelease APK: `lynx-v2-debug-c510559` (work/lynx-native @ `c510559b425dcd0a8e06e5961e849570e744f014`; PR #151 / Next #110 MERGED; release exists). Was stale `lynx-v2-debug-50934d8` / tip `50934d8cf44a463310284d55a815a1d7426fb78b`. Lynx Mobile CI SUCCESS on tip `c510559` (run 35171179409) after #151 republished `lynx-v2-debug-c510559`. Do not invent a newer APK SHA than the published tag.
- Product **NOT DONE** / 三关未齐 / not EXHAUSTED. 真机残差 unchanged: Connect welcome **card chrome** confirm still open for Yee on published APK `lynx-v2-debug-c510559`. No 真机过 claim. Host-only unchanged (Keychain/camera/IME/Pierre/WKWebView/Mode B/Share ext/ShareReceiverActivity/iOS IPA/FCM for lynx.debug/Live Activity/clipboard host).

## Notes — Docs tip APK/SHA honesty post-#111 (Next #112 / 2026-09-17)

- Cap phone skim (MobileApp overflow / Files / Changes incl. stageAll/unstageAll/revertAll / SessionsSheet / chat header-swipe+sync hint / MCP sheet / ProjectsHome / Assistant / Scheduled list/editor/run/delete/history / Settings / Connect welcome vs `packages/lynx`) found **no** new Linux-closable Cap product gap outside deferred thin leftovers (`@dnd-kit` / MobileWindowMotion / iPad sidebar / Cap toast sonner / bulk multi-select) and host-only (Keychain/camera/IME/Pierre/WKWebView/Mode B/Share ext/ShareReceiverActivity/iOS IPA/FCM for lynx.debug/Live Activity/clipboard host). Incremental leftovers (not new product API wires): Scheduled history first-page list already 代码接上; Cap load-more/`nextCursor` + per-task filter stay thin polish. Settings search filter is wired (`filterLynxSettingsPages`). SessionsSheet/ProjectsHome row Stop is extra affordance (`abortSession` already wired from composer/goal). Active Show more beyond session-index snapshot is the same class as Scheduled history `nextCursor`. `GET /api/client-auth/connection/candidates` is post-connect lifecycle leftover, not welcome-blocking. **NO_NEW_LINUX_CLOSABLE_PRODUCT_GAP**.
- Tip / prerelease APK: `lynx-v2-debug-b32e74c` (work/lynx-native @ `b32e74c05ff9041d787442cc3ab4087d2f15e87e`; PR #152 / Next #111 MERGED; release exists). Was stale `lynx-v2-debug-c510559` / tip `c510559b425dcd0a8e06e5961e849570e744f014`. Lynx Mobile CI SUCCESS on tip `b32e74c` (run 35181873152) after #152 republished `lynx-v2-debug-b32e74c`. Do not invent a newer APK SHA than the published tag.
- Product **NOT DONE** / 三关未齐 / not EXHAUSTED. 真机残差 unchanged: Connect welcome **card chrome** confirm still open for Yee on published APK `lynx-v2-debug-b32e74c`. No 真机过 claim. Host-only unchanged (Keychain/camera/IME/Pierre/WKWebView/Mode B/Share ext/ShareReceiverActivity/iOS IPA/FCM for lynx.debug/Live Activity/clipboard host).

## Notes — Docs tip APK/SHA honesty post-#112 (Next #113 / 2026-09-17)

- Cap phone skim (MobileApp overflow / Files / Changes incl. stageAll/unstageAll/revertAll / SessionsSheet / chat header-swipe+sync hint / MCP sheet / ProjectsHome / Assistant / Scheduled list/editor/run/delete/history / Settings / Connect welcome vs `packages/lynx`) found **no** new Linux-closable Cap product gap outside deferred thin leftovers (`@dnd-kit` / MobileWindowMotion / iPad sidebar / Cap toast sonner / bulk multi-select) and host-only (Keychain/camera/IME/Pierre/WKWebView/Mode B/Share ext/ShareReceiverActivity/iOS IPA/FCM for lynx.debug/Live Activity/clipboard host). Incremental leftovers (not new product API wires): Scheduled history first-page list already 代码接上; Cap load-more/`nextCursor` + per-task filter stay thin polish. Settings search filter is wired (`filterLynxSettingsPages`). SessionsSheet/ProjectsHome row Stop is extra affordance (`abortSession` already wired from composer/goal). Active Show more beyond session-index snapshot is the same class as Scheduled history `nextCursor`. `GET /api/client-auth/connection/candidates` is post-connect lifecycle leftover, not welcome-blocking. **NO_NEW_LINUX_CLOSABLE_PRODUCT_GAP**.
- Tip / prerelease APK: `lynx-v2-debug-aa08bbf` (work/lynx-native @ `aa08bbf7ed68ce46503b21db444c4aafb1787448`; PR #153 / Next #112 MERGED; release exists). Was stale `lynx-v2-debug-b32e74c` / tip `b32e74c05ff9041d787442cc3ab4087d2f15e87e`. Lynx Mobile CI SUCCESS on tip `aa08bbf` (run 35195640711) after #153 republished `lynx-v2-debug-aa08bbf`. Do not invent a newer APK SHA than the published tag.
- Product **NOT DONE** / 三关未齐 / not EXHAUSTED. 真机残差 unchanged: Connect welcome **card chrome** confirm still open for Yee on published APK `lynx-v2-debug-aa08bbf`. No 真机过 claim. Host-only unchanged (Keychain/camera/IME/Pierre/WKWebView/Mode B/Share ext/ShareReceiverActivity/iOS IPA/FCM for lynx.debug/Live Activity/clipboard host).

## Notes — Docs tip APK/SHA honesty post-#113 (Next #114 / 2026-09-17)

- Cap phone skim (MobileApp overflow / Files / Changes incl. stageAll/unstageAll/revertAll / SessionsSheet / chat header-swipe+sync hint / MCP sheet / ProjectsHome / Assistant / Scheduled list/editor/run/delete/history / Settings / Connect welcome vs `packages/lynx`) found **no** new Linux-closable Cap product gap outside deferred thin leftovers (`@dnd-kit` / MobileWindowMotion / iPad sidebar / Cap toast sonner / bulk multi-select) and host-only (Keychain/camera/IME/Pierre/WKWebView/Mode B/Share ext/ShareReceiverActivity/iOS IPA/FCM for lynx.debug/Live Activity/clipboard host). Incremental leftovers (not new product API wires): Scheduled history first-page list already 代码接上; Cap load-more/`nextCursor` + per-task filter stay thin polish. Settings search filter is wired (`filterLynxSettingsPages`). SessionsSheet/ProjectsHome row Stop is extra affordance (`abortSession` already wired from composer/goal). Active Show more beyond session-index snapshot is the same class as Scheduled history `nextCursor`. `GET /api/client-auth/connection/candidates` is post-connect lifecycle leftover, not welcome-blocking. **NO_NEW_LINUX_CLOSABLE_PRODUCT_GAP**.
- Tip / prerelease APK: `lynx-v2-debug-1142c4e` (work/lynx-native @ `1142c4e2b0863c45ee25bc2452ea03078220155e`; PR #154 / Next #113 MERGED; release exists). Was stale `lynx-v2-debug-aa08bbf` / tip `aa08bbf7ed68ce46503b21db444c4aafb1787448`. Lynx Mobile CI SUCCESS on tip `1142c4e` (run 35209662353) after #154 republished `lynx-v2-debug-1142c4e`. Do not invent a newer APK SHA than the published tag.
- Product **NOT DONE** / 三关未齐 / not EXHAUSTED. 真机残差 unchanged: Connect welcome **card chrome** confirm still open for Yee on published APK `lynx-v2-debug-1142c4e`. No 真机过 claim. Host-only unchanged (Keychain/camera/IME/Pierre/WKWebView/Mode B/Share ext/ShareReceiverActivity/iOS IPA/FCM for lynx.debug/Live Activity/clipboard host).

## Notes — Docs tip APK/SHA honesty post-#114 (Next #115 / 2026-09-17)

- Cap phone skim (MobileApp overflow / Files / Changes incl. stageAll/unstageAll/revertAll / SessionsSheet / chat header-swipe+sync hint / MCP sheet / ProjectsHome / Assistant / Scheduled list/editor/run/delete/history / Settings / Connect welcome vs `packages/lynx`) found **no** new Linux-closable Cap product gap outside deferred thin leftovers (`@dnd-kit` / MobileWindowMotion / iPad sidebar / Cap toast sonner / bulk multi-select) and host-only (Keychain/camera/IME/Pierre/WKWebView/Mode B/Share ext/ShareReceiverActivity/iOS IPA/FCM for lynx.debug/Live Activity/clipboard host). Incremental leftovers (not new product API wires): Scheduled history first-page list already 代码接上; Cap load-more/`nextCursor` + per-task filter stay thin polish. Settings search filter is wired (`filterLynxSettingsPages`). SessionsSheet/ProjectsHome row Stop is extra affordance (`abortSession` already wired from composer/goal). Active Show more beyond session-index snapshot is the same class as Scheduled history `nextCursor`. `GET /api/client-auth/connection/candidates` is post-connect lifecycle leftover, not welcome-blocking. **NO_NEW_LINUX_CLOSABLE_PRODUCT_GAP**.
- Tip / prerelease APK: `lynx-v2-debug-a0dd0a9` (work/lynx-native @ `a0dd0a93e016adca96ceca2fe3b9d0c710e7cd18`; PR #155 / Next #114 MERGED; release exists). Was stale `lynx-v2-debug-1142c4e` / tip `1142c4e2b0863c45ee25bc2452ea03078220155e`. Lynx Mobile CI SUCCESS on tip `a0dd0a9` (run 35211291083). Do not invent a newer APK SHA than the published tag.
- Product **NOT DONE** / 三关未齐 / not EXHAUSTED. 真机残差 unchanged: Connect welcome **card chrome** confirm still open for Yee on published APK `lynx-v2-debug-a0dd0a9`. No 真机过 claim. Host-only unchanged (Keychain/camera/IME/Pierre/WKWebView/Mode B/Share ext/ShareReceiverActivity/iOS IPA/FCM for lynx.debug/Live Activity/clipboard host).

## Notes — Docs tip APK/SHA honesty post-#115 (Next #116 / 2026-09-18)

- Cap phone skim (MobileApp overflow / Files / Changes incl. stageAll/unstageAll/revertAll / SessionsSheet / chat header-swipe+sync hint / MCP sheet / ProjectsHome / Assistant / Scheduled list/editor/run/delete/history / Settings / Connect welcome vs `packages/lynx`) found **no** new Linux-closable Cap product gap outside deferred thin leftovers (`@dnd-kit` / MobileWindowMotion / iPad sidebar / Cap toast sonner / bulk multi-select) and host-only (Keychain/camera/IME/Pierre/WKWebView/Mode B/Share ext/ShareReceiverActivity/iOS IPA/FCM for lynx.debug/Live Activity/clipboard host). Incremental leftovers (not new product API wires): Scheduled history first-page list already 代码接上; Cap load-more/`nextCursor` + per-task filter stay thin polish. Settings search filter is wired (`filterLynxSettingsPages`). SessionsSheet/ProjectsHome row Stop is extra affordance (`abortSession` already wired from composer/goal). Active Show more beyond session-index snapshot is the same class as Scheduled history `nextCursor`. `GET /api/client-auth/connection/candidates` is post-connect lifecycle leftover, not welcome-blocking. **NO_NEW_LINUX_CLOSABLE_PRODUCT_GAP**.
- Tip / prerelease APK: `lynx-v2-debug-04325ba` (work/lynx-native @ `04325ba8dfcd8700d4790670a03e2570d4f4acc4`; PR #156 / Next #115 MERGED; release exists). Was stale `lynx-v2-debug-a0dd0a9` / tip `a0dd0a93e016adca96ceca2fe3b9d0c710e7cd18`. Lynx Mobile CI SUCCESS on tip `04325ba` (run 35229914916). Do not invent a newer APK SHA than the published tag.
- Product **NOT DONE** / 三关未齐 / not EXHAUSTED. 真机残差 unchanged: Connect welcome **card chrome** confirm still open for Yee on published APK `lynx-v2-debug-04325ba`. No 真机过 claim. Host-only unchanged (Keychain/camera/IME/Pierre/WKWebView/Mode B/Share ext/ShareReceiverActivity/iOS IPA/FCM for lynx.debug/Live Activity/clipboard host).

## Notes — Docs tip APK/SHA honesty post-#116 (Next #117 / 2026-09-17)

- Cap phone skim (MobileApp overflow / Files / Changes incl. stageAll/unstageAll/revertAll / SessionsSheet / chat header-swipe+sync hint / MCP sheet / ProjectsHome / Assistant / Scheduled list/editor/run/delete/history / Settings / Connect welcome vs `packages/lynx`) found **no** new Linux-closable Cap product gap outside deferred thin leftovers (`@dnd-kit` / MobileWindowMotion / iPad sidebar / Cap toast sonner / bulk multi-select) and host-only (Keychain/camera/IME/Pierre/WKWebView/Mode B/Share ext/ShareReceiverActivity/iOS IPA/FCM for lynx.debug/Live Activity/clipboard host). Incremental leftovers (not new product API wires): Scheduled history first-page list already 代码接上; Cap load-more/`nextCursor` + per-task filter stay thin polish. Settings search filter is wired (`filterLynxSettingsPages`). SessionsSheet/ProjectsHome row Stop is extra affordance (`abortSession` already wired from composer/goal). Active Show more beyond session-index snapshot is the same class as Scheduled history `nextCursor`. `GET /api/client-auth/connection/candidates` is post-connect lifecycle leftover, not welcome-blocking. **NO_NEW_LINUX_CLOSABLE_PRODUCT_GAP**.
- Tip / prerelease APK: `lynx-v2-debug-4b4fbcc` (work/lynx-native @ `4b4fbcc0f0e05eae50c12177f8486682a544b381`; PR #157 / Next #116 MERGED; release exists). Was stale `lynx-v2-debug-04325ba` / tip `04325ba8dfcd8700d4790670a03e2570d4f4acc4`. Lynx Mobile CI SUCCESS on tip `4b4fbcc` (run 35249088590). Do not invent a newer APK SHA than the published tag.
- Product **NOT DONE** / 三关未齐 / not EXHAUSTED. 真机残差 unchanged: Connect welcome **card chrome** confirm still open for Yee on published APK `lynx-v2-debug-4b4fbcc`. No 真机过 claim. Host-only unchanged (Keychain/camera/IME/Pierre/WKWebView/Mode B/Share ext/ShareReceiverActivity/iOS IPA/FCM for lynx.debug/Live Activity/clipboard host).

## Notes — Docs tip APK/SHA honesty post-#117 (Next #118 / 2026-09-17)

- Cap phone skim (MobileApp overflow / Files / Changes incl. stageAll/unstageAll/revertAll / SessionsSheet / chat header-swipe+sync hint / MCP sheet / ProjectsHome / Assistant / Scheduled list/editor/run/delete/history / Settings / Connect welcome vs `packages/lynx`) found **no** new Linux-closable Cap product gap outside deferred thin leftovers (`@dnd-kit` / MobileWindowMotion / iPad sidebar / Cap toast sonner / bulk multi-select) and host-only (Keychain/camera/IME/Pierre/WKWebView/Mode B/Share ext/ShareReceiverActivity/iOS IPA/FCM for lynx.debug/Live Activity/clipboard host). Incremental leftovers (not new product API wires): Scheduled history first-page list already 代码接上; Cap load-more/`nextCursor` + per-task filter stay thin polish. Settings search filter is wired (`filterLynxSettingsPages`). SessionsSheet/ProjectsHome row Stop is extra affordance (`abortSession` already wired from composer/goal). Active Show more beyond session-index snapshot is the same class as Scheduled history `nextCursor`. `GET /api/client-auth/connection/candidates` is post-connect lifecycle leftover, not welcome-blocking. **NO_NEW_LINUX_CLOSABLE_PRODUCT_GAP**.
- Tip / prerelease APK: `lynx-v2-debug-554e70e` (work/lynx-native @ `554e70e18dc18fe509ae02fdcdd43faead587ed1`; PR #158 / Next #117 MERGED; release exists). Was stale `lynx-v2-debug-4b4fbcc` / tip `4b4fbcc0f0e05eae50c12177f8486682a544b381`. Lynx Mobile CI SUCCESS on tip `554e70e` (run 35266255595). Do not invent a newer APK SHA than the published tag.
- Product **NOT DONE** / 三关未齐 / not EXHAUSTED. 真机残差 unchanged: Connect welcome **card chrome** confirm still open for Yee on published APK `lynx-v2-debug-554e70e`. No 真机过 claim. Host-only unchanged (Keychain/camera/IME/Pierre/WKWebView/Mode B/Share ext/ShareReceiverActivity/iOS IPA/FCM for lynx.debug/Live Activity/clipboard host).

## Notes — Docs tip APK/SHA honesty post-#118 (Next #119 / 2026-09-18)

- Cap phone skim (MobileApp overflow / Files / Changes incl. stageAll/unstageAll/revertAll / SessionsSheet / chat header-swipe+sync hint / MCP sheet / ProjectsHome / Assistant / Scheduled list/editor/run/delete/history / Settings / Connect welcome vs `packages/lynx`) found **no** new Linux-closable Cap product gap outside deferred thin leftovers (`@dnd-kit` / MobileWindowMotion / iPad sidebar / Cap toast sonner / bulk multi-select) and host-only (Keychain/camera/IME/Pierre/WKWebView/Mode B/Share ext/ShareReceiverActivity/iOS IPA/FCM for lynx.debug/Live Activity/clipboard host). Incremental leftovers (not new product API wires): Scheduled history first-page list already 代码接上; Cap load-more/`nextCursor` + per-task filter stay thin polish. Settings search filter is wired (`filterLynxSettingsPages`). SessionsSheet/ProjectsHome row Stop is extra affordance (`abortSession` already wired from composer/goal). Active Show more beyond session-index snapshot is the same class as Scheduled history `nextCursor`. `GET /api/client-auth/connection/candidates` is post-connect lifecycle leftover, not welcome-blocking. **NO_NEW_LINUX_CLOSABLE_PRODUCT_GAP**.
- Tip / prerelease APK: `lynx-v2-debug-6215ead` (work/lynx-native @ `6215ead5164c086d720629165ab31aac3c3b15a1`; PR #159 / Next #118 MERGED; release exists). Was stale `lynx-v2-debug-554e70e` / tip `554e70e18dc18fe509ae02fdcdd43faead587ed1`. Lynx Mobile CI SUCCESS on tip `6215ead` (run 35283067717). Do not invent a newer APK SHA than the published tag.
- Product **NOT DONE** / 三关未齐 / not EXHAUSTED. 真机残差 unchanged: Connect welcome **card chrome** confirm still open for Yee on published APK `lynx-v2-debug-6215ead`. No 真机过 claim. Host-only unchanged (Keychain/camera/IME/Pierre/WKWebView/Mode B/Share ext/ShareReceiverActivity/iOS IPA/FCM for lynx.debug/Live Activity/clipboard host).

## Notes — Docs tip APK/SHA honesty post-#119 (Next #120 / 2026-09-18)

- Cap phone skim (MobileApp overflow / Files / Changes incl. stageAll/unstageAll/revertAll / SessionsSheet / chat header-swipe+sync hint / MCP sheet / ProjectsHome / Assistant / Scheduled list/editor/run/delete/history / Settings / Connect welcome vs `packages/lynx`) found **no** new Linux-closable Cap product gap outside deferred thin leftovers (`@dnd-kit` / MobileWindowMotion / iPad sidebar / Cap toast sonner / bulk multi-select) and host-only (Keychain/camera/IME/Pierre/WKWebView/Mode B/Share ext/ShareReceiverActivity/iOS IPA/FCM for lynx.debug/Live Activity/clipboard host). Incremental leftovers (not new product API wires): Scheduled history first-page list already 代码接上; Cap load-more/`nextCursor` + per-task filter stay thin polish. Settings search filter is wired (`filterLynxSettingsPages`). SessionsSheet/ProjectsHome row Stop is extra affordance (`abortSession` already wired from composer/goal). Active Show more beyond session-index snapshot is the same class as Scheduled history `nextCursor`. `GET /api/client-auth/connection/candidates` is post-connect lifecycle leftover, not welcome-blocking. **NO_NEW_LINUX_CLOSABLE_PRODUCT_GAP**.
- Tip / prerelease APK: `lynx-v2-debug-06d4ac4` (work/lynx-native @ `06d4ac4138eba038259490d857be37ba59c8daad`; PR #160 / Next #119 MERGED; release exists). Was stale `lynx-v2-debug-6215ead` / tip `6215ead5164c086d720629165ab31aac3c3b15a1`. Lynx Mobile CI SUCCESS on tip `06d4ac4` (run 35295752653). Do not invent a newer APK SHA than the published tag.
- Product **NOT DONE** / 三关未齐 / not EXHAUSTED. 真机残差 unchanged: Connect welcome **card chrome** confirm still open for Yee on published APK `lynx-v2-debug-06d4ac4`. No 真机过 claim. Host-only unchanged (Keychain/camera/IME/Pierre/WKWebView/Mode B/Share ext/ShareReceiverActivity/iOS IPA/FCM for lynx.debug/Live Activity/clipboard host).

## Notes — Docs tip APK/SHA honesty post-#120 (Next #121 / 2026-09-18)

- Cap phone skim (MobileApp overflow / Files / Changes incl. stageAll/unstageAll/revertAll / SessionsSheet / chat header-swipe+sync hint / MCP sheet / ProjectsHome / Assistant / Scheduled list/editor/run/delete/history / Settings / Connect welcome vs `packages/lynx`) found **no** new Linux-closable Cap product gap outside deferred thin leftovers (`@dnd-kit` / MobileWindowMotion / iPad sidebar / Cap toast sonner / bulk multi-select) and host-only (Keychain/camera/IME/Pierre/WKWebView/Mode B/Share ext/ShareReceiverActivity/iOS IPA/FCM for lynx.debug/Live Activity/clipboard host). Incremental leftovers (not new product API wires): Scheduled history first-page list already 代码接上; Cap load-more/`nextCursor` + per-task filter stay thin polish. Settings search filter is wired (`filterLynxSettingsPages`). SessionsSheet/ProjectsHome row Stop is extra affordance (`abortSession` already wired from composer/goal). Active Show more beyond session-index snapshot is the same class as Scheduled history `nextCursor`. `GET /api/client-auth/connection/candidates` is post-connect lifecycle leftover, not welcome-blocking. **NO_NEW_LINUX_CLOSABLE_PRODUCT_GAP**.
- Tip / prerelease APK: `lynx-v2-debug-3a87f8b` (work/lynx-native @ `3a87f8bcd0e575a747909a6042ae881e8666098c`; PR #161 / Next #120 MERGED; release exists). Was stale `lynx-v2-debug-06d4ac4` / tip `06d4ac4138eba038259490d857be37ba59c8daad` (tip delta `06d4ac4`→`3a87f8b` is docs-only). Lynx Mobile CI SUCCESS on tip `3a87f8b` (run 35307346909). Do not invent a newer APK SHA than the published tag.
- Product **NOT DONE** / 三关未齐 / not EXHAUSTED. 真机残差 unchanged: Connect welcome **card chrome** confirm still open for Yee on published APK `lynx-v2-debug-3a87f8b`. No 真机过 claim. Host-only unchanged (Keychain/camera/IME/Pierre/WKWebView/Mode B/Share ext/ShareReceiverActivity/iOS IPA/FCM for lynx.debug/Live Activity/clipboard host).

## Notes — Docs tip APK/SHA honesty post-#121 (Next #122 / 2026-09-18)

- Cap phone skim (MobileApp overflow / Files / Changes incl. stageAll/unstageAll/revertAll / SessionsSheet / chat header-swipe+sync hint / MCP sheet / ProjectsHome / Assistant / Scheduled list/editor/run/delete/history / Settings / Connect welcome vs `packages/lynx`) found **no** new Linux-closable Cap product gap outside deferred thin leftovers (`@dnd-kit` / MobileWindowMotion / iPad sidebar / Cap toast sonner / bulk multi-select) and host-only (Keychain/camera/IME/Pierre/WKWebView/Mode B/Share ext/ShareReceiverActivity/iOS IPA/FCM for lynx.debug/Live Activity/clipboard host). Incremental leftovers (not new product API wires): Scheduled history first-page list already 代码接上; Cap load-more/`nextCursor` + per-task filter stay thin polish. Settings search filter is wired (`filterLynxSettingsPages`). SessionsSheet/ProjectsHome row Stop is extra affordance (`abortSession` already wired from composer/goal). Active Show more beyond session-index snapshot is the same class as Scheduled history `nextCursor`. `GET /api/client-auth/connection/candidates` is post-connect lifecycle leftover, not welcome-blocking. **NO_NEW_LINUX_CLOSABLE_PRODUCT_GAP**.
- Tip / prerelease APK: `lynx-v2-debug-5018ded` (work/lynx-native @ `5018ded1c818d06d07c6a60667e36c16004f3d44`; PR #162 / Next #121 MERGED; release exists). Was stale `lynx-v2-debug-3a87f8b` / tip `3a87f8bcd0e575a747909a6042ae881e8666098c` (tip delta `3a87f8b`→`5018ded` is docs-only). Lynx Mobile CI SUCCESS on tip `5018ded` (run 35320424832). Do not invent a newer APK SHA than the published tag.
- Product **NOT DONE** / 三关未齐 / not EXHAUSTED. 真机残差 unchanged: Connect welcome **card chrome** confirm still open for Yee on published APK `lynx-v2-debug-5018ded`. No 真机过 claim. Host-only unchanged (Keychain/camera/IME/Pierre/WKWebView/Mode B/Share ext/ShareReceiverActivity/iOS IPA/FCM for lynx.debug/Live Activity/clipboard host).

## Notes — Docs tip APK/SHA honesty post-#122 (Next #123 / 2026-09-18)

- Cap phone skim (MobileApp overflow / Files / Changes incl. stageAll/unstageAll/revertAll / SessionsSheet / chat header-swipe+sync hint / MCP sheet / ProjectsHome / Assistant / Scheduled list/editor/run/delete/history / Settings / Connect welcome vs `packages/lynx`) found **no** new Linux-closable Cap product gap outside deferred thin leftovers (`@dnd-kit` / MobileWindowMotion / iPad sidebar / Cap toast sonner / bulk multi-select) and host-only (Keychain/camera/IME/Pierre/WKWebView/Mode B/Share ext/ShareReceiverActivity/iOS IPA/FCM for lynx.debug/Live Activity/clipboard host). Incremental leftovers (not new product API wires): Scheduled history first-page list already 代码接上; Cap load-more/`nextCursor` + per-task filter stay thin polish. Settings search filter is wired (`filterLynxSettingsPages`). SessionsSheet/ProjectsHome row Stop is extra affordance (`abortSession` already wired from composer/goal). Active Show more beyond session-index snapshot is the same class as Scheduled history `nextCursor`. `GET /api/client-auth/connection/candidates` is post-connect lifecycle leftover, not welcome-blocking. **NO_NEW_LINUX_CLOSABLE_PRODUCT_GAP**.
- Tip / prerelease APK: `lynx-v2-debug-c1e2f5c` (work/lynx-native @ `c1e2f5c67b5d8e0d75a4363dae1a61b8f95593af`; PR #163 / Next #122 MERGED; release exists). Was stale `lynx-v2-debug-5018ded` / tip `5018ded1c818d06d07c6a60667e36c16004f3d44` (tip delta `5018ded`→`c1e2f5c` is docs-only). Lynx Mobile CI SUCCESS on tip `c1e2f5c` (run 35333814514). Do not invent a newer APK SHA than the published tag.
- Product **NOT DONE** / 三关未齐 / not EXHAUSTED. 真机残差 unchanged: Connect welcome **card chrome** confirm still open for Yee on published APK `lynx-v2-debug-c1e2f5c`. No 真机过 claim. Host-only unchanged (Keychain/camera/IME/Pierre/WKWebView/Mode B/Share ext/ShareReceiverActivity/iOS IPA/FCM for lynx.debug/Live Activity/clipboard host).

## Notes — Docs tip APK/SHA honesty post-#123 (Next #124 / 2026-09-18)

- Cap phone skim (MobileApp overflow / Files / Changes incl. stageAll/unstageAll/revertAll / SessionsSheet / chat header-swipe+sync hint / MCP sheet / ProjectsHome / Assistant / Scheduled list/editor/run/delete/history / Settings / Connect welcome vs `packages/lynx`) found **no** new Linux-closable Cap product gap outside deferred thin leftovers (`@dnd-kit` / MobileWindowMotion / iPad sidebar / Cap toast sonner / bulk multi-select) and host-only (Keychain/camera/IME/Pierre/WKWebView/Mode B/Share ext/ShareReceiverActivity/iOS IPA/FCM for lynx.debug/Live Activity/clipboard host). Incremental leftovers (not new product API wires): Scheduled history first-page list already 代码接上; Cap load-more/`nextCursor` + per-task filter stay thin polish. Settings search filter is wired (`filterLynxSettingsPages`). SessionsSheet/ProjectsHome row Stop is extra affordance (`abortSession` already wired from composer/goal). Active Show more beyond session-index snapshot is the same class as Scheduled history `nextCursor`. `GET /api/client-auth/connection/candidates` is post-connect lifecycle leftover, not welcome-blocking. **NO_NEW_LINUX_CLOSABLE_PRODUCT_GAP**.
- Tip / prerelease APK: `lynx-v2-debug-74d2d29` (work/lynx-native @ `74d2d29ac5311a4b72f52474f73027f729ab7944`; PR #164 / Next #123 MERGED; release exists). Was stale `lynx-v2-debug-c1e2f5c` / tip `c1e2f5c67b5d8e0d75a4363dae1a61b8f95593af` (tip delta `c1e2f5c`→`74d2d29` is docs-only). Lynx Mobile CI SUCCESS on tip `74d2d29` (run 35335482752). Do not invent a newer APK SHA than the published tag.
- Product **NOT DONE** / 三关未齐 / not EXHAUSTED. 真机残差 unchanged: Connect welcome **card chrome** confirm still open for Yee on published APK `lynx-v2-debug-74d2d29`. No 真机过 claim. Host-only unchanged (Keychain/camera/IME/Pierre/WKWebView/Mode B/Share ext/ShareReceiverActivity/iOS IPA/FCM for lynx.debug/Live Activity/clipboard host).

## Notes — Docs tip APK/SHA honesty post-#124 (Next #125 / 2026-09-18)

- Cap phone skim (MobileApp overflow / Files / Changes incl. stageAll/unstageAll/revertAll / SessionsSheet / chat header-swipe+sync hint / MCP sheet / ProjectsHome / Assistant / Scheduled list/editor/run/delete/history / Settings / Connect welcome vs `packages/lynx`) found **no** new Linux-closable Cap product gap outside deferred thin leftovers (`@dnd-kit` / MobileWindowMotion / iPad sidebar / Cap toast sonner / bulk multi-select) and host-only (Keychain/camera/IME/Pierre/WKWebView/Mode B/Share ext/ShareReceiverActivity/iOS IPA/FCM for lynx.debug/Live Activity/clipboard host). Incremental leftovers (not new product API wires): Scheduled history first-page list already 代码接上; Cap load-more/`nextCursor` + per-task filter stay thin polish. Settings search filter is wired (`filterLynxSettingsPages`). SessionsSheet/ProjectsHome row Stop is extra affordance (`abortSession` already wired from composer/goal). Active Show more beyond session-index snapshot is the same class as Scheduled history `nextCursor`. `GET /api/client-auth/connection/candidates` is post-connect lifecycle leftover, not welcome-blocking. **NO_NEW_LINUX_CLOSABLE_PRODUCT_GAP**.
- Tip / prerelease APK: `lynx-v2-debug-cc15c1a` (work/lynx-native @ `cc15c1aefdd41e909ed3f55aa1171e067be84adf`; PR #165 / Next #124 MERGED; release exists). Was stale `lynx-v2-debug-74d2d29` / tip `74d2d29ac5311a4b72f52474f73027f729ab7944` (tip delta `74d2d29`→`cc15c1a` is docs-only). Lynx Mobile CI SUCCESS on tip `cc15c1a` (run 35353222951). Do not invent a newer APK SHA than the published tag.
- Product **NOT DONE** / 三关未齐 / not EXHAUSTED. 真机残差 unchanged: Connect welcome **card chrome** confirm still open for Yee on published APK `lynx-v2-debug-cc15c1a`. No 真机过 claim. Host-only unchanged (Keychain/camera/IME/Pierre/WKWebView/Mode B/Share ext/ShareReceiverActivity/iOS IPA/FCM for lynx.debug/Live Activity/clipboard host).

## Notes — Docs tip APK/SHA honesty post-#125 (Next #126 / 2026-09-18)

- Cap phone skim (MobileApp overflow / Files / Changes incl. stageAll/unstageAll/revertAll / SessionsSheet / chat header-swipe+sync hint / MCP sheet / ProjectsHome / Assistant / Scheduled list/editor/run/delete/history / Settings / Connect welcome vs `packages/lynx`) found **no** new Linux-closable Cap product gap outside deferred thin leftovers (`@dnd-kit` / MobileWindowMotion / iPad sidebar / Cap toast sonner / bulk multi-select) and host-only (Keychain/camera/IME/Pierre/WKWebView/Mode B/Share ext/ShareReceiverActivity/iOS IPA/FCM for lynx.debug/Live Activity/clipboard host). Incremental leftovers (not new product API wires): Scheduled history first-page list already 代码接上; Cap load-more/`nextCursor` + per-task filter stay thin polish. Settings search filter is wired (`filterLynxSettingsPages`). SessionsSheet/ProjectsHome row Stop is extra affordance (`abortSession` already wired from composer/goal). Active Show more beyond session-index snapshot is the same class as Scheduled history `nextCursor`. `GET /api/client-auth/connection/candidates` is post-connect lifecycle leftover, not welcome-blocking. **NO_NEW_LINUX_CLOSABLE_PRODUCT_GAP**.
- Tip / prerelease APK: `lynx-v2-debug-592192f` (work/lynx-native @ `592192f993ec3b429f49782c07d3c9194eea5127`; PR #166 / Next #125 MERGED; release exists). Was stale `lynx-v2-debug-cc15c1a` / tip `cc15c1aefdd41e909ed3f55aa1171e067be84adf` (tip delta `cc15c1a`→`592192f` is docs-only). Lynx Mobile CI SUCCESS on tip `592192f` (run 35371422190). Do not invent a newer APK SHA than the published tag.
- Product **NOT DONE** / 三关未齐 / not EXHAUSTED. 真机残差 unchanged: Connect welcome **card chrome** confirm still open for Yee on published APK `lynx-v2-debug-592192f`. No 真机过 claim. Host-only unchanged (Keychain/camera/IME/Pierre/WKWebView/Mode B/Share ext/ShareReceiverActivity/iOS IPA/FCM for lynx.debug/Live Activity/clipboard host).

## Notes — Docs tip APK/SHA honesty post-#126 (Next #127 / 2026-09-18)

- Cap phone skim (MobileApp overflow / Files / Changes incl. stageAll/unstageAll/revertAll / SessionsSheet / chat header-swipe+sync hint / MCP sheet / ProjectsHome / Assistant / Scheduled list/editor/run/delete/history / Settings / Connect welcome vs `packages/lynx`) found **no** new Linux-closable Cap product gap outside deferred thin leftovers (`@dnd-kit` / MobileWindowMotion / iPad sidebar / Cap toast sonner / bulk multi-select) and host-only (Keychain/camera/IME/Pierre/WKWebView/Mode B/Share ext/ShareReceiverActivity/iOS IPA/FCM for lynx.debug/Live Activity/clipboard host). Incremental leftovers (not new product API wires): Scheduled history first-page list already 代码接上; Cap load-more/`nextCursor` + per-task filter stay thin polish. Settings search filter is wired (`filterLynxSettingsPages`). SessionsSheet/ProjectsHome row Stop is extra affordance (`abortSession` already wired from composer/goal). Active Show more beyond session-index snapshot is the same class as Scheduled history `nextCursor`. `GET /api/client-auth/connection/candidates` is post-connect lifecycle leftover, not welcome-blocking. **NO_NEW_LINUX_CLOSABLE_PRODUCT_GAP**.
- Tip / prerelease APK: `lynx-v2-debug-6d5ef04` (work/lynx-native @ `6d5ef04efabf29704c60e2392f10a94c226bcb5c`; PR #167 / Next #126 MERGED; release exists). Was stale `lynx-v2-debug-592192f` / tip `592192f993ec3b429f49782c07d3c9194eea5127` (tip delta `592192f`→`6d5ef04` is docs-only). Lynx Mobile CI SUCCESS on tip `6d5ef04` (run 35388844201). Do not invent a newer APK SHA than the published tag.
- Product **NOT DONE** / 三关未齐 / not EXHAUSTED. 真机残差 unchanged: Connect welcome **card chrome** confirm still open for Yee on published APK `lynx-v2-debug-6d5ef04`. No 真机过 claim. Host-only unchanged (Keychain/camera/IME/Pierre/WKWebView/Mode B/Share ext/ShareReceiverActivity/iOS IPA/FCM for lynx.debug/Live Activity/clipboard host).

## Notes — Docs tip APK/SHA honesty post-#127 (Next #128 / 2026-09-19)

- Cap phone skim (MobileApp overflow / Files / Changes incl. stageAll/unstageAll/revertAll / SessionsSheet / chat header-swipe+sync hint / MCP sheet / ProjectsHome / Assistant / Scheduled list/editor/run/delete/history / Settings / Connect welcome vs `packages/lynx`) found **no** new Linux-closable Cap product gap outside deferred thin leftovers (`@dnd-kit` / MobileWindowMotion / iPad sidebar / Cap toast sonner / bulk multi-select) and host-only (Keychain/camera/IME/Pierre/WKWebView/Mode B/Share ext/ShareReceiverActivity/iOS IPA/FCM for lynx.debug/Live Activity/clipboard host). Incremental leftovers (not new product API wires): Scheduled history first-page list already 代码接上; Cap load-more/`nextCursor` + per-task filter stay thin polish. Settings search filter is wired (`filterLynxSettingsPages`). SessionsSheet/ProjectsHome row Stop is extra affordance (`abortSession` already wired from composer/goal). Active Show more beyond session-index snapshot is the same class as Scheduled history `nextCursor`. `GET /api/client-auth/connection/candidates` is post-connect lifecycle leftover, not welcome-blocking. **NO_NEW_LINUX_CLOSABLE_PRODUCT_GAP**.
- Tip / prerelease APK: `lynx-v2-debug-6c1f6d4` (work/lynx-native @ `6c1f6d4c61438e1678a8f1afafc283ed5d9fcc1a`; PR #168 / Next #127 MERGED; release exists). Was stale `lynx-v2-debug-6d5ef04` / tip `6d5ef04efabf29704c60e2392f10a94c226bcb5c` (tip delta `6d5ef04`→`6c1f6d4` is docs-only). Lynx Mobile CI SUCCESS on tip `6c1f6d4` (run 35402341644). Do not invent a newer APK SHA than the published tag.
- Product **NOT DONE** / 三关未齐 / not EXHAUSTED. 真机残差 unchanged: Connect welcome **card chrome** confirm still open for Yee on published APK `lynx-v2-debug-6c1f6d4`. No 真机过 claim. Host-only unchanged (Keychain/camera/IME/Pierre/WKWebView/Mode B/Share ext/ShareReceiverActivity/iOS IPA/FCM for lynx.debug/Live Activity/clipboard host).

## Notes — Docs tip APK/SHA honesty post-#128 (Next #129 / 2026-09-19)

- Cap phone skim (MobileApp overflow / Files / Changes incl. stageAll/unstageAll/revertAll / SessionsSheet / chat header-swipe+sync hint / MCP sheet / ProjectsHome / Assistant / Scheduled list/editor/run/delete/history / Settings / Connect welcome vs `packages/lynx`) found **no** new Linux-closable Cap product gap outside deferred thin leftovers (`@dnd-kit` / MobileWindowMotion / iPad sidebar / Cap toast sonner / bulk multi-select) and host-only (Keychain/camera/IME/Pierre/WKWebView/Mode B/Share ext/ShareReceiverActivity/iOS IPA/FCM for lynx.debug/Live Activity/clipboard host). Incremental leftovers (not new product API wires): Scheduled history first-page list already 代码接上; Cap load-more/`nextCursor` + per-task filter stay thin polish. Settings search filter is wired (`filterLynxSettingsPages`). SessionsSheet/ProjectsHome row Stop is extra affordance (`abortSession` already wired from composer/goal). Active Show more beyond session-index snapshot is the same class as Scheduled history `nextCursor`. `GET /api/client-auth/connection/candidates` is post-connect lifecycle leftover, not welcome-blocking. **NO_NEW_LINUX_CLOSABLE_PRODUCT_GAP**.
- Tip / prerelease APK: `lynx-v2-debug-3695bd3` (work/lynx-native @ `3695bd3f12086184a9c778201d232e92bc281f12`; PR #169 / Next #128 MERGED; release exists). Was stale `lynx-v2-debug-6c1f6d4` / tip `6c1f6d4c61438e1678a8f1afafc283ed5d9fcc1a` (tip delta `6c1f6d4`→`3695bd3` is docs-only). Lynx Mobile CI SUCCESS on tip `3695bd3` (run 35412917473). Do not invent a newer APK SHA than the published tag.
- Product **NOT DONE** / 三关未齐 / not EXHAUSTED. 真机残差 unchanged: Connect welcome **card chrome** confirm still open for Yee on published APK `lynx-v2-debug-3695bd3`. No 真机过 claim. Host-only unchanged (Keychain/camera/IME/Pierre/WKWebView/Mode B/Share ext/ShareReceiverActivity/iOS IPA/FCM for lynx.debug/Live Activity/clipboard host).

## Notes — Docs tip APK/SHA honesty post-#129 (Next #130 / 2026-09-19)

- Cap phone skim (MobileApp overflow / Files / Changes incl. stageAll/unstageAll/revertAll / SessionsSheet / chat header-swipe+sync hint / MCP sheet / ProjectsHome / Assistant / Scheduled list/editor/run/delete/history / Settings / Connect welcome vs `packages/lynx`) found **no** new Linux-closable Cap product gap outside deferred thin leftovers (`@dnd-kit` / MobileWindowMotion / iPad sidebar / Cap toast sonner / bulk multi-select) and host-only (Keychain/camera/IME/Pierre/WKWebView/Mode B/Share ext/ShareReceiverActivity/iOS IPA/FCM for lynx.debug/Live Activity/clipboard host). Incremental leftovers (not new product API wires): Scheduled history first-page list already 代码接上; Cap load-more/`nextCursor` + per-task filter stay thin polish. Settings search filter is wired (`filterLynxSettingsPages`). SessionsSheet/ProjectsHome row Stop is extra affordance (`abortSession` already wired from composer/goal). Active Show more beyond session-index snapshot is the same class as Scheduled history `nextCursor`. `GET /api/client-auth/connection/candidates` is post-connect lifecycle leftover, not welcome-blocking. **NO_NEW_LINUX_CLOSABLE_PRODUCT_GAP**.
- Tip / prerelease APK: `lynx-v2-debug-b23a0a4` (work/lynx-native @ `b23a0a4b0e8c997d20ecbbeb85c45643fb3ac1d0`; PR #170 / Next #129 MERGED; release exists). Was stale `lynx-v2-debug-3695bd3` / tip `3695bd3f12086184a9c778201d232e92bc281f12` (tip delta `3695bd3`→`b23a0a4` is docs-only). Lynx Mobile CI SUCCESS on tip `b23a0a4` (run 35421462192). Do not invent a newer APK SHA than the published tag.
- Product **NOT DONE** / 三关未齐 / not EXHAUSTED. 真机残差 unchanged: Connect welcome **card chrome** confirm still open for Yee on published APK `lynx-v2-debug-b23a0a4`. No 真机过 claim. Host-only unchanged (Keychain/camera/IME/Pierre/WKWebView/Mode B/Share ext/ShareReceiverActivity/iOS IPA/FCM for lynx.debug/Live Activity/clipboard host).

## Notes — Docs tip APK/SHA honesty post-#130 (Next #131 / 2026-09-19)

- Cap phone skim (MobileApp overflow / Files / Changes incl. stageAll/unstageAll/revertAll / SessionsSheet / chat header-swipe+sync hint / MCP sheet / ProjectsHome / Assistant / Scheduled list/editor/run/delete/history / Settings / Connect welcome vs `packages/lynx`) found **no** new Linux-closable Cap product gap outside deferred thin leftovers (`@dnd-kit` / MobileWindowMotion / iPad sidebar / Cap toast sonner / bulk multi-select) and host-only (Keychain/camera/IME/Pierre/WKWebView/Mode B/Share ext/ShareReceiverActivity/iOS IPA/FCM for lynx.debug/Live Activity/clipboard host). Incremental leftovers (not new product API wires): Scheduled history first-page list already 代码接上; Cap load-more/`nextCursor` + per-task filter stay thin polish. Settings search filter is wired (`filterLynxSettingsPages`). SessionsSheet/ProjectsHome row Stop is extra affordance (`abortSession` already wired from composer/goal). Active Show more beyond session-index snapshot is the same class as Scheduled history `nextCursor`. `GET /api/client-auth/connection/candidates` is post-connect lifecycle leftover, not welcome-blocking. **NO_NEW_LINUX_CLOSABLE_PRODUCT_GAP**.
- Tip / prerelease APK: `lynx-v2-debug-a11eb83` (work/lynx-native @ `a11eb83c3136388ca951194466d949ec3c554956`; PR #171 / Next #130 MERGED; release exists). Was stale `lynx-v2-debug-b23a0a4` / tip `b23a0a4b0e8c997d20ecbbeb85c45643fb3ac1d0` (tip delta `b23a0a4`→`a11eb83` is docs-only). Lynx Mobile CI SUCCESS on tip `a11eb83` (run 35429567861). Do not invent a newer APK SHA than the published tag.
- Product **NOT DONE** / 三关未齐 / not EXHAUSTED. 真机残差 unchanged: Connect welcome **card chrome** confirm still open for Yee on published APK `lynx-v2-debug-a11eb83`. No 真机过 claim. Host-only unchanged (Keychain/camera/IME/Pierre/WKWebView/Mode B/Share ext/ShareReceiverActivity/iOS IPA/FCM for lynx.debug/Live Activity/clipboard host).

## Notes — Docs tip APK/SHA honesty post-#131 (Next #132 / 2026-09-19)

- Cap phone skim (MobileApp overflow / Files / Changes incl. stageAll/unstageAll/revertAll / SessionsSheet / chat header-swipe+sync hint / MCP sheet / ProjectsHome / Assistant / Scheduled list/editor/run/delete/history / Settings / Connect welcome vs `packages/lynx`) found **no** new Linux-closable Cap product gap outside deferred thin leftovers (`@dnd-kit` / MobileWindowMotion / iPad sidebar / Cap toast sonner / bulk multi-select) and host-only (Keychain/camera/IME/Pierre/WKWebView/Mode B/Share ext/ShareReceiverActivity/iOS IPA/FCM for lynx.debug/Live Activity/clipboard host). Incremental leftovers (not new product API wires): Scheduled history first-page list already 代码接上; Cap load-more/`nextCursor` + per-task filter stay thin polish. Settings search filter is wired (`filterLynxSettingsPages`). SessionsSheet/ProjectsHome row Stop is extra affordance (`abortSession` already wired from composer/goal). Active Show more beyond session-index snapshot is the same class as Scheduled history `nextCursor`. `GET /api/client-auth/connection/candidates` is post-connect lifecycle leftover, not welcome-blocking. **NO_NEW_LINUX_CLOSABLE_PRODUCT_GAP**.
- Tip / prerelease APK: `lynx-v2-debug-d8c0ed2` (work/lynx-native @ `d8c0ed2889958ea6a0882d6a887501c4d3ef7986`; PR #172 / Next #131 MERGED; release exists). Was stale `lynx-v2-debug-a11eb83` / tip `a11eb83c3136388ca951194466d949ec3c554956` (tip delta `a11eb83`→`d8c0ed2` is docs-only). Lynx Mobile CI SUCCESS on tip `d8c0ed2` (run 35437528510). Do not invent a newer APK SHA than the published tag.
- Product **NOT DONE** / 三关未齐 / not EXHAUSTED. 真机残差 unchanged: Connect welcome **card chrome** confirm still open for Yee on published APK `lynx-v2-debug-d8c0ed2`. No 真机过 claim. Host-only unchanged (Keychain/camera/IME/Pierre/WKWebView/Mode B/Share ext/ShareReceiverActivity/iOS IPA/FCM for lynx.debug/Live Activity/clipboard host).

## Notes — Docs tip APK/SHA honesty post-#132 (Next #133 / 2026-09-19)

- Cap phone skim (MobileApp overflow / Files / Changes incl. stageAll/unstageAll/revertAll / SessionsSheet / chat header-swipe+sync hint / MCP sheet / ProjectsHome / Assistant / Scheduled list/editor/run/delete/history / Settings / Connect welcome vs `packages/lynx`) found **no** new Linux-closable Cap product gap outside deferred thin leftovers (`@dnd-kit` / MobileWindowMotion / iPad sidebar / Cap toast sonner / bulk multi-select) and host-only (Keychain/camera/IME/Pierre/WKWebView/Mode B/Share ext/ShareReceiverActivity/iOS IPA/FCM for lynx.debug/Live Activity/clipboard host). Incremental leftovers (not new product API wires): Scheduled history first-page list already 代码接上; Cap load-more/`nextCursor` + per-task filter stay thin polish. Settings search filter is wired (`filterLynxSettingsPages`). SessionsSheet/ProjectsHome row Stop is extra affordance (`abortSession` already wired from composer/goal). Active Show more beyond session-index snapshot is the same class as Scheduled history `nextCursor`. `GET /api/client-auth/connection/candidates` is post-connect lifecycle leftover, not welcome-blocking. **NO_NEW_LINUX_CLOSABLE_PRODUCT_GAP**.
- Tip / prerelease APK: `lynx-v2-debug-59b8a88` (work/lynx-native @ `59b8a88edbb7d1cd15b46cb01830f0180e0b073e`; PR #173 / Next #132 MERGED; release exists). Was stale `lynx-v2-debug-d8c0ed2` / tip `d8c0ed2889958ea6a0882d6a887501c4d3ef7986` (tip delta `d8c0ed2`→`59b8a88` is docs-only). Lynx Mobile CI SUCCESS on tip `59b8a88` (run 35445932721). Do not invent a newer APK SHA than the published tag.
- Product **NOT DONE** / 三关未齐 / not EXHAUSTED. 真机残差 unchanged: Connect welcome **card chrome** confirm still open for Yee on published APK `lynx-v2-debug-59b8a88`. No 真机过 claim. Host-only unchanged (Keychain/camera/IME/Pierre/WKWebView/Mode B/Share ext/ShareReceiverActivity/iOS IPA/FCM for lynx.debug/Live Activity/clipboard host).

## Notes — Docs tip APK/SHA honesty post-#133 (Next #134 / 2026-09-19)

- Cap phone skim (MobileApp overflow / Files / Changes incl. stageAll/unstageAll/revertAll / SessionsSheet / chat header-swipe+sync hint / MCP sheet / ProjectsHome / Assistant / Scheduled list/editor/run/delete/history / Settings / Connect welcome vs `packages/lynx`) found **no** new Linux-closable Cap product gap outside deferred thin leftovers (`@dnd-kit` / MobileWindowMotion / iPad sidebar / Cap toast sonner / bulk multi-select) and host-only (Keychain/camera/IME/Pierre/WKWebView/Mode B/Share ext/ShareReceiverActivity/iOS IPA/FCM for lynx.debug/Live Activity/clipboard host). Incremental leftovers (not new product API wires): Scheduled history first-page list already 代码接上; Cap load-more/`nextCursor` + per-task filter stay thin polish. Settings search filter is wired (`filterLynxSettingsPages`). SessionsSheet/ProjectsHome row Stop is extra affordance (`abortSession` already wired from composer/goal). Active Show more beyond session-index snapshot is the same class as Scheduled history `nextCursor`. `GET /api/client-auth/connection/candidates` is post-connect lifecycle leftover, not welcome-blocking. **NO_NEW_LINUX_CLOSABLE_PRODUCT_GAP**.
- Tip / prerelease APK: `lynx-v2-debug-df87992` (work/lynx-native @ `df879926fd2c8d4ad18d26bdee033f9345cc5c47`; PR #174 / Next #133 MERGED; release exists). Was stale `lynx-v2-debug-59b8a88` / tip `59b8a88edbb7d1cd15b46cb01830f0180e0b073e` (tip delta `59b8a88`→`df87992` is docs-only). Lynx Mobile CI SUCCESS on tip `df87992` (run 35455446737). Do not invent a newer APK SHA than the published tag.
- Product **NOT DONE** / 三关未齐 / not EXHAUSTED. 真机残差 unchanged: Connect welcome **card chrome** confirm still open for Yee on published APK `lynx-v2-debug-df87992`. No 真机过 claim. Host-only unchanged (Keychain/camera/IME/Pierre/WKWebView/Mode B/Share ext/ShareReceiverActivity/iOS IPA/FCM for lynx.debug/Live Activity/clipboard host).

## Notes — Docs tip APK/SHA honesty post-#134 (Next #135 / 2026-09-19)

- Cap phone skim (MobileApp overflow / Files / Changes incl. stageAll/unstageAll/revertAll / SessionsSheet / chat header-swipe+sync hint / MCP sheet / ProjectsHome / Assistant / Scheduled list/editor/run/delete/history / Settings / Connect welcome vs `packages/lynx`) found **no** new Linux-closable Cap product gap outside deferred thin leftovers (`@dnd-kit` / MobileWindowMotion / iPad sidebar / Cap toast sonner / bulk multi-select) and host-only (Keychain/camera/IME/Pierre/WKWebView/Mode B/Share ext/ShareReceiverActivity/iOS IPA/FCM for lynx.debug/Live Activity/clipboard host). Incremental leftovers (not new product API wires): Scheduled history first-page list already 代码接上; Cap load-more/`nextCursor` + per-task filter stay thin polish. Settings search filter is wired (`filterLynxSettingsPages`). SessionsSheet/ProjectsHome row Stop is extra affordance (`abortSession` already wired from composer/goal). Active Show more beyond session-index snapshot is the same class as Scheduled history `nextCursor`. `GET /api/client-auth/connection/candidates` is post-connect lifecycle leftover, not welcome-blocking. **NO_NEW_LINUX_CLOSABLE_PRODUCT_GAP**.
- Tip / prerelease APK: `lynx-v2-debug-b7db06b` (work/lynx-native @ `b7db06b75f9b9f37c7a598efaa03987c3a1bdd1f`; PR #175 / Next #134 MERGED; release exists). Was stale `lynx-v2-debug-df87992` / tip `df879926fd2c8d4ad18d26bdee033f9345cc5c47` (tip delta `df87992`→`b7db06b` is docs-only). Lynx Mobile CI SUCCESS on tip `b7db06b` (run 35464341914). Do not invent a newer APK SHA than the published tag.
- Product **NOT DONE** / 三关未齐 / not EXHAUSTED. 真机残差 unchanged: Connect welcome **card chrome** confirm still open for Yee on published APK `lynx-v2-debug-b7db06b`. No 真机过 claim. Host-only unchanged (Keychain/camera/IME/Pierre/WKWebView/Mode B/Share ext/ShareReceiverActivity/iOS IPA/FCM for lynx.debug/Live Activity/clipboard host).

## Notes — Docs tip APK/SHA honesty post-#135 (Next #136 / 2026-09-20)

- Cap phone skim (MobileApp overflow / Files / Changes incl. stageAll/unstageAll/revertAll / SessionsSheet / chat header-swipe+sync hint / MCP sheet / ProjectsHome / Assistant / Scheduled list/editor/run/delete/history / Settings / Connect welcome vs `packages/lynx`) found **no** new Linux-closable Cap product gap outside deferred thin leftovers (`@dnd-kit` / MobileWindowMotion / iPad sidebar / Cap toast sonner / bulk multi-select) and host-only (Keychain/camera/IME/Pierre/WKWebView/Mode B/Share ext/ShareReceiverActivity/iOS IPA/FCM for lynx.debug/Live Activity/clipboard host). Incremental leftovers (not new product API wires): Scheduled history first-page list already 代码接上; Cap load-more/`nextCursor` + per-task filter stay thin polish. Settings search filter is wired (`filterLynxSettingsPages`). SessionsSheet/ProjectsHome row Stop is extra affordance (`abortSession` already wired from composer/goal). Active Show more beyond session-index snapshot is the same class as Scheduled history `nextCursor`. `GET /api/client-auth/connection/candidates` is post-connect lifecycle leftover, not welcome-blocking. **NO_NEW_LINUX_CLOSABLE_PRODUCT_GAP**.
- Tip / prerelease APK: `lynx-v2-debug-3becdfa` (work/lynx-native @ `3becdfa5bd66cd9ae6006e9b4c91daa46ff933c8`; PR #176 / Next #135 MERGED; release exists). Was stale `lynx-v2-debug-b7db06b` / tip `b7db06b75f9b9f37c7a598efaa03987c3a1bdd1f` (tip delta `b7db06b`→`3becdfa` is docs-only). Lynx Mobile CI SUCCESS on tip `3becdfa` (run 35473297750). Do not invent a newer APK SHA than the published tag.
- Product **NOT DONE** / 三关未齐 / not EXHAUSTED. 真机残差 unchanged: Connect welcome **card chrome** confirm still open for Yee on published APK `lynx-v2-debug-3becdfa`. No 真机过 claim. Host-only unchanged (Keychain/camera/IME/Pierre/WKWebView/Mode B/Share ext/ShareReceiverActivity/iOS IPA/FCM for lynx.debug/Live Activity/clipboard host).

## Notes — Docs tip APK/SHA honesty post-#136 (Next #137 / 2026-09-20)

- Cap phone skim (MobileApp overflow / Files / Changes incl. stageAll/unstageAll/revertAll / SessionsSheet / chat header-swipe+sync hint / MCP sheet / ProjectsHome / Assistant / Scheduled list/editor/run/delete/history / Settings / Connect welcome vs `packages/lynx`) found **no** new Linux-closable Cap product gap outside deferred thin leftovers (`@dnd-kit` / MobileWindowMotion / iPad sidebar / Cap toast sonner / bulk multi-select) and host-only (Keychain/camera/IME/Pierre/WKWebView/Mode B/Share ext/ShareReceiverActivity/iOS IPA/FCM for lynx.debug/Live Activity/clipboard host). Incremental leftovers (not new product API wires): Scheduled history first-page list already 代码接上; Cap load-more/`nextCursor` + per-task filter stay thin polish. Settings search filter is wired (`filterLynxSettingsPages`). SessionsSheet/ProjectsHome row Stop is extra affordance (`abortSession` already wired from composer/goal). Active Show more beyond session-index snapshot is the same class as Scheduled history `nextCursor`. `GET /api/client-auth/connection/candidates` is post-connect lifecycle leftover, not welcome-blocking. **NO_NEW_LINUX_CLOSABLE_PRODUCT_GAP**.
- Tip / prerelease APK: `lynx-v2-debug-165f27c` (work/lynx-native @ `165f27c8a55edf929de37de42255c859eef2d34c`; PR #177 / Next #136 MERGED; release exists). Was stale `lynx-v2-debug-3becdfa` / tip `3becdfa5bd66cd9ae6006e9b4c91daa46ff933c8` (tip delta `3becdfa`→`165f27c` is docs-only). Lynx Mobile CI SUCCESS on tip `165f27c` (run 35481508022). Do not invent a newer APK SHA than the published tag.
- Product **NOT DONE** / 三关未齐 / not EXHAUSTED. 真机残差 unchanged: Connect welcome **card chrome** confirm still open for Yee on published APK `lynx-v2-debug-165f27c`. No 真机过 claim. Host-only unchanged (Keychain/camera/IME/Pierre/WKWebView/Mode B/Share ext/ShareReceiverActivity/iOS IPA/FCM for lynx.debug/Live Activity/clipboard host).

## Notes — Docs tip APK/SHA honesty post-#137 (Next #138 / 2026-09-20)

- Cap phone skim (MobileApp overflow / Files / Changes incl. stageAll/unstageAll/revertAll / SessionsSheet / chat header-swipe+sync hint / MCP sheet / ProjectsHome / Assistant / Scheduled list/editor/run/delete/history / Settings / Connect welcome vs `packages/lynx`) found **no** new Linux-closable Cap product gap outside deferred thin leftovers (`@dnd-kit` / MobileWindowMotion / iPad sidebar / Cap toast sonner / bulk multi-select) and host-only (Keychain/camera/IME/Pierre/WKWebView/Mode B/Share ext/ShareReceiverActivity/iOS IPA/FCM for lynx.debug/Live Activity/clipboard host). Incremental leftovers (not new product API wires): Scheduled history first-page list already 代码接上; Cap load-more/`nextCursor` + per-task filter stay thin polish. Settings search filter is wired (`filterLynxSettingsPages`). SessionsSheet/ProjectsHome row Stop is extra affordance (`abortSession` already wired from composer/goal). Active Show more beyond session-index snapshot is the same class as Scheduled history `nextCursor`. `GET /api/client-auth/connection/candidates` is post-connect lifecycle leftover, not welcome-blocking. **NO_NEW_LINUX_CLOSABLE_PRODUCT_GAP**.
- Tip / prerelease APK: `lynx-v2-debug-ed50652` (work/lynx-native @ `ed506522f7bab857424af81a703520558f1fe359`; PR #178 / Next #137 MERGED; release exists). Was stale `lynx-v2-debug-165f27c` / tip `165f27c8a55edf929de37de42255c859eef2d34c` (tip delta `165f27c`→`ed50652` is docs-only). Lynx Mobile CI SUCCESS on tip `ed50652` (run 35489088418). Do not invent a newer APK SHA than the published tag.
- Product **NOT DONE** / 三关未齐 / not EXHAUSTED. 真机残差 unchanged: Connect welcome **card chrome** confirm still open for Yee on published APK `lynx-v2-debug-ed50652`. No 真机过 claim. Host-only unchanged (Keychain/camera/IME/Pierre/WKWebView/Mode B/Share ext/ShareReceiverActivity/iOS IPA/FCM for lynx.debug/Live Activity/clipboard host).

## Notes — Cap Settings search LynxInput (Next #139 / 2026-09-20)

- Cap phone Settings search is a real `<input>` (`settingsSearchQuery` + `onChange`). Lynx `SettingsSearchField` is now an editable `LynxInput` (`value` + `bindinput` → `onChange` / `setSearchQuery`, placeholder `lynx.settings.search.placeholder`) instead of display-only chrome. Filter path unchanged: `filterLynxSettingsPages` over the 22-slug catalog.
- Settings search field is 代码接上 (editable LynxInput). Still **not** 三关 landed / not 真机过. Host IME chrome polish out of scope.
- Base tip at write `42bb986425ea447b164a779d8087f271630d75a4` (PR #180 / Next #138 MERGED). Published-at-merge APK honesty was `lynx-v2-debug-ed50652` (release existed for tip `ed506522f`) — do not invent `lynx-v2-debug-42bb986` as that head's APK.
- **MERGED** as PR #181 — tip advanced to `de4ff4ea23f3446df77f8c1764e51507aabd9ce7` / published APK `lynx-v2-debug-de4ff4e` (see Next #140).
- Product **NOT DONE** / 三关未齐 / not EXHAUSTED. 真机残差 unchanged: Connect welcome **card chrome** confirm still open for Yee. No 真机过 claim. Host-only unchanged (Keychain/camera/IME/Pierre/WKWebView/Mode B/Share ext/ShareReceiverActivity/iOS IPA/@dnd-kit/MobileWindowMotion/iPad/Cap toast/bulk).

## Notes — Docs tip APK/SHA honesty post-#139 (Next #140 / 2026-09-20)

- Cap skim pending / **NO_NEW** expected from prior skim + Settings search gap closed in #139. Settings search LynxInput stays 代码接上 (Next #139), not 三关 landed / not 真机过.
- Tip / prerelease APK: `lynx-v2-debug-de4ff4e` (work/lynx-native @ `de4ff4ea23f3446df77f8c1764e51507aabd9ce7`; PR #181 / Next #139 MERGED; release exists). Was stale `lynx-v2-debug-ed50652` / tip bases `ed506522f7bab857424af81a703520558f1fe359` / Next #139 base `42bb986425ea447b164a779d8087f271630d75a4` / published-at-merge APK for #139 head. Tip delta `42bb986`→`de4ff4ea23` includes product Settings search LynxInput (Next #139). Lynx Mobile CI SUCCESS on tip `de4ff4e` (run 35497211638). Do not invent a newer APK SHA than the published tag.
- **MERGED** as PR #182 — tip advanced to `fa087e5bccd27bad126a5aedfab4255ce4553f75` / published APK `lynx-v2-debug-fa087e5` (see Next #141).
- Product **NOT DONE** / 三关未齐 / not EXHAUSTED. 真机残差 unchanged: Connect welcome **card chrome** confirm still open for Yee. No 真机过 claim. Host-only unchanged (Keychain/camera/IME/Pierre/WKWebView/Mode B/Share ext/ShareReceiverActivity/iOS IPA/FCM for lynx.debug/Live Activity/clipboard host).

## Notes — Docs tip APK/SHA honesty post-#140 (Next #141 / 2026-09-20)

- Cap skim pending / **NO_NEW** expected from prior skim + Settings search gap closed in #139. Settings search LynxInput stays 代码接上 (Next #139), not 三关 landed / not 真机过.
- Tip / prerelease APK: `lynx-v2-debug-fa087e5` (work/lynx-native @ `fa087e5bccd27bad126a5aedfab4255ce4553f75`; PR #182 / Next #140 MERGED; release exists). Was stale `lynx-v2-debug-de4ff4e` / tip `de4ff4ea23f3446df77f8c1764e51507aabd9ce7`. Tip delta `de4ff4e`→`fa087e5` is docs-only. Lynx Mobile CI SUCCESS on tip `fa087e5` (run 35505471290). Do not invent a newer APK SHA than the published tag.
- **MERGED** as PR #183 — tip advanced to `5f98d1c5427a064f60cddf743e88ba6ad454f1da` / published APK `lynx-v2-debug-5f98d1c` (see Next #142).
- Product **NOT DONE** / 三关未齐 / not EXHAUSTED. 真机残差 unchanged: Connect welcome **card chrome** confirm still open for Yee. No 真机过 claim. Host-only unchanged (Keychain/camera/IME/Pierre/WKWebView/Mode B/Share ext/ShareReceiverActivity/iOS IPA/FCM for lynx.debug/Live Activity/clipboard host).

## Notes — Docs tip APK/SHA honesty post-#141 (Next #142 / 2026-09-21)

- Cap skim pending / **NO_NEW** expected from prior skim + Settings search gap closed in #139. Settings search LynxInput stays 代码接上 (Next #139), not 三关 landed / not 真机过.
- Tip / prerelease APK: `lynx-v2-debug-5f98d1c` (work/lynx-native @ `5f98d1c5427a064f60cddf743e88ba6ad454f1da`; PR #183 / Next #141 MERGED; release exists). Was stale `lynx-v2-debug-fa087e5` / tip `fa087e5bccd27bad126a5aedfab4255ce4553f75`. Tip delta `fa087e5`→`5f98d1c` is docs-only. Lynx Mobile CI SUCCESS on tip `5f98d1c` (run 35513768378). Do not invent a newer APK SHA than the published tag.
- **MERGED** as PR #184 — tip advanced to `9fc7723e6ea4deb1895d1f3736a5ff63528cbb9e` / published APK `lynx-v2-debug-9fc7723` (see Next #143).
- Product **NOT DONE** / 三关未齐 / not EXHAUSTED. 真机残差 unchanged: Connect welcome **card chrome** confirm still open for Yee. No 真机过 claim. Host-only unchanged (Keychain/camera/IME/Pierre/WKWebView/Mode B/Share ext/ShareReceiverActivity/iOS IPA/FCM for lynx.debug/Live Activity/clipboard host).

## Notes — Docs tip APK/SHA honesty post-#142 (Next #143 / 2026-09-21)

- Cap skim pending / **NO_NEW** expected from prior skim + Settings search gap closed in #139. Settings search LynxInput stays 代码接上 (Next #139), not 三关 landed / not 真机过.
- Tip / prerelease APK: `lynx-v2-debug-9fc7723` (work/lynx-native @ `9fc7723e6ea4deb1895d1f3736a5ff63528cbb9e`; PR #184 / Next #142 MERGED; release exists). Was stale `lynx-v2-debug-5f98d1c` / tip `5f98d1c5427a064f60cddf743e88ba6ad454f1da`. Tip delta `5f98d1c`→`9fc7723` is docs-only. Lynx Mobile CI SUCCESS on tip `9fc7723` (run 35523180671). Do not invent a newer APK SHA than the published tag.
- **MERGED** as PR #185 — tip advanced to `84107429dc9cd9e98d9de82807aa509d2bf8a496` / published APK `lynx-v2-debug-8410742` (see Next #144).
- Product **NOT DONE** / 三关未齐 / not EXHAUSTED. 真机残差 unchanged: Connect welcome **card chrome** confirm still open for Yee. No 真机过 claim. Host-only unchanged (Keychain/camera/IME/Pierre/WKWebView/Mode B/Share ext/ShareReceiverActivity/iOS IPA/FCM for lynx.debug/Live Activity/clipboard host).

## Notes — Docs tip APK/SHA honesty post-#143 (Next #144 / 2026-09-21)

- Cap skim pending / **NO_NEW** expected from prior skim + Settings search gap closed in #139. Settings search LynxInput stays 代码接上 (Next #139), not 三关 landed / not 真机过.
- Tip / prerelease APK: `lynx-v2-debug-8410742` (work/lynx-native @ `84107429dc9cd9e98d9de82807aa509d2bf8a496`; PR #185 / Next #143 MERGED; release exists). Was stale `lynx-v2-debug-9fc7723` / tip `9fc7723e6ea4deb1895d1f3736a5ff63528cbb9e`. Tip delta `9fc7723`→`8410742` is docs-only. Lynx Mobile CI SUCCESS on tip `8410742` (run 35532791147). Do not invent a newer APK SHA than the published tag.
- **MERGED** as PR #186 — tip advanced to `c3cb78a79bf80d0a90d448bb7133adc5869084d6` / published APK `lynx-v2-debug-c3cb78a` (see Next #145).
- Product **NOT DONE** / 三关未齐 / not EXHAUSTED. 真机残差 unchanged: Connect welcome **card chrome** confirm still open for Yee. No 真机过 claim. Host-only unchanged (Keychain/camera/IME/Pierre/WKWebView/Mode B/Share ext/ShareReceiverActivity/iOS IPA/FCM for lynx.debug/Live Activity/clipboard host).

## Notes — Docs tip APK/SHA honesty post-#144 (Next #145 / 2026-09-21)

- Cap skim pending / **NO_NEW** expected from prior skim + Settings search gap closed in #139. Settings search LynxInput stays 代码接上 (Next #139), not 三关 landed / not 真机过.
- Tip / prerelease APK: `lynx-v2-debug-c3cb78a` (work/lynx-native @ `c3cb78a79bf80d0a90d448bb7133adc5869084d6`; PR #186 / Next #144 MERGED; release exists). Was stale `lynx-v2-debug-8410742` / tip `84107429dc9cd9e98d9de82807aa509d2bf8a496`. Tip delta `8410742`→`c3cb78a` is docs-only. Lynx Mobile CI SUCCESS on tip `c3cb78a` (run 35542179230). Do not invent a newer APK SHA than the published tag.
- **MERGED** as PR #187 — tip advanced to `7227ddcafad8fa9b85c3d550b1bcd3eacf9806f5` / published APK `lynx-v2-debug-7227ddc` (see Next #146).
- Product **NOT DONE** / 三关未齐 / not EXHAUSTED. 真机残差 unchanged: Connect welcome **card chrome** confirm still open for Yee. No 真机过 claim. Host-only unchanged (Keychain/camera/IME/Pierre/WKWebView/Mode B/Share ext/ShareReceiverActivity/iOS IPA/FCM for lynx.debug/Live Activity/clipboard host).

## Notes — Docs tip APK/SHA honesty post-#145 (Next #146 / 2026-09-21)

- Cap skim pending / **NO_NEW** expected from prior skim + Settings search gap closed in #139. Settings search LynxInput stays 代码接上 (Next #139), not 三关 landed / not 真机过.
- Tip / prerelease APK: `lynx-v2-debug-7227ddc` (work/lynx-native @ `7227ddcafad8fa9b85c3d550b1bcd3eacf9806f5`; PR #187 / Next #145 MERGED; release exists). Was stale `lynx-v2-debug-c3cb78a` / tip `c3cb78a79bf80d0a90d448bb7133adc5869084d6`. Tip delta `c3cb78a`→`7227ddc` is docs-only. Lynx Mobile CI SUCCESS on tip `7227ddc` (run 35551435386). Do not invent a newer APK SHA than the published tag.
- **MERGED** as PR #188 — tip advanced to `6b78c3d41a54ad1e39c7b2ca503db8df7fd4e54d` / published APK `lynx-v2-debug-6b78c3d` (see Next #147).
- Product **NOT DONE** / 三关未齐 / not EXHAUSTED. 真机残差 unchanged: Connect welcome **card chrome** confirm still open for Yee. No 真机过 claim. Host-only unchanged (Keychain/camera/IME/Pierre/WKWebView/Mode B/Share ext/ShareReceiverActivity/iOS IPA/FCM for lynx.debug/Live Activity/clipboard host).

## Notes — Docs tip APK/SHA honesty post-#146 (Next #147 / 2026-09-21)

- Cap skim pending / **NO_NEW** expected from prior skim + Settings search gap closed in #139. Settings search LynxInput stays 代码接上 (Next #139), not 三关 landed / not 真机过.
- Tip / prerelease APK: `lynx-v2-debug-6b78c3d` (work/lynx-native @ `6b78c3d41a54ad1e39c7b2ca503db8df7fd4e54d`; PR #188 / Next #146 MERGED; release exists). Was stale `lynx-v2-debug-7227ddc` / tip `7227ddcafad8fa9b85c3d550b1bcd3eacf9806f5`. Tip delta `7227ddc`→`6b78c3d` is docs-only. Lynx Mobile CI SUCCESS on tip `6b78c3d` (run 35561042584). Do not invent a newer APK SHA than the published tag.
- **MERGED** as PR #189 — tip advanced to `a46ac25c3fe489f5727362912740a4622976414c` / published APK `lynx-v2-debug-a46ac25` (see Next #148).
- Product **NOT DONE** / 三关未齐 / not EXHAUSTED. 真机残差 unchanged: Connect welcome **card chrome** confirm still open for Yee. No 真机过 claim. Host-only unchanged (Keychain/camera/IME/Pierre/WKWebView/Mode B/Share ext/ShareReceiverActivity/iOS IPA/FCM for lynx.debug/Live Activity/clipboard host).

## Notes — Docs tip APK/SHA honesty post-#147 (Next #148 / 2026-09-21)

- Cap skim pending / **NO_NEW** expected from prior skim + Settings search gap closed in #139. Settings search LynxInput stays 代码接上 (Next #139), not 三关 landed / not 真机过.
- Tip / prerelease APK: `lynx-v2-debug-a46ac25` (work/lynx-native @ `a46ac25c3fe489f5727362912740a4622976414c`; PR #189 / Next #147 MERGED; release exists). Was stale `lynx-v2-debug-6b78c3d` / tip `6b78c3d41a54ad1e39c7b2ca503db8df7fd4e54d`. Tip delta `6b78c3d`→`a46ac25` is docs-only. Lynx Mobile CI SUCCESS on tip `a46ac25` (run 35574289217). Do not invent a newer APK SHA than the published tag.
- **MERGED** as PR #190 — tip advanced to `38b31757b7460ab6781edb71acc9e933fab30e0c` / published APK `lynx-v2-debug-38b3175` (see Next #149).
- Product **NOT DONE** / 三关未齐 / not EXHAUSTED. 真机残差 unchanged: Connect welcome **card chrome** confirm still open for Yee on published APK `lynx-v2-debug-a46ac25`. No 真机过 claim. Host-only unchanged (Keychain/camera/IME/Pierre/WKWebView/Mode B/Share ext/ShareReceiverActivity/iOS IPA/FCM for lynx.debug/Live Activity/clipboard host).

## Notes — Docs tip APK/SHA honesty post-#148 (Next #149 / 2026-09-21)

- Cap skim pending / **NO_NEW** expected from prior skim + Settings search gap closed in #139. Settings search LynxInput stays 代码接上 (Next #139), not 三关 landed / not 真机过.
- Tip / prerelease APK: `lynx-v2-debug-38b3175` (work/lynx-native @ `38b31757b7460ab6781edb71acc9e933fab30e0c`; PR #190 / Next #148 MERGED; release exists). Was stale `lynx-v2-debug-a46ac25` / tip `a46ac25c3fe489f5727362912740a4622976414c`. Tip delta `a46ac25`→`38b3175` is docs-only. Lynx Mobile CI SUCCESS on tip `38b3175` (run 35588189358). Do not invent a newer APK SHA than the published tag.
- **MERGED** as PR #191 — tip advanced to `daca88c832f3df0d1a59bf5ca3eaa828f1885656` / published APK `lynx-v2-debug-daca88c` (see Next #150).
- Product **NOT DONE** / 三关未齐 / not EXHAUSTED. 真机残差 unchanged: Connect welcome **card chrome** confirm still open for Yee on published APK `lynx-v2-debug-38b3175`. No 真机过 claim. Host-only unchanged (Keychain/camera/IME/Pierre/WKWebView/Mode B/Share ext/ShareReceiverActivity/iOS IPA/FCM for lynx.debug/Live Activity/clipboard host).

## Notes — Docs tip APK/SHA honesty post-#149 (Next #150 / 2026-09-21)

- Cap skim pending / **NO_NEW** expected from prior skim + Settings search gap closed in #139. Settings search LynxInput stays 代码接上 (Next #139), not 三关 landed / not 真机过.
- Tip / prerelease APK: `lynx-v2-debug-daca88c` (work/lynx-native @ `daca88c832f3df0d1a59bf5ca3eaa828f1885656`; PR #191 / Next #149 MERGED; release exists). Was stale `lynx-v2-debug-38b3175` / tip `38b31757b7460ab6781edb71acc9e933fab30e0c`. Tip delta `38b3175`→`daca88c` is docs-only. Lynx Mobile CI SUCCESS on tip `daca88c` (run 35589404227). Do not invent a newer APK SHA than the published tag.
- **MERGED** as PR #192 — tip advanced to `dcb67d6075b670ce24fb6efcf19384ae8adbc07e` / published APK `lynx-v2-debug-dcb67d6` (see Next #151).
- Product **NOT DONE** / 三关未齐 / not EXHAUSTED. 真机残差 unchanged: Connect welcome **card chrome** confirm still open for Yee on published APK `lynx-v2-debug-daca88c`. No 真机过 claim. Host-only unchanged (Keychain/camera/IME/Pierre/WKWebView/Mode B/Share ext/ShareReceiverActivity/iOS IPA/FCM for lynx.debug/Live Activity/clipboard host).

## Notes — Docs tip APK/SHA honesty post-#150 (Next #151 / 2026-09-21)

- Cap skim pending / **NO_NEW** expected from prior skim + Settings search gap closed in #139. Settings search LynxInput stays 代码接上 (Next #139), not 三关 landed / not 真机过.
- Tip / prerelease APK: `lynx-v2-debug-dcb67d6` (work/lynx-native @ `dcb67d6075b670ce24fb6efcf19384ae8adbc07e`; PR #192 / Next #150 MERGED; release exists; asset `openchamber-lynx-debug-dcb67d6.apk`). Was stale `lynx-v2-debug-daca88c` / tip `daca88c832f3df0d1a59bf5ca3eaa828f1885656`. Tip delta `daca88c`→`dcb67d6` is docs-only. Lynx Mobile CI SUCCESS on tip `dcb67d6` (run 35610772314). Do not invent a newer APK SHA than the published tag.
- **MERGED** as PR #193 — tip advanced to `309af29373d68d7d4ea3757af9adf4896946490f` / published APK `lynx-v2-debug-309af29` (see Next #152).
- Product **NOT DONE** / 三关未齐 / not EXHAUSTED. 真机残差 unchanged: Connect welcome **card chrome** confirm still open for Yee on published APK `lynx-v2-debug-dcb67d6`. No 真机过 claim. Host-only unchanged (Keychain/camera/IME/Pierre/WKWebView/Mode B/Share ext/ShareReceiverActivity/iOS IPA/FCM for lynx.debug/Live Activity/clipboard host).

## Notes — Docs tip APK/SHA honesty post-#151 (Next #152 / 2026-09-21)

- Cap skim pending / **NO_NEW** expected from prior skim + Settings search gap closed in #139. Settings search LynxInput stays 代码接上 (Next #139), not 三关 landed / not 真机过.
- Tip / prerelease APK: `lynx-v2-debug-309af29` (work/lynx-native @ `309af29373d68d7d4ea3757af9adf4896946490f`; PR #193 / Next #151 MERGED; release exists; asset `openchamber-lynx-debug-309af29.apk`). Was stale `lynx-v2-debug-dcb67d6` / tip `dcb67d6075b670ce24fb6efcf19384ae8adbc07e`. Tip delta `dcb67d6`→`309af29` is docs-only. Lynx Mobile CI SUCCESS on tip `309af29` (run 35629501281). Do not invent a newer APK SHA than the published tag.
- **MERGED** as PR #194 — tip advanced to `c3a062a134a9796041ea605eb2e1acc66a2b289d` / published APK `lynx-v2-debug-c3a062a` (see Next #153).
- Product **NOT DONE** / 三关未齐 / not EXHAUSTED. 真机残差 unchanged: Connect welcome **card chrome** confirm still open for Yee on published APK `lynx-v2-debug-309af29`. No 真机过 claim. Host-only unchanged (Keychain/camera/IME/Pierre/WKWebView/Mode B/Share ext/ShareReceiverActivity/iOS IPA/FCM for lynx.debug/Live Activity/clipboard host).

## Notes — Docs tip APK/SHA honesty post-#152 (Next #153 / 2026-09-21)

- Cap skim pending / **NO_NEW** expected from prior skim + docs-only tip delta. Settings search LynxInput stays 代码接上 (Next #139), not 三关 landed / not 真机过. Incremental leftovers unchanged: Scheduled history first page 代码接上; session-row badges / Files image/markdown polish/host; deferred `@dnd-kit` / MobileWindowMotion / iPad / Cap toast / bulk.
- Tip / prerelease APK: `lynx-v2-debug-c3a062a` (work/lynx-native @ `c3a062a134a9796041ea605eb2e1acc66a2b289d`; PR #194 / Next #152 MERGED; release exists; asset `openchamber-lynx-debug-c3a062a.apk`). Was stale `lynx-v2-debug-309af29` / tip `309af29373d68d7d4ea3757af9adf4896946490f`. Tip delta `309af29`→`c3a062a` is docs-only. Lynx Mobile CI SUCCESS on tip `c3a062a` (run 35646713115). Do not invent a newer APK SHA than the published tag.
- **MERGED** as PR #195 — tip advanced to `8ef7bf6f6493783aef2845c2238fc91c9e438af3` / published APK `lynx-v2-debug-8ef7bf6` (see Next #154).
- Product **NOT DONE** / 三关未齐 / not EXHAUSTED. 真机残差 unchanged: Connect welcome **card chrome** confirm still open for Yee on published APK `lynx-v2-debug-c3a062a`. No 真机过 claim. Host-only unchanged (Keychain/camera/IME/Pierre/WKWebView/Mode B/Share ext/ShareReceiverActivity/iOS IPA/FCM for lynx.debug/Live Activity/clipboard host).

## Notes — Docs tip APK/SHA honesty post-#153 (Next #154 / 2026-09-22)

- Cap skim pending / **NO_NEW** expected from prior skim + docs-only tip delta. Settings search LynxInput stays 代码接上 (Next #139), not 三关 landed / not 真机过. Incremental leftovers unchanged: Scheduled history first page 代码接上; session-row badges / Files image/markdown polish/host; deferred `@dnd-kit` / MobileWindowMotion / iPad / Cap toast / bulk.
- Tip / prerelease APK: `lynx-v2-debug-8ef7bf6` (work/lynx-native @ `8ef7bf6f6493783aef2845c2238fc91c9e438af3`; PR #195 / Next #153 MERGED; release exists; asset `openchamber-lynx-debug-8ef7bf6.apk`). Was stale `lynx-v2-debug-c3a062a` / tip `c3a062a134a9796041ea605eb2e1acc66a2b289d`. Tip delta `c3a062a`→`8ef7bf6` is docs-only. Lynx Mobile CI SUCCESS on tip `8ef7bf6` (run 35663903430). Do not invent a newer APK SHA than the published tag.
- **MERGED** as PR #196 — tip advanced to `aca0d600069f792d86bd56fe937ef7442870a7f1` / published APK `lynx-v2-debug-aca0d60` (see Next #155).
- Product **NOT DONE** / 三关未齐 / not EXHAUSTED. 真机残差 unchanged: Connect welcome **card chrome** confirm still open for Yee on published APK `lynx-v2-debug-8ef7bf6`. No 真机过 claim. Host-only unchanged (Keychain/camera/IME/Pierre/WKWebView/Mode B/Share ext/ShareReceiverActivity/iOS IPA/FCM for lynx.debug/Live Activity/clipboard host).

## Notes — Docs tip APK/SHA honesty post-#154 (Next #155 / 2026-09-22)

- Cap skim pending / **NO_NEW** expected from prior skim + docs-only tip delta. Settings search LynxInput stays 代码接上 (Next #139), not 三关 landed / not 真机过. Incremental leftovers unchanged: Scheduled history first page 代码接上; session-row badges / Files image/markdown polish/host; deferred `@dnd-kit` / MobileWindowMotion / iPad / Cap toast / bulk.
- Tip / prerelease APK: `lynx-v2-debug-aca0d60` (work/lynx-native @ `aca0d600069f792d86bd56fe937ef7442870a7f1`; PR #196 / Next #154 MERGED; release exists; asset `openchamber-lynx-debug-aca0d60.apk`; published ~2026-09-22T01:42:45Z). Was stale `lynx-v2-debug-8ef7bf6` / tip `8ef7bf6f6493783aef2845c2238fc91c9e438af3`. Tip delta `8ef7bf6`→`aca0d60` is docs-only. Lynx Mobile CI SUCCESS on tip `aca0d60` (run 35676395290). Do not invent a newer APK SHA than the published tag.
- Product **NOT DONE** / 三关未齐 / not EXHAUSTED. 真机残差 unchanged: Connect welcome **card chrome** confirm still open for Yee on published APK `lynx-v2-debug-aca0d60`. No 真机过 claim. Host-only unchanged (Keychain/camera/IME/Pierre/WKWebView/Mode B/Share ext/ShareReceiverActivity/iOS IPA/FCM for lynx.debug/Live Activity/clipboard host).
