# Lynx mobile rewrite — gap board

Independent track: **`work/lynx-native`** from `main` @ `b444b0316` (`v1.19.7-beta.7`). Do **not** merge to `main`.

Lynx app skeleton **does not exist**. This board is seeded honestly from `docs/lynx-feature-inventory.md`: almost every product row starts in **missing**. Update a row only when code, CI, and (for ship) 真机 evidence exist. Status words:

| Status | Meaning |
|---|---|
| **landed** | On `work/lynx-native`, wired to real APIs, and at least CI-green for the claimed surface |
| **missing** | Not implemented (default) |
| **Android降级** | iOS has (or will have) a richer native treatment; Android ships a documented lesser analogue — not a broken iOS clone |
| **next** | Immediate implementation slice after the doc gate |
| **真机残差** | Code+CI exist; physical device still fails or is unproven |
| **故意不移植** | Cap/web has it, Lynx will not (with a reason) |

---

## Landed

| Item | Notes |
|---|---|
| Branch `work/lynx-native` from `b444b0316` | Docs gate |
| This documentation set | `docs/lynx-feature-inventory.md`, `docs/lynx-pitfalls.md`, `docs/lynx-gap-board.md`, `docs/lynx-acceptance.md`, `docs/lynx-ia-ui.md` |

## Scaffold (shell / host / glass — not 真机过)

These rows are **代码接上** for the scaffold contracts only (no OpenChamber HTTP). Package Vitest + `tsc` are the CI for this claim. They are **not** shipped.

| Item | Notes |
|---|---|
| Lynx app package | `packages/lynx` (`@openchamber/lynx`). Workspace Vitest project. No rspeedy/APK/IPA job yet. |
| Host Tab/Nav embedding decision | **Locked:** Mode B iOS 26 host `UITabBar`; Mode A older iOS + Android. Mode C forbidden. `src/host/embedding.ts` + `host/ios/` + `host/android/`. |
| Four-tab dock IA | Projects / Assistant / Scheduled / Settings. Chat is a pushed secondary page; dock hidden. Settings home lists real slug rows. Projects/Assistant/Scheduled tab **bodies** are 代码接上 in the tabs-home slice (see below). |
| Lynx 3.8 glass mapping | iOS `glass` → `UIGlassEffect`, `glass-container` → `UIGlassContainerEffect`, plus `glass-style` / `glass-interactive` / `glass-tint-color` / `spacing`. Android: `blur-radius` 降级. |

真机过: **not executed** (environment: Linux cloud agent; no Xcode/adb device).


## 代码接上 (connect client — not landed under 三关)

Client library modules under `packages/lynx` (`src/connection/`, `src/pairing/`, `src/session-index/`, `src/deep-links/`). No host LynxView splash UI, no track CI.

| Item | Cap/web source | Lynx note |
|---|---|---|
| Pairing v2 parse + paste/QR payload | `connectionPayload.ts`, `mobileQrScan.ts` | v1 rejected. Camera scan is host-owned. No Nearby / Bonjour. |
| `openchamber://` parse + build | `deepLinks.ts` | Same intent union. Apply/navigation is still host. |
| Connect / auto-connect / password / redeem | `mobileConnections.ts` | Real `GET /health`, `GET|POST /auth/session`, `POST /api/client-auth/pairing/redeem`. Persists full LAN+relay candidate set. Token in injected secure store — never logged, never in metadata. |
| Connect race harness | `mobileConnections.ts` | Unit: relay-only skips the 1.5s LAN headstart (`src/connection/probe.test.ts`). |
| Session-index GET / pin / lookup | `session-index-api.ts` | `GET /api/openchamber/session-index`. Failure ≠ empty. Runtime-key cache. |
| Projects home data path | `useMobileProjectsHomeModel.ts` | `projectSessionIndexHome` + `createSessionIndexHomeBindings`. No pixel polish. |

**CI绿:** missing (no Lynx Android/iOS workflow yet). Local Vitest `@openchamber/lynx` is not track CI.

**真机过:** not executed (environment: Linux cloud VM; no Xcode, no adb, no physical device).

---

## 代码接上 (chat LegendList + settings home — not landed under 三关)

Chat timeline + Settings tab home on `cursor/lynx-chat-settings-local` (PR into `work/lynx-native`). Package Vitest + `tsc` gate the claim. No track CI / 真机过.

