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