| Item | Cap/web source | Lynx note |
|---|---|---|
| LegendList-semantics timeline | `TimelineList.tsx` | `src/chat/listSemantics.ts` + `LynxTimelineList`: one `<list>`, `recycle-items={false}`, `initialScrollAtEnd` / `maintainScrollAtEnd` / `maintainVisibleContentPosition`, load-older **button** only (bounce forbidden). TanStack 1.18 forbidden. |
| Send / Stop / queue hooks | ChatInput + queue | `src/chat/composerActions.ts` + `sessionApi.ts` → official `POST /session/:id/prompt_async`, `POST /session/:id/abort`, `GET /session/:id/message`. No runtime → explicit `no-runtime` failure (never fake-success). |
| Chat pushed page chrome | `MobileChatScreen.tsx` | `LynxChatScreen` header + timeline + composer actions. Markdown cards / Files / Changes / MCP sheets / IME FLIP **not** in this slice. |
| Settings search + 21 slug rows | `MOBILE_SETTINGS_PAGE_SLUGS`, `SettingsView` | `src/settings/metadata.ts` + `SettingsTab`: search, Cap group order, all 21 rows, in-tab push. Bodies are **labeled stubs**; `voice` is list-only-until-routes. No `iosNativeUi` toggle. |

**CI绿:** missing (no Lynx Android/iOS workflow). Local Vitest `@openchamber/lynx` only.
**真机过:** not executed.

---


## 代码接上 (Projects / Assistant / Scheduled tabs — not landed under 三关)

Tab bodies on `cursor/lynx-tabs-home-local` (PR into `work/lynx-native`). Package Vitest + `tsc` gate the claim. No track CI / 真机过.

| Item | Cap/web source | Lynx note |
|---|---|---|
| Projects home UI | `MobileProjectsHome.tsx`, `useMobileProjectsHomeModel.ts` | `ProjectsHome` wired to `createSessionIndexHomeBindings` / `projectSessionIndexHome`: project cards, worktree groups, session rows, search, pin/in-progress cues, `项目 · 分支` subtitle, collapsing-title header spirit, draft→push Chat. **failure ≠ empty**. |
| Assistant catalog + conversation chrome | `MobileAssistantTab.tsx`, assistants snapshot | `assistants/*` → `GET /api/openchamber/assistants/snapshot` (+ ensure-session hook). Catalog tab; open conversation reuses `LynxChatScreen`. No invented ASR. Missing session → labeled stub (not fake chat id). |
| Scheduled list / history / editor hooks | `scheduledTasksApi.ts`, `MobileScheduledTab` | `scheduled/*` → `GET /api/openchamber/scheduled-tasks`, runs history, upsert PUT hook. Editor chrome is a **labeled stub**. Partial `failedProjectIds` preserved; no-runtime / HTTP failure ≠ empty success. |

**CI绿:** missing (no Lynx Android/iOS workflow). Local Vitest `@openchamber/lynx` only.
**真机过:** not executed.

---

## 代码接上 (settings bodies + connect welcome + Projects header + CI skeleton — not landed under 三关)

Slice on `cursor/lynx-settings-ci-local` (PR into `work/lynx-native`). Package Vitest + `tsc` + rspeedy build via `packages/lynx/ci/lynx-ci.yml` → install as `.github/workflows/lynx-ci.yml` (needs `workflow` token scope) (Linux). APK/iOS sim jobs need Mac/Android runners — **not claimed**. 真机过: not executed.

| Item | Cap/web source | Lynx note |
|---|---|---|
| Settings page bodies (21 slugs) | SettingsView + settings blob + catalogs | Wired GET/PUT: instances, appearance (flexoki ids), chat, notifications hooks, sessions, gitmoji, about (Lynx version ≠ instance). List endpoints: providers/agents/mcp/plugins/skills/commands/magic-prompts/snippets/usage/assistants/projects. Editors labeled stubs (no fake-success). Voice list-only-until-routes. No iosNativeUi. |
| Connect welcome / instances UI | MobileApp welcome + MobileInstancesSurface | Splash while auto-connect; instance list add/delete/password unlock; paste pairing link. QR camera labeled stub (host-owned). No Bonjour. |
| Projects MobileTabPageHeader | `MobileTabPageHeader.tsx` | Sticky translucent collapsing title + trailing glass search chip + primary +. Collapse math in `tabPageHeader.ts`. iOS glass via GlassChrome; Android blur-radius only. |
| CI skeleton | — | `packages/lynx/ci/lynx-ci.yml` → install as `.github/workflows/lynx-ci.yml` (needs `workflow` token scope) on PR → `work/lynx-native`: type-check + vitest + rspeedy. Documented that APK/iOS sim need Mac/Android runners. |

**CI绿:** Linux lynx-ci skeleton only — not full APK/iOS. Not 真机过.
**真机过:** not executed (environment: Linux cloud VM).

---
## 代码接上 (gap-close: summary-ai/behavior, scheduled editor, assistant ensure, chat sheets — not landed under 三关)

Slice on `cursor/lynx-gap-close-local` (PR into `work/lynx-native`). Package Vitest + `tsc` + rspeedy. CI workflow remains template at `packages/lynx/ci/lynx-ci.yml` (copy to `.github/workflows` when `workflow` scope available) — **not claimed live**. 真机过: not executed.

| Item | Cap/web source | Lynx note |
|---|---|---|
| Settings `summary-ai` body | `SummarySettings.tsx`, `/api/config/settings`, `/api/small-model` | Wired GET/PUT settings blob fields + callableModels. Failure / empty capabilities ≠ silent empty success. |
| Settings `behavior` body | `BehaviorPage.tsx`, `/api/behavior/agents-md`, response-style settings | Wired agents.md GET/PUT + responseStyleEnabled/Preset/Custom via settings blob. Failure ≠ empty. |
| Scheduled editor UI | `ScheduledTaskEditorDialog`, PUT upsert | Real editor chrome (name/enabled/schedule/prompt/provider/model) calling `upsertScheduledTask`. Create needs project id from settings projects. Never fake-success. |
| Assistant unbound ensure | `ensureAssistantSession`, `AssistantView` | Shell calls Cap `POST …/session/ensure` when runtime present; null sessionID stays unbound labeled (no invented chat id). |
| Chat overflow + Files/Changes stubs | MobileApp overflow, Files/Changes sheets | Overflow menu hooks; Files/Changes navigate to labeled stub sheets with correct back. Bodies not ported. |

**CI绿:** Linux lynx-ci template only (not installed under `.github/workflows` without workflow scope). Local Vitest `@openchamber/lynx` only.
**真机过:** not executed.

---

## 代码接上 (editors + Files/Changes/MCP sheets + deep-link apply — not landed under 三关)

Slice on `cursor/lynx-editors-sheets-local` (PR into `work/lynx-native`). Package Vitest + `tsc` + rspeedy. CI workflow remains template at `packages/lynx/ci/lynx-ci.yml` — **not claimed live**. 真机过: not executed.

| Item | Cap/web source | Lynx note |
|---|---|---|
| Settings entity editors (list-backed) | SettingsView split → entity CRUD stores | Detail push + save/delete for providers (auth delete only; save unsupported), agents, assistants, mcp, plugins, commands, snippets, magic-prompts, skills.installed, projects. Real Cap routes; failure ≠ empty / fake-success. |
| Chat Files sheet | `MobileFilesSurface` → `/api/fs/list` | Real directory listing; no-directory / HTTP failure labeled. Preview/HTML iframe not ported. |
| Chat Changes sheet | `MobileChangesSurface` → `/api/git/status` | Real status list (branch + staged/unstaged/untracked). Diff viewer / commit / sync not ported. |
| Chat MCP sheet | mobile MCP surface / `/api/config/mcp` | Overflow entry + catalog list. |
| `openchamber://` apply | `deepLinkNavigation.ts` | Parse already existed; apply maps intents → shell navigation (session/draft/tab/settings/sheets/instances). Stash until connect ready + handlers. |

**CI绿:** Linux lynx-ci template only. Local Vitest `@openchamber/lynx` only.
**真机过:** not executed.

---

## 代码接上 (diff/preview + commit/sync + provider auth + push/share hooks — not landed under 三关)

Slice on `cursor/lynx-diff-push-share-local` (PR into `work/lynx-native`). Package Vitest + `tsc` + rspeedy. CI workflow remains template at `packages/lynx/ci/lynx-ci.yml` — **not claimed live**. 真机过: not executed.

| Item | Cap/web source | Lynx note |
|---|---|---|
| Changes turn/file diff | `MobileChangesSurface` → `/api/git/file-diff`, `/api/git/diff` | Tap file → preview unified/original+modified. Binary labeled. |
| Changes commit / sync | `CommitSection`, `SyncActions` → `POST /api/git/commit\|fetch\|pull\|push` | **Real** Cap endpoints (not stubs). Failure ≠ fake-success. |
| Files text preview | `MobileFilesSurface` / FilesView → `/api/fs/read` | List stays real; tap file → text preview (truncated). HTML iframe not ported. |
| Provider auth UI | `ProvidersPage` auth | API key `PUT /api/auth/:id`; OAuth authorize/callback Cap routes; **host-only** browser open documented (no invented OAuth/Capgo). Clear-auth delete unchanged. |
| Push registration hooks | `useNativePushRegistration` → `/api/push/apns-token` | Host injects APNs/FCM tokens; Lynx stores + registers/unregisters. FCM `applicationId` must be `com.yee94.openchamber[.debug]` (pitfalls §6). |
| Share inbox intake | `MobileShareBridge` → assistants `/share` | Accept host share envelope / openchamber share intents; dispatch to Assistant session. No Capgo. |

**CI绿:** Linux lynx-ci template only. Local Vitest `@openchamber/lynx` only.
**真机过:** not executed.

---

## 代码接上 (rich turn cards + swipe menu + share welcome + draft + list harness — not landed under 三关)

Slice on `cursor/lynx-cards-swipe-harness-local` (PR into `work/lynx-native`). Package Vitest + `tsc` + rspeedy. CI workflow remains template at `packages/lynx/ci/lynx-ci.yml` — **not claimed live**. 真机过: not executed.

| Item | Cap/web source | Lynx note |
|---|---|---|
| Chat rich turn cards | message parts, ProgressiveGroup, QuestionCard, PermissionCard | Wire Cap part types (`text`/`reasoning`/`tool`/`file`/`agent`); Activity collapsed/expanded; pending `/question`+`/permission` reply. No invented types. |
| Projects swipe / long-press | `sessionMenuModel.ts` | Long-press sheet: pin (session-index), archive/delete (`PATCH`/`DELETE /session/:id`). Share/rename gated when callbacks exist. |
| Share welcome chrome | `AssistantShareWelcome` | Education cards + Cap storage key on Assistant tab above share inbox. |
| Draft composer body | mobile `kind: 'draft'` | `LynxDraftComposer` materializes `POST /session` → `prompt_async` then opens chat. |
| List perf harness | Cap `streamingRenderCadence.ts` + acceptance harness | Unit harness measures synthetic scroll/update cadence + prepend anchor; documents Cap 20/64 & Android 100/128 — **no fake device numbers**. |

**CI绿:** Linux lynx-ci template only. Local Vitest `@openchamber/lynx` only.
**真机过:** not executed.

---

## 代码接上 (SSE live tail + IME contract + nested chat stack — not landed under 三关)

Slice on `cursor/lynx-sse-live-local` (PR into `work/lynx-native`). Package Vitest + `tsc` + rspeedy. CI workflow remains template at `packages/lynx/ci/lynx-ci.yml` — **not claimed live**. 真机过: not executed.

| Item | Cap/web source | Lynx note |
|---|---|---|
| Chat SSE / event live tail | `event-pipeline.ts` `/api/global/event` (+ WS) | Parse Cap/OpenCode envelopes; fold `message.*` / `session.status` into the **same** LegendList (`liveEvents.ts` / `liveTail.ts`). No TanStack / no live overlay. Abort/working + queue flush on idle. Direct fetch exposes `body` stream; relay without stream fails honestly. |
| IME / composer occupancy contract | pitfalls §3, native composer README | Documented in `imeOccupancy.ts` + acceptance: host binds IME; occupancy = collapsed height only; no WebView FLIP. |
| Nested child session stack / predecessor | `mobileNavigation.ts` | `reconcileLynxChatPredecessor` + stack window chrome; ShellApp back pops predecessor (Cap decision). |

**CI绿:** Linux lynx-ci template only. Local Vitest `@openchamber/lynx` only.
**真机过:** not executed.

---
## Missing

Seeded from the inventory. Grouped so a slice can pick a coherent vertical.

### Host / skeleton

| Item | Cap/web source | Lynx note |
|---|---|---|
| Lynx rspeedy bundle + signed host apps | `packages/lynx` scaffold | Package + Linux CI template exists; CocoaPods/Gradle Lynx SDK and APK/IPA CI still missing; `.github/workflows/lynx-ci.yml` not installed without workflow scope |
| ~~Connect / splash while auto-connect resolves~~ | `MobileApp.tsx` welcome | **代码接上** ConnectWelcome splash + welcome; host LynxView chrome still thin |
| ~~Instance list, add, delete, password unlock~~ | `mobileConnections.ts` | **代码接上** instances UI on welcome + settings/instances |
| QR + pairing-link redeem v2 | `mobileQrScan.ts` | Link parse + redeem exist; **camera plugin** is host-owned |
| ~~`openchamber://` parse + apply~~ | `deepLinks.ts` | Parse/build + **apply → navigation** 代码接上 (stash until connect ready) |
| Secure store (Keychain / Keystore) | Capacitor secure storage | Injected adapter only — **native Keychain/Keystore wiring** still missing |
| Four-tab **product** content (session-index, catalogs) | `mobileTabs.ts` | Shell IA + tab bodies + **swipe/long-press menus** **代码接上**; rich pixel polish still missing |
| Host Tab/Nav **binary** (linked Lynx SDK) | `packages/lynx/host/*` | Strategy + sources landed; not an Xcode/Gradle project yet |

### Projects (chat list)

| Item | Cap/web source |
|---|---|
| ~~Project cards + worktree groups~~ | `MobileProjectsHome.tsx` | **代码接上** in `ProjectsHome` (worktree groups from session-index + optional parent map) |
| ~~Session rows, search, pin / in-progress~~ | `useMobileProjectsHomeModel.ts` | **代码接上** search + pin/busy cues |
| ~~`项目 · 分支` subtitle~~ | `formatHomeSessionSubtitle` | **代码接上** |
| ~~Collapsing MobileTabPageHeader~~ | `MobileTabPageHeader.tsx` | **代码接上** glass search + primary + |
| ~~Swipe / long-press actions~~ | `sessionMenuModel.ts` | **代码接上** long-press sheet → pin/archive/delete real APIs |
| ~~New-session draft page~~ | `kind: 'draft'` | **代码接上** draft composer body materializes POST /session |
| Add project directory explorer | `DirectoryExplorerDialog` | |
| Header 扫一扫 / 切换实例 | `MobileProjectsHome` | |
| ~~Session index as data source~~ | `GET /api/openchamber/session-index` (server) | Client + home projection + **Projects UI** 代码接上 |

### Chat

| Item | Cap/web source | Lynx note |
|---|---|---|
| ~~**LegendList-semantics timeline**~~ | `TimelineList.tsx` | **代码接上** list semantics + LynxTimelineList + **rich turn cards** (Activity / Q&P) |
| ~~SSE / event live tail~~ | `event-pipeline.ts` | **代码接上** Cap `/api/global/event` SSE fold into same list; WS host inject still thin |
| Chat header / overflow | `MobileChatScreen.tsx` | Header + Files/Changes/MCP overflow **代码接上**; rich actions still thin |
| ~~Send / Stop / queue / abort~~ | ChatInput + queue | **代码接上** hooks + official routes; composer text input host binding still thin |
| ~~Questions / permissions~~ | chat cards | **代码接上** pending `/question`+`/permission` cards + reply |
| ~~Activity / sorted / collapsed~~ | chat DOCUMENTATION | **代码接上** collapsed Activity disclosure (detail rows hidden until expand) |
| ~~Load-older button (no scroll auto-load)~~ | timeline controller | **代码接上** button + bounce forbid tests |
| ~~Nested child session stack + predecessor~~ | `mobileNavigation.ts` | **代码接上** reconcile + predecessor chrome; host underlay pixel polish still thin |
| ~~Files / Changes / turn-diff sheets~~ | `MobileFilesSurface`, `MobileChangesSurface` | **代码接上** list + text preview + file/turn diff + commit/fetch/pull/push. HTML iframe / PierreDiff polish still thin. |
| ~~MCP sheet~~ | `mobile-mcp` | **代码接上** overflow + `/api/config/mcp` list |
| Context usage | `mobileContextUsage.ts` | |
| Composer attachments, `/` `@`, agent/model | composer DOCUMENTATION | |
| Native-quality IME (not WebView FLIP) | pitfalls §3 | **Contract 代码接上** (`imeOccupancy.ts`); host keyboard binding / 真机 still missing |
| Session swipe (composer only) | `useEdgeSwipeSessionSwitch.ts` | |

### Assistant / Scheduled / Settings

| Item | Cap/web source | Lynx note |
|---|---|---|
| ~~Assistant catalog + conversation page~~ | `MobileAssistantTab.tsx`, `AssistantView.tsx` | **代码接上** catalog + LynxChatScreen; ensure path calls Cap `session/ensure` (no invented ids) |
| Continuous / stateless admission | assistants DOCUMENTATION | Mode labels shown; admission APIs not fully ported |
| ~~Share welcome + inbox~~ | `AssistantShareWelcome`, `MobileShareBridge` | **代码接上** share inbox + **welcome chrome** (Cap storage key + examples) |
| ~~Scheduled list / history / editor~~ | `MobileScheduledTab.tsx` | **代码接上** list + history + editor upsert UI |
| ~~Settings search + **all 21 mobile slugs**~~ | `MOBILE_SETTINGS_PAGE_SLUGS` | **代码接上** home search + grouped rows + push stubs |
| ~~Settings split collection → entity editor~~ | `SettingsView.tsx` | **代码接上** detail push + Cap save/delete for list-backed slugs (providers save = auth-unsupported) |

### Native platform

| Item | Cap/web source |
|---|---|
| ~~APNs + FCM registration~~ | `useNativePushRegistration.ts` | **代码接上** host-inject + `/api/push/apns-token` register/unregister + FCM package-id guard. Native token mint still host-owned. |
| Share extension / Android share receiver | `packages/mobile` share | Host/native still owns extensions; Lynx inbox accepts payloads |
| Live Activity | iOS 17+ plugin |
| Widgets / Control Center | `OpenChamberWidget` |
| Haptics | `OpenChamberHaptics` |
| Virtual image assets | `openchamber-asset://` |
| HEIC transcode | `OpenChamberMedia.transcode` |
| About + diagnostics export | `AboutSettings` |
| Predictive / edge back | `OpenChamberNavigation` |

### Voice (existing path only)

| Item | Cap/web source | Caution |
|---|---|---|
| Settings `voice` + dictation + TTS | `VoiceSettings.tsx`, `/api/dictation/*` | Port the **existing** routes or omit the page. Do not invent ASR. |

---

## Android降级

These are **intentional** platform differences already true in Cap, plus Lynx 3.8 glass limits. Android must ship a lesser, documented analogue — not a fake `UIGlassEffect`.

| Surface | iOS | Android analogue | Source / reason |
|---|---|---|---|
| Liquid glass dock | iOS 26 `UITabBarController` / Lynx `blur-effect="glass"` | Lynx-drawn capsule or Material nav; `blur-radius` only | Cap: `OpenChamberTabBar` is iOS-only. Lynx 3.8 glass attrs are **iOS** |
| Glass composer | `UIGlassEffect` / `<blur-view blur-effect="glass">` | Material / Lynx blur-radius composer | Cap: `OpenChamberComposer` iOS-only |
| Live Activity / Dynamic Island | iOS 17+ ActivityKit | No-op or a notification | Cap plugin iOS-only |
| Widgets / Control Center | WidgetKit | Optional; not required for first slice | Cap iOS extension |
| Share UX | Share Extension + suggestions | `ShareReceiverActivity` + full-page picker (never a sheet) | README share section |
| Photo picker | `PHPicker` / WK file input | `ACTION_PICK_IMAGES` / Lynx media | `OpenChamberMedia.pickMedia` is Android-only today |
| Back gesture | Screen-edge pan | Predictive Back (14+) / commit-only older | `OpenChamberNavigation` |
| Push | APNs | FCM + matching `applicationId` | pitfalls §6 |
| OTA | Capgo web-bundle (Cap only) | Same limitation — Lynx binary ≠ web bundle | 故意不移植 Capgo into Lynx unless a real Lynx OTA exists |
| Streaming cadence | 20ms / 64ms markdown pace | Cap already throttles Android 100ms / 128ms | chat DOCUMENTATION |

Glass-container fusion (`spacing`, `glass-interactive`, `glass-tint-color`) is **iOS 3.8**. Android `android-capture-target` / `blur-sampling` is a different effect. Do not claim “liquid glass on Android”.

---

## Next

First implementation slice after this doc gate (order is deliberate: connect → shell → list engine → one real transcript).

1. ~~Host app skeleton + embedding decision~~ — scaffold in `packages/lynx`. Remaining: link Lynx SDK, rspeedy bundle, device host; wire HTTP/Keychain/relay adapters.
2. ~~Connect + instance persistence client~~ — 代码接上 in `packages/lynx`. Remaining: welcome/instances UI, native secure store, and a real server 真机 pass (LAN then relay). No demo hosts. No Bonjour.
3. ~~Four-tab shell IA~~ — navigation + Projects/Assistant/Scheduled tab bodies 代码接上. Remaining: pixel polish / host IME.
4. ~~Projects home data path + UI~~ — session-index bindings + ProjectsHome UI in `packages/lynx` (failure ≠ empty). Remaining: directory explorer / 扫一扫 / instance switch chrome.
5. ~~**LegendList-semantics chat list** + send/stop on official APIs~~ — 代码接上 in `packages/lynx/src/chat`. SSE live tail 代码接上; native IME host binding still missing.
6. ~~**Settings home + slug map**~~ — 代码接上 search + 21 rows. Bodies: wired/list/stub in settings-ci slice. Remaining: rich entity editors.
7. ~~**Assistant catalog + Scheduled list/history**~~ — 代码接上 snapshot/list/history hooks. Remaining: admission flows.
8. ~~**Connect welcome + instances UI**~~ — 代码接上 splash/list/paste. Remaining: host QR camera + Keychain wiring + 真机.
9. ~~**Projects MobileTabPageHeader**~~ — 代码接上 collapsing header + glass search + primary +. Remaining: pixel polish / menu.
10. ~~**CI skeleton (Linux)**~~ — `packages/lynx/ci/lynx-ci.yml` → install as `.github/workflows/lynx-ci.yml` (needs `workflow` token scope) type-check + vitest + rspeedy. Remaining: Android APK + iOS sim runners (do not claim 真机过).
11. ~~**gap-close: summary-ai / behavior / scheduled editor / assistant ensure / chat Files·Changes stubs**~~ — 代码接上 in `cursor/lynx-gap-close-local`.
12. ~~**editors + Files/Changes/MCP lists + deep-link apply**~~ — 代码接上 in `cursor/lynx-editors-sheets-local`.
13. ~~**diff/preview + commit/sync + provider auth + push/share hooks**~~ — 代码接上 in `cursor/lynx-diff-push-share-local`. Remaining: host Keychain/QR/browser OAuth open, 真机.
14. ~~**rich turn cards + swipe menu + share welcome + draft + list harness**~~ — 代码接上 in `cursor/lynx-cards-swipe-harness-local`.
15. ~~**SSE live tail + IME occupancy contract + nested chat predecessor**~~ — 代码接上 in `cursor/lynx-sse-live-local`. Remaining: host IME binding / Keychain/QR, relay streaming body, 真机.

Do not start Share / Live Activity / widgets / Capgo / voice invention in slice 1.

---

## 真机残差

Empty until something is claimed landed. Seed the **kinds** of residual this track must expect (from Cap + Flutter history):

| Residual class | Why it will show up |
|---|---|
| IME / Chinese composition | WebView and Flutter both burned here |
| Keyboard occupancy vs queue / Changes | Collapsed-height contract |
| Session open pin / prepend jump | Why LegendList exists |
| LAN vs relay race | 1.5s LAN headstart; relay-only must skip it |
| FCM on debug package | `.debug` suffix vs `google-services.json` |
| iOS glass vs Android blur | Reviewers will call Android “broken glass” if you clone |
| Share generic vs Direct Share | Silent default Assistant is a bug |
| Predictive Back vs Lynx gesture arena | Two owners of the back edge |

A row moves here only after 代码接上 + CI绿 and a **written** device log (device model, OS, build SHA, what failed). “Looks fine in simulator” is not a residual; it is still **missing** 真机过.

---

## 故意不移植

| Item | Why |
|---|---|
| Expo / Flutter stack | This track is Lynx |
| 1.18 TanStack Virtual chat list | Hard forbid — use 1.19 LegendList semantics |
| Bonjour / Nearby browse | pitfalls §1; pairing v2 excluded LAN discovery |
| Invented native ASR / Siri voice | pitfalls §2 |
| WebView keyboard FLIP / ImeSyncBridge | pitfalls §3 |
| Settings slugs `shortcuts`, `remote-instances`, `global-config`, `skills.catalog` | Not in `MOBILE_SETTINGS_PAGE_SLUGS` |
| Desktop Finder reveal | Not a mobile feature |
| Electron / VS Code runtimes | Out of scope |
| Project notes / Todo / 加入笔记 | Removed in Cap 1.19.2 |
| Plan as a root tab | Plan is a session tool only |
| Hosted-H5 `mobileKeyboardMode=resize-content` | Browser viewport quirk; Lynx uses native IME |
| `openchamber.iosNativeUi` as a user toggle | Cap WebView-era; Lynx **is** native. Do not ship a “open the old WebView” switch in v1 |
| Capgo web-bundle OTA as the Lynx updater | Capgo updates `mobile.html`. A Lynx IPA/APK needs a real binary/OTA story later — do not upload Lynx assets to the Capacitor channel |
| PWA install-to-homescreen | Not the native app |
| Desktop SSH remote-instances UI | Hidden on mobile Settings |
| Fake Flexoki/Finder product chrome | pitfalls §8 |
| iPad layout in slice 1 | Phone first; iPad is a different IA (sidebar + sheets) |
| Merging `work/flutter-native` | Sibling track; different runtime |

---

## Settings slug board (21 mobile pages)

| Slug | Status | First honest body |
|---|---|---|
| `instances` | 代码接上 (wired body) | List + add/delete + paste pairing + password unlock; QR camera stub |
| `appearance` | 代码接上 (wired GET/PUT) | Theme mode + `flexoki-*` ids. No `iosNativeUi` toggle |
| `chat` | 代码接上 (wired GET/PUT) | Reasoning / queue / follow-up via `/api/config/settings` |
| `notifications` | 代码接上 (wired hooks + push register module) | Toggles via settings blob; host injects tokens; Lynx registers `/api/push/apns-token` |
| `sessions` | 代码接上 (wired GET/PUT) | Auto-delete + retention from settings blob |
| `summary-ai` | 代码接上 (wired GET/PUT + small-model) | Settings blob + `/api/small-model`; failure ≠ empty |
| `projects` | 代码接上 (list + editor) | settings blob list; detail save/delete via settings PUT |
| `git` | 代码接上 (wired gitmoji + stub editor) | gitmoji toggle; identities editor stub |
| `providers` | 代码接上 (list + editor) | catalog list; detail + **auth DELETE**; generic save unsupported |
| `agents` | 代码接上 (list + editor) | list + `/api/config/agents/:name` PATCH/DELETE |
| `assistants` | 代码接上 (list + editor) | snapshot list + PATCH/DELETE `/api/openchamber/assistants/:id` |
| `behavior` | 代码接上 (wired agents.md + response style) | `/api/behavior/agents-md` + settings blob response style |
| `commands` | 代码接上 (list + editor) | catalog + PATCH/DELETE `/api/config/commands/:name` |
| `mcp` | 代码接上 (list + editor) | list + PATCH/DELETE `/api/config/mcp/:name` |
| `plugins` | 代码接上 (list + editor) | list + PATCH/DELETE `/api/config/plugins/entry/:id` |
| `magic-prompts` | 代码接上 (list + editor) | list + PUT/DELETE `/api/magic-prompts/:id` |
| `snippets` | 代码接上 (list + editor) | list + PATCH/DELETE `/api/config/snippets/:name` |
| `skills.installed` | 代码接上 (list + editor) | list + PATCH/DELETE `/api/config/skills/:name` |
| `usage` | 代码接上 (list) | per-provider `/api/quota/:id`; one failure stays on that row |
| `voice` | 代码接上 (row; body list-only-until-routes) | Do not stub a fake mic; port existing /api/dictation or keep list-only |
| `about` | 代码接上 (wired) | Lynx client version **separate** from `/api/system/info` instance version |

---

## How to move a row

1. Implement against the inventory source, not a screenshot guess.
2. Add or update a focused test / harness (`docs/lynx-acceptance.md`).
3. Land on `work/lynx-native` only.
4. Flip **missing → landed** only after 代码接上 + CI绿.
5. Flip **landed →** keep a **真机残差** row until a physical device pass is written down.
6. Never silently recategorize a missing feature as 故意不移植 to make the board look green.
