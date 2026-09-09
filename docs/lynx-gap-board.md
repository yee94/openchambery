# Lynx mobile rewrite — gap board

Independent track: **`work/lynx-native`** from `main` @ `b444b0316` (`v1.19.7-beta.7`). Do **not** merge to `main`.

Lynx package + Android host scaffold **exist** on `work/lynx-native` (代码接上). This board stays honest: product rows are **not** landed under 三关 until CI绿 + 真机过. Update a row only when code, CI, and (for ship) 真机 evidence exist. Status words:

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

**CI绿:** lynx-ci + lynx-mobile-ci live on tip (Android sideload). Not 真机过.

**真机过:** not executed (environment: Linux cloud VM; no Xcode, no adb, no physical device).

---

## 代码接上 (chat LegendList + settings home — not landed under 三关)

Chat timeline + Settings tab home on `cursor/lynx-chat-settings-local` (PR into `work/lynx-native`). Package Vitest + `tsc` gate the claim. No track CI / 真机过.

| Item | Cap/web source | Lynx note |
|---|---|---|
| LegendList-semantics timeline | `TimelineList.tsx` | `src/chat/listSemantics.ts` + `LynxTimelineList`: one `<list>`, `recycle-items={false}`, `initialScrollAtEnd` / `maintainScrollAtEnd` / `maintainVisibleContentPosition`, load-older **button** only (bounce forbidden). TanStack 1.18 forbidden. |
| Send / Stop / queue hooks | ChatInput + queue | `src/chat/composerActions.ts` + `sessionApi.ts` → official `POST /session/:id/prompt_async`, `POST /session/:id/abort`, `GET /session/:id/message`. No runtime → explicit `no-runtime` failure (never fake-success). |
| Chat pushed page chrome | `MobileChatScreen.tsx` | `LynxChatScreen` header + timeline + composer actions. Markdown cards / Files / Changes / MCP sheets / IME FLIP **not** in this slice. |
| Settings search + 21 slug rows | `MOBILE_SETTINGS_PAGE_SLUGS`, `SettingsView` | `src/settings/metadata.ts` + `SettingsTab`: search, Cap group order, all 21 rows, in-tab push. Bodies are **labeled stubs** in early slices; tip `voice` is **代码接上** status + model download/delete (no invented ASR). No `iosNativeUi` toggle. |

**CI绿:** lynx-ci live on tip. Local Vitest also. Not 真机过.
**真机过:** not executed.

---


## 代码接上 (Projects / Assistant / Scheduled tabs — not landed under 三关)

Tab bodies on `cursor/lynx-tabs-home-local` (PR into `work/lynx-native`). Package Vitest + `tsc` gate the claim. No track CI / 真机过.

| Item | Cap/web source | Lynx note |
|---|---|---|
| Projects home UI | `MobileProjectsHome.tsx`, `useMobileProjectsHomeModel.ts` | `ProjectsHome` wired to `createSessionIndexHomeBindings` / `projectSessionIndexHome`: project cards, worktree groups, session rows, search, pin/in-progress cues, `项目 · 分支` subtitle, collapsing-title header spirit, draft→push Chat. **failure ≠ empty**. |
| Assistant catalog + conversation chrome | `MobileAssistantTab.tsx`, assistants snapshot | `assistants/*` → `GET /api/openchamber/assistants/snapshot` (+ ensure-session hook). Catalog tab; open conversation reuses `LynxChatScreen`. No invented ASR. Missing session → labeled stub (not fake chat id). |
| Scheduled list / history / editor hooks | `scheduledTasksApi.ts`, `MobileScheduledTab` | `scheduled/*` → `GET /api/openchamber/scheduled-tasks`, runs history, upsert PUT hook. Editor chrome is a **labeled stub**. Partial `failedProjectIds` preserved; no-runtime / HTTP failure ≠ empty success. |

**CI绿:** lynx-ci live on tip. Local Vitest also. Not 真机过.
**真机过:** not executed.

---

## 代码接上 (settings bodies + connect welcome + Projects header + CI skeleton — not landed under 三关)

Slice on `cursor/lynx-settings-ci-local` (PR into `work/lynx-native`). Package Vitest + `tsc` + rspeedy build via `.github/workflows/lynx-ci.yml` (**live** on tip; template also under `packages/lynx/ci/`) (Linux). APK/iOS sim jobs need Mac/Android runners — **not claimed**. 真机过: not executed.

| Item | Cap/web source | Lynx note |
|---|---|---|
| Settings page bodies (21 slugs) | SettingsView + settings blob + catalogs | Wired GET/PUT: instances, appearance (flexoki ids), chat, notifications hooks, sessions, gitmoji, about (Lynx version ≠ instance). List endpoints: providers/agents/mcp/plugins/skills/commands/magic-prompts/snippets/usage/assistants/projects. Editors labeled stubs (no fake-success). Tip `voice` = status + model download/delete UI (no invented ASR). No iosNativeUi. |
| Connect welcome / instances UI | MobileApp welcome + MobileInstancesSurface | Splash while auto-connect; instance list add/delete/password unlock; paste pairing link. QR camera labeled stub (host-owned). No Bonjour. |
| Projects MobileTabPageHeader | `MobileTabPageHeader.tsx` | Sticky translucent collapsing title + trailing glass search chip + primary +. Collapse math in `tabPageHeader.ts`. iOS glass via GlassChrome; Android blur-radius only. |
| CI skeleton | — | `.github/workflows/lynx-ci.yml` (**live** on tip; template also under `packages/lynx/ci/`) on PR → `work/lynx-native`: type-check + vitest + rspeedy. Documented that APK/iOS sim need Mac/Android runners. |

**CI绿:** lynx-ci + Android sideload APK live on tip. iOS IPA still missing. Not 真机过.
**真机过:** not executed (environment: Linux cloud VM).

---
## 代码接上 (gap-close: summary-ai/behavior, scheduled editor, assistant ensure, chat sheets — not landed under 三关)

Slice on `cursor/lynx-gap-close-local` (PR into `work/lynx-native`). Package Vitest + `tsc` + rspeedy. Track CI: `.github/workflows/lynx-ci.yml` + `lynx-mobile-ci.yml` are **live** on tip (historical slices predated install). 真机过: not executed.

| Item | Cap/web source | Lynx note |
|---|---|---|
| Settings `summary-ai` body | `SummarySettings.tsx`, `/api/config/settings`, `/api/small-model` | Wired GET/PUT settings blob fields + callableModels. Failure / empty capabilities ≠ silent empty success. |
| Settings `behavior` body | `BehaviorPage.tsx`, `/api/behavior/agents-md`, response-style settings | Wired agents.md GET/PUT + responseStyleEnabled/Preset/Custom via settings blob. Failure ≠ empty. |
| Scheduled editor UI | `ScheduledTaskEditorDialog`, PUT upsert | Real editor chrome (name/enabled/schedule/prompt/provider/model) calling `upsertScheduledTask`. Create needs project id from settings projects. Never fake-success. |
| Assistant unbound ensure | `ensureAssistantSession`, `AssistantView` | Shell calls Cap `POST …/session/ensure` when runtime present; null sessionID stays unbound labeled (no invented chat id). |
| Chat overflow + Files/Changes stubs | MobileApp overflow, Files/Changes sheets | Overflow menu hooks; Files/Changes navigate to labeled stub sheets with correct back. Bodies not ported. |

**CI绿:** lynx-ci live on tip (Linux type-check + vitest + rspeedy). Local Vitest `@openchamber/lynx` also. Not 真机过.
**真机过:** not executed.

---

## 代码接上 (editors + Files/Changes/MCP sheets + deep-link apply — not landed under 三关)

Slice on `cursor/lynx-editors-sheets-local` (PR into `work/lynx-native`). Package Vitest + `tsc` + rspeedy. Track CI: `.github/workflows/lynx-ci.yml` + `lynx-mobile-ci.yml` are **live** on tip (historical slices predated install). 真机过: not executed.

| Item | Cap/web source | Lynx note |
|---|---|---|
| Settings entity editors (list-backed) | SettingsView split → entity CRUD stores | Detail push + save/delete for providers (auth delete only; save unsupported), agents, assistants, mcp, plugins, commands, snippets, magic-prompts, skills.installed, projects. Real Cap routes; failure ≠ empty / fake-success. |
| Chat Files sheet | `MobileFilesSurface` → `/api/fs/list` | Real directory listing; no-directory / HTTP failure labeled. Text preview 代码接上; HTML Cap-like toggle + host stub in host-bridge deepen. |
| Chat Changes sheet | `MobileChangesSurface` → `/api/git/status` | Real status list (branch + staged/unstaged/untracked). Diff viewer / commit / sync not ported. |
| Chat MCP sheet | mobile MCP surface / `/api/config/mcp` | Overflow entry + catalog list. |
| `openchamber://` apply | `deepLinkNavigation.ts` | Parse already existed; apply maps intents → shell navigation (session/draft/tab/settings/sheets/instances). Stash until connect ready + handlers. |

**CI绿:** lynx-ci live on tip. Local Vitest `@openchamber/lynx` also. Not 真机过.
**真机过:** not executed.

---

## 代码接上 (diff/preview + commit/sync + provider auth + push/share hooks — not landed under 三关)

Slice on `cursor/lynx-diff-push-share-local` (PR into `work/lynx-native`). Package Vitest + `tsc` + rspeedy. Track CI: `.github/workflows/lynx-ci.yml` + `lynx-mobile-ci.yml` are **live** on tip (historical slices predated install). 真机过: not executed.

| Item | Cap/web source | Lynx note |
|---|---|---|
| Changes turn/file diff | `MobileChangesSurface` → `/api/git/file-diff`, `/api/git/diff` | Tap file → preview unified/original+modified. Binary labeled. |
| Changes commit / sync | `CommitSection`, `SyncActions` → `POST /api/git/commit\|fetch\|pull\|push` | **Real** Cap endpoints (not stubs). Failure ≠ fake-success. |
| Files text preview | `MobileFilesSurface` / FilesView → `/api/fs/read` | List stays real; tap file → text preview (truncated). HTML Cap-like source/preview stub in host-bridge deepen (no invent iframe). |
| Provider auth UI | `ProvidersPage` auth | API key `PUT /api/auth/:id`; OAuth authorize/callback Cap routes; **host-only** browser open documented (no invented OAuth/Capgo). Clear-auth delete unchanged. |
| Push registration hooks | `useNativePushRegistration` → `/api/push/apns-token` | Host injects APNs/FCM tokens; Lynx stores + registers/unregisters. FCM `applicationId` must be `com.yee94.openchamber[.debug]` (pitfalls §6). |
| Share inbox intake | `MobileShareBridge` → assistants `/share` | Accept host share envelope / openchamber share intents; dispatch to Assistant session. No Capgo. |

**CI绿:** lynx-ci live on tip. Local Vitest `@openchamber/lynx` also. Not 真机过.
**真机过:** not executed.

---

## 代码接上 (rich turn cards + swipe menu + share welcome + draft + list harness — not landed under 三关)

Slice on `cursor/lynx-cards-swipe-harness-local` (PR into `work/lynx-native`). Package Vitest + `tsc` + rspeedy. Track CI: `.github/workflows/lynx-ci.yml` + `lynx-mobile-ci.yml` are **live** on tip (historical slices predated install). 真机过: not executed.

| Item | Cap/web source | Lynx note |
|---|---|---|
| Chat rich turn cards | message parts, ProgressiveGroup, QuestionCard, PermissionCard | Wire Cap part types (`text`/`reasoning`/`tool`/`file`/`agent`); Activity collapsed/expanded; pending `/question`+`/permission` reply. No invented types. |
| Projects swipe / long-press | `sessionMenuModel.ts` | Long-press sheet: pin (session-index), archive/delete (`PATCH`/`DELETE /session/:id`). Share/rename gated when callbacks exist. |
| Share welcome chrome | `AssistantShareWelcome` | Education cards + Cap storage key on Assistant tab above share inbox. |
| Draft composer body | mobile `kind: 'draft'` | `LynxDraftComposer` materializes `POST /session` → `prompt_async` then opens chat. |
| List perf harness | Cap `streamingRenderCadence.ts` + acceptance harness | Unit harness measures synthetic scroll/update cadence + prepend anchor; documents Cap 20/64 & Android 100/128 — **no fake device numbers**. |

**CI绿:** lynx-ci live on tip. Local Vitest `@openchamber/lynx` also. Not 真机过.
**真机过:** not executed.

---

## 代码接上 (SSE live tail + IME contract + nested chat stack — not landed under 三关)

Slice on `cursor/lynx-sse-live-local` (PR into `work/lynx-native`). Package Vitest + `tsc` + rspeedy. Track CI: `.github/workflows/lynx-ci.yml` + `lynx-mobile-ci.yml` are **live** on tip (historical slices predated install). 真机过: not executed.

| Item | Cap/web source | Lynx note |
|---|---|---|
| Chat SSE / event live tail | `event-pipeline.ts` `/api/global/event` (+ WS) | Parse Cap/OpenCode envelopes; fold `message.*` / `session.status` into the **same** LegendList (`liveEvents.ts` / `liveTail.ts`). No TanStack / no live overlay. Abort/working + queue flush on idle. Direct fetch exposes `body` stream; relay without stream fails honestly. |
| IME / composer occupancy contract | pitfalls §3, native composer README | Documented in `imeOccupancy.ts` + acceptance: host binds IME; occupancy = collapsed height only; no WebView FLIP. |
| Nested child session stack / predecessor | `mobileNavigation.ts` | `reconcileLynxChatPredecessor` + stack window chrome; ShellApp back pops predecessor (Cap decision). |

**CI绿:** lynx-ci live on tip. Local Vitest `@openchamber/lynx` also. Not 真机过.
**真机过:** not executed.

---

## 代码接上 (context usage + edge swipe + host media/haptics + pin reveal — not landed under 三关)

Slice on `cursor/lynx-context-edge-media-local` (PR into `work/lynx-native`). Package Vitest + `tsc` + rspeedy. Track CI: `.github/workflows/lynx-ci.yml` + `lynx-mobile-ci.yml` are **live** on tip (historical slices predated install). 真机过: not executed.

| Item | Cap/web source | Lynx note |
|---|---|---|
| Context usage chrome | `mobileContextUsage.ts`, `/api/config/providers` | Port baseline scan + display; resolve context limit from real Cap providers catalog; chip in chat header. Failure / missing limit → hide (never invent). |
| Edge swipe session switch | `useEdgeSwipeSessionSwitch.ts` | Composer-only ownership + geometry + state machine (`edgeSwipeSessionSwitch.ts`). Host binds pan via `edgeSwipeDispatchRef`. Docs: `LYNX_EDGE_SWIPE_HOST_CONTRACT`. |
| Haptics adapter | `OpenChamberHaptics`, `streamingHaptics.ts` | Host-inject `createLynxHapticsAdapter`; no host → `unavailable` (not fake-success). Wired from edge-swipe effects. |
| HEIC / media pick | `OpenChamberMedia`, `native-media-pick.ts`, `native-image-transcode.ts` | Host-inject pick + transcode; composer Attach call site; no host → unavailable / not-heic skipped honestly. |
| Load-older / markdown pin reveal polish | Cap load-older + `markdownPinReveal.ts` | `canAcceptLynxLoadOlderTap` rejects settle/busy; pin-reveal arm/ready/timeout state + TimelineList visibility attr. |

**CI绿:** lynx-ci live on tip. Local Vitest `@openchamber/lynx` also. Not 真机过.
**真机过:** not executed.

---
## Missing

Seeded from the inventory. Grouped so a slice can pick a coherent vertical.

### Host / skeleton

| Item | Cap/web source | Lynx note |
|---|---|---|
| Lynx rspeedy bundle + signed host apps | `packages/lynx` scaffold | **Live** `.github/workflows/lynx-ci.yml` + `lynx-mobile-ci.yml` on tip (lynx-ci green; Android sideload APK green; prerelease `lynx-v2-debug-b170e47`). iOS IPA / CocoaPods resolve still missing. Sideload `applicationId` = `com.yee94.openchamber.lynx.debug`. First-paint cream + globalProps 代码接上 — **not** 真机过. |
| ~~Connect / splash while auto-connect resolves~~ | `MobileApp.tsx` welcome | **代码接上** ConnectWelcome splash + welcome; host LynxView chrome still thin |
| ~~Instance list, add, delete, password unlock~~ | `mobileConnections.ts` | **代码接上** instances UI on welcome + settings/instances |
| QR + pairing-link redeem v2 | `mobileQrScan.ts` | Link parse + redeem exist; **camera plugin** is host-owned |
| ~~`openchamber://` parse + apply~~ | `deepLinks.ts` | Parse/build + **apply → navigation** 代码接上 (stash until connect ready) |
| Secure store (Keychain / Keystore) | Capacitor secure storage | JS adapter + host Keychain/EncryptedSharedPreferences **stubs** 代码接上; live OS wiring still 真机 |
| Four-tab **product** content (session-index, catalogs) | `mobileTabs.ts` | Shell IA + tab bodies + **swipe/long-press menus** **代码接上**; rich pixel polish still missing |
| Host Tab/Nav **binary** (linked Lynx SDK) | `packages/lynx/host/*` | Strategy + Xcode/Gradle **scaffold** 代码接上 (PR#48); CocoaPods/AAR resolve still missing on Linux |

### Projects (chat list)

| Item | Cap/web source |
|---|---|
| ~~Project cards + worktree groups~~ | `MobileProjectsHome.tsx` | **代码接上** in `ProjectsHome` (worktree groups from session-index + optional parent map) |
| ~~Session rows, search, pin / in-progress~~ | `useMobileProjectsHomeModel.ts` | **代码接上** search + pin/busy cues |
| ~~`项目 · 分支` subtitle~~ | `formatHomeSessionSubtitle` | **代码接上** |
| ~~Collapsing MobileTabPageHeader~~ | `MobileTabPageHeader.tsx` | **代码接上** glass search + primary + |
| ~~Swipe / long-press actions~~ | `sessionMenuModel.ts` | **代码接上** long-press sheet → pin/archive/delete/**rename** real APIs |
| ~~New-session draft page~~ | `kind: 'draft'` | **代码接上** draft composer body materializes POST /session |
| ~~Add project directory explorer~~ | `DirectoryExplorerDialog` | **代码接上** in PR#48 (`DirectoryExplorer` + settings projects add) |
| ~~Header 扫一扫 / 切换实例~~ | `MobileProjectsHome` | **代码接上** chrome; camera host still unavailable until binder |
| ~~Session index as data source~~ | `GET /api/openchamber/session-index` (server) | Client + home projection + **Projects UI** 代码接上 |

### Chat

| Item | Cap/web source | Lynx note |
|---|---|---|
| ~~**LegendList-semantics timeline**~~ | `TimelineList.tsx` | **代码接上** list semantics + LynxTimelineList + **rich turn cards** (Activity / Q&P) |
| ~~SSE / event live tail~~ | `event-pipeline.ts` | **代码接上** Cap `/api/global/event` SSE fold into same list; WS host inject still thin |
| Chat header / overflow | `MobileChatScreen.tsx` | Header + Cap phone overflow **new-session** + Files/Changes/MCP/refresh **代码接上**; Capgo update 故意不移植; iPad Settings omitted (Lynx has Settings tab) |
| ~~Send / Stop / queue / abort~~ | ChatInput + queue | **代码接上** hooks + official routes; composer text input host binding still thin |
| ~~Questions / permissions~~ | chat cards | **代码接上** pending `/question`+`/permission` cards + reply |
| ~~Activity / sorted / collapsed~~ | chat DOCUMENTATION | **代码接上** collapsed Activity disclosure (detail rows hidden until expand) |
| ~~Load-older button (no scroll auto-load)~~ | timeline controller | **代码接上** button + bounce forbid + prepend-settle gate + pin-reveal polish |
| ~~Nested child session stack + predecessor~~ | `mobileNavigation.ts` | **代码接上** reconcile + predecessor chrome; host underlay pixel polish still thin |
| ~~Files / Changes / turn-diff sheets~~ | `MobileFilesSurface`, `MobileChangesSurface` | **代码接上** list + text preview + file/turn diff + commit/fetch/pull/push + **stage/unstage** (GlassChrome searchChip +/−) + **revert** Cap `arrow-go-back` ↩ + Cap **centered Dialog** at **shell-root portal** (full-screen; status.error / onError tokens) + Cap commit→push **pull-if-behind**. HTML preview = labeled text stub until host WKWebView; PierreDiff = portable text only — Cap `@pierre/diffs` **unavailable** (Shadow DOM / react-dom blocker). |
| ~~MCP sheet~~ | `mobile-mcp` | **代码接上** overflow + `/api/config/mcp` list |
| ~~Context usage~~ | `mobileContextUsage.ts` | **代码接上** header chip + Cap `/api/config/providers` limit |
| | ~~Composer attachments, `/` `@`, agent/model~~ | composer DOCUMENTATION | Attach + `/` `@` catalogs **代码接上** (Chat + Draft); autocomplete **above glass**; GlassChrome + in-glass Attach/Send/Stop/Queue **代码接上**; Cap Agent·model **picker sheets** (`/api/agent` + `/api/config/providers` → prompt_async selection) **代码接上**; host Mode B overlay / 真机 still thin |
| Native-quality IME (not WebView FLIP) | pitfalls §3 | **Contract 代码接上** (`imeOccupancy.ts`); host keyboard binding / 真机 still missing |
| ~~Session swipe (composer only)~~ | `useEdgeSwipeSessionSwitch.ts` | **代码接上** state machine + composer surface; **host pan bind** still required |

### Assistant / Scheduled / Settings

| Item | Cap/web source | Lynx note |
|---|---|---|
| ~~Assistant catalog + conversation page~~ | `MobileAssistantTab.tsx`, `AssistantView.tsx` | **代码接上** catalog + LynxChatScreen; ensure path calls Cap `session/ensure` (no invented ids) |
| ~~Continuous / stateless admission~~ | assistants DOCUMENTATION | **代码接上** `POST …/assistants/:id/messages` (PR#48); mode polish still thin |
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
| ~~Haptics~~ | `OpenChamberHaptics` | **代码接上** host-inject adapter; native impact still host-owned |
| ~~Virtual image assets~~ | `openchamber-asset://` | **代码接上** TS + host scheme stubs (PR#48 / host-bridge deepen) |
| ~~HEIC / media pick~~ | `OpenChamberMedia.transcode` / `pickMedia` | **代码接上** host-inject + Attach call site; no fake success without host |
| ~~About + diagnostics export~~ | `AboutSettings` | **代码接上** `openchamber.client-diagnostics.v1` export (PR#48) |
| ~~Predictive / edge back~~ | `OpenChamberNavigation` | **代码接上** JS policy + host stubs (PR#48); 真机 arena still host |

### Voice (existing path only)

| Item | Cap/web source | Caution |
|---|---|---|
| ~~Settings `voice` + dictation + TTS~~ | `VoiceSettings.tsx`, `/api/dictation/*` | **代码接上** status + STT/TTS model download/delete UI (`VoiceBody` + `/api/dictation/*`). Mic/WS ASR stays host-bound — do not invent ASR. |

---

## Android降级

These are **intentional** platform differences already true in Cap, plus Lynx 3.8 glass limits. Android must ship a lesser, documented analogue — not a fake `UIGlassEffect`.

| Surface | iOS | Android analogue | Source / reason |
|---|---|---|---|
| Liquid glass dock | iOS 26 `UITabBarController` / Lynx `blur-effect="glass"` | Lynx-drawn capsule or Material nav; `blur-radius` only | Cap: `OpenChamberTabBar` is iOS-only. Lynx 3.8 glass attrs are **iOS** |
| Glass composer | `UIGlassEffect` / `<blur-view blur-effect="glass">` via `LynxComposerGlassCard` (**代码接上**, not 真机过) | Material / Lynx blur-radius composer | Cap: `OpenChamberComposer` iOS-only; Lynx Android blur-radius only |
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
4. ~~Projects home data path + UI~~ — session-index bindings + ProjectsHome UI + DirectoryExplorer + 扫一扫/切换实例 chrome 代码接上. Remaining: pixel polish / host camera binder 真机.
5. ~~**LegendList-semantics chat list** + send/stop on official APIs~~ — 代码接上 in `packages/lynx/src/chat`. SSE live tail 代码接上; native IME host binding still missing.
6. ~~**Settings home + slug map**~~ — 代码接上 search + 21 rows. Bodies: wired/list/stub in settings-ci slice. Remaining: rich entity editors.
7. ~~**Assistant catalog + Scheduled list/history**~~ — 代码接上 snapshot/list/history hooks. Remaining: admission flows.
8. ~~**Connect welcome + instances UI**~~ — 代码接上 splash/list/paste. Remaining: host QR camera + Keychain wiring + 真机.
9. ~~**Projects MobileTabPageHeader**~~ — 代码接上 collapsing header + glass search + primary +. Remaining: pixel polish / menu.
10. ~~**CI skeleton (Linux)**~~ — **live** on tip: `.github/workflows/lynx-ci.yml` + `lynx-mobile-ci.yml` (lynx-ci green; Android sideload APK green; prerelease `lynx-v2-debug-*`). Remaining: iOS IPA / sim runners + 真机过 (do not claim from CI alone).
11. ~~**gap-close: summary-ai / behavior / scheduled editor / assistant ensure / chat Files·Changes stubs**~~ — 代码接上 in `cursor/lynx-gap-close-local`.
12. ~~**editors + Files/Changes/MCP lists + deep-link apply**~~ — 代码接上 in `cursor/lynx-editors-sheets-local`.
13. ~~**diff/preview + commit/sync + provider auth + push/share hooks**~~ — 代码接上 in `cursor/lynx-diff-push-share-local`. Remaining: host Keychain/QR/browser OAuth open, 真机.
14. ~~**rich turn cards + swipe menu + share welcome + draft + list harness**~~ — 代码接上 in `cursor/lynx-cards-swipe-harness-local`.
15. ~~**SSE live tail + IME occupancy contract + nested chat predecessor**~~ — 代码接上 in `cursor/lynx-sse-live-local`. Remaining: host IME binding / Keychain/QR, relay streaming body, 真机.
16. ~~**context usage + edge swipe + haptics/HEIC/media + pin reveal**~~ — 代码接上 in `cursor/lynx-context-edge-media-local`. Remaining: host pan/haptics/media binders, Keychain/OAuth browser, Live Activity/Widgets, 真机.
17. ~~**closable missing: host scaffold + lynx-ci workflow + DirectoryExplorer + 扫一扫/切换实例 + composer `/` `@` + admission + voice dictation status + About diagnostics + openchamber-asset hooks + predictive-back contract**~~ — 代码接上 in `cursor/lynx-closable-missing-local`. Remaining: real camera/SDK link / Keychain / IME 真机; not product-EXHAUSTED.
18. ~~**linux gaps: GitIdentity* editor + Files HTML preview stub + DraftComposer `/` `@` + autocomplete above glass + host-bridge deepen + Missing strikethrough hygiene**~~ — 代码接上 in `cursor/lynx-linux-gaps-local`. Remaining: host WKWebView HTML sheet / PierreDiff / live Keychain·camera·IME 真机; product NOT DONE.
19. ~~**composer glass: LynxComposerGlassCard GlassChrome on Chat+Draft + autocomplete sibling ABOVE glass + optional row searchChip**~~ — 代码接上 in `cursor/lynx-composer-glass-local`. Remaining: Mode B host composer overlay / live UIGlassEffect 真机; product NOT DONE.
20. ~~**composer actions in glass: Attach/Send/Stop/Queue inside LynxComposerGlassCard (Cap pill/card order); autocomplete stays ABOVE**~~ — 代码接上 in `cursor/lynx-composer-actions-in-glass-local`. Remaining: Mode B host overlay / live UIGlassEffect / 真机; product NOT DONE.
21. ~~**composer Agent·model picker sheets: Cap MobileResizableSheet spirit; `/api/agent` + providers catalog; selection → prompt_async**~~ — 代码接上 in `cursor/lynx-agent-model-picker-local`. Remaining: Mode B host overlay / live UIGlassEffect / 真机; product NOT DONE.
22. ~~**resizable picker sheets + Draft Stop abort: half-height grabber sheet (not full-screen surface.background); Draft busy Stop aborts**~~ — 代码接上 in `cursor/lynx-resizable-picker-sheets-local`. Remaining: Mode B host overlay / live UIGlassEffect / 真机 drag feel; product NOT DONE.
23. ~~**Cap sheet height snaps 72/98dvh: LynxMobileResizableSheet half 0.72 / expanded 0.98 (was 50%/92%)**~~ — 代码接上 in `cursor/lynx-sheet-height-cap-local` (PR #55). Remaining: Mode B host overlay / live UIGlassEffect / 真机 drag feel; product NOT DONE.
24. ~~**linux closable after #55: portable text diff + Cap stage/unstage + Projects rename wiring + docs hygiene**~~ — 代码接上 in `cursor/lynx-linux-closable-after-55-local`. Remaining: host-only / 真机 (Pierre runtime, WKWebView, Keychain, camera, IME, Mode B); product NOT DONE.
25. ~~**diff/chip polish on #56: Cap status add/del tokens + GlassChrome searchChip stage/unstage**~~ — 代码接上 in `cursor/lynx-diff-chip-polish-local`. Remaining: Pierre `@pierre/diffs` runtime / Mode B / 真机; product NOT DONE.
26. ~~**Pierre investigation + ChangeRow spacing on #57 tip: honest Shadow DOM blocker + Cap size-6 chip / +n/-m slash / diffStats**~~ — 代码接上 in `cursor/lynx-pierre-diffs-local`. Cap `@pierre/diffs` **cannot** run in Lynx (diffs-container Shadow DOM + react-dom). Portable path only; product NOT DONE / no 真机过.
27. ~~**Changes revert + generateCommitMessage + commitAndPush on #58 tip**~~ — 代码接上 in `cursor/lynx-changes-revert-commitmsg-local`. Cap `POST /api/git/revert`, Cap mobile `POST /api/small-model/generate` purpose commit (not dead `/api/git/commit-message`), combined commit→push. Remaining: host-only / 真机 / Pierre / WKWebView; product NOT DONE.
28. ~~**Changes revert glass + Cap confirm + pull-if-behind on #59 tip**~~ — 代码接上 in `cursor/lynx-revert-confirm-pull-local`. GlassChrome searchChip revert (↩) like stage +/−; Cap Dialog confirm before revert (Cap does **not** confirm commit&push); Cap commit→fetch→pull-if-behind(rebase)→push-if-ahead. Remaining: host-only / 真机 / Pierre / WKWebView; product NOT DONE.
29. ~~**Centered Cap Dialog revert confirm on #60 tip**~~ — 代码接上 in `cursor/lynx-centered-confirm-dialog-local`. Replace elevated-in-sheet confirm card with Cap Dialog spirit (**scrim + centered max-w-md panel**); keep RevertGlassChip + pull-if-behind. Remaining: host-only / 真机 / Pierre / WKWebView; product NOT DONE.
30. ~~**Dialog shell portal + destructive tokens + Cap arrow-go-back glyph on #61 tip**~~ — 代码接上 in `cursor/lynx-dialog-portal-theme-local`. Mount `LynxCenteredDialog` at **shell-root portal** (full-screen overlay, Cap DialogPortal spirit) — not nested absolute inside Changes relative; destructive uses `status.error` / `status.onError` (Cap `--destructive-foreground`, never `#fff`); RevertGlassChip glyph = Cap Icon `arrow-go-back` unicode ↩. Remaining: host-only / 真机 / Pierre / WKWebView; product NOT DONE.
31. ~~**Android first-paint / black-screen mitigation + live CI honesty**~~ — 代码接上 (PR #65 + docs follow-up) + follow-up `cursor/lynx-first-paint-visible-smoke`: Yee 真机 showed 有字无样式 (done-phase welcome) — Android Lynx drops inline style values containing `var(...)`; `cssVar()` / `tokenColor()` now return resolved Flexoki-light **hex** (never `var(--name, #hex)`). Strict smoke requires literal `text="Connecting` / `text="OpenChamber Lynx` (NOT content-desc alone, NOT splash console.log — false-green on `lynx-v2-debug-cfed156` / job 102340406447 fixed). Host TextView splash overlay until first_screen+20s. **三关: 真机过 still open until Yee confirms styled cream/elevated/primary.** Product NOT DONE / 三关未齐 / not EXHAUSTED.
32. ~~**Cap phone overflow new-session → draft**~~ — 代码接上 in `cursor/lynx-overflow-new-session-local`. Cap `MobileApp` overflow first item `new-session` opens draft; Lynx overflow previously started at Files. Wire `onOpenDraft` → shell `openDraft` / `LynxDraftComposer`. Docs honesty: tip APK `lynx-v2-debug-b170e47` (was stale `09b3853`); note #67–#69. Remaining: host-only / 真机 / Pierre / WKWebView / Mode B; product NOT DONE.
33. ~~**Settings Voice model download/delete UI**~~ — 代码接上 in `cursor/lynx-voice-models-download-local`. Cap `VoiceSettings` STT model rows + optional Kokoro `ttsModels` via existing `/api/dictation/status` + `POST/DELETE …/models/:id`; `VoiceBody` download/progress/delete; no invented ASR/mic/WS. Docs honesty: tip APK was `lynx-v2-debug-1a5c899` at merge; current tip `lynx-v2-debug-b170e47`. Remaining: host-only / 真机 / Pierre / WKWebView / Mode B / iOS IPA; product NOT DONE.
34. ~~**Voice STT model select + Overflow Changes dirty badge**~~ — 代码接上 in `cursor/lynx-voice-select-dirty-badge-local`. Cap `LocalModelPicker` / `setSttLocalModel` → PUT `sttLocalModel` (+ optional `dictationEnabled`); pass `localModel` into status; preview/browser TTS/say labeled unavailable; Cap `dirtyChangeCount` badge on Changes overflow from git status entry count (no fake on failure). Docs honesty: tip APK `lynx-v2-debug-b170e47`. Remaining: host-only / 真机 / Pierre / WKWebView / Mode B / iOS IPA; product NOT DONE.

35. ~~**PermissionCard metadata + permission auto-accept**~~ — 代码接上 in `cursor/lynx-permission-metadata-auto-accept-local` (PR #73). Cap PermissionCard metadata plain text + GET/PUT permission-auto-accept. Remaining: host-only / 真机 / Pierre / WKWebView / Mode B / iOS IPA; product NOT DONE.
36. ~~**Cap share-recipient picker**~~ — 代码接上 in `cursor/lynx-share-recipient-picker-local`. Cap `MobileShareRecipientPicker` full-page overlay (never a sheet) + `NativeShareDraft` Partial target + `MobileShareBridge` unassigned→picker / assigned→dispatch; never silent-default Assistant. Host Share extension / `ShareReceiverActivity` stay host-only. Docs honesty: tip APK `lynx-v2-debug-93b4355`; product NOT DONE / 三关未齐 / not EXHAUSTED; 真机残差 empty.
37. ~~**Projects home project/worktree menus + session share**~~ — 代码接上 in `cursor/lynx-projects-menus-share-local`. Wire `buildLynxProjectMenuItems` / `buildLynxWorktreeMenuItems` + session share/copyLink/unshare against Cap/OpenCode `POST|DELETE /session/:id/share`; Linux-closable newSession/syncSessions/edit/closeProject/newWorktree/deleteWorktree (honest unavailable when HTTP missing). Docs honesty: tip APK `lynx-v2-debug-0b470a2`; product NOT DONE / 三关未齐 / not EXHAUSTED; 真机残差 empty.
38. ~~**QueuedMessageChips + SessionGoalRow**~~ — 代码接上 in `cursor/lynx-queue-chips-goal-local`. Cap queue chips + SessionGoal strip above composer glass; local `composerActions` queue with remove/send-now + portable ↑/↓ reorder (Cap `@dnd-kit` / server `/api/openchamber/message-queue` deferred). SessionGoal GET+PATCH metadata + optional `/api/goals/objective`; never fake-success. **MobileSessionStatusBar deferred** (Cap file large — follow-up). Docs honesty: tip APK `lynx-v2-debug-905c42e`; product NOT DONE / 三关未齐 / not EXHAUSTED; 真机残差 empty.
39. ~~**MobileSessionStatusBar slim strip**~~ — 代码接上 in `cursor/lynx-session-status-bar-local`. Cap multi-session status bar **thin** parity (not full ~1900-line sheet): related session chips + busy/working indicator above composer with SessionGoal + queue chips; Cap filter/preserve-active-project resolvers; session-index related list from shell; full Cap sessions sheet / worktree menus / server message-queue deferred. Docs honesty: tip APK `lynx-v2-debug-ca32a72` (release exists); product NOT DONE / 三关未齐 / not EXHAUSTED; 真机残差 empty.
40. ~~**SessionGoal create/manage dialog**~~ — 代码接上 in `cursor/lynx-session-goal-dialog-local`. Cap `SessionGoalDialog` + `setSessionGoal`/`clearSessionGoal` parity: Lynx `setLynxSessionGoal`/`clearLynxSessionGoal` (GET `/session/:id` + PATCH `metadata.openchamber.goal` + Cap `/api/goals/objective/:id`); create/manage overlay via shell `LynxCenteredDialog`/`LynxDialogPortal`; row tap → manage; create entry when no goal + Cap `/goal` arm (never auto-send). Complete via existing `setLynxSessionGoalStatus('complete')`. Docs honesty: tip `8def01d0` / tip APK `lynx-v2-debug-8def01d` (release exists); product NOT DONE / 三关未齐 / not EXHAUSTED; 真机残差 empty.
41. ~~**Cap server message-queue client + QueuedMessageChips wire**~~ — 代码接上 in `cursor/lynx-message-queue-server-local`. Thin Cap-compatible `messageQueueServer.ts` over `LynxRuntimeFetch` (list/admit/reorder/remove/send-now; flush=send-now first); composerActions prefers server when reachable, falls back to local on unavailable; portable ↑/↓ (no `@dnd-kit` / no TanStack). Docs honesty: tip `c02f917f` / tip APK `lynx-v2-debug-c02f917` (release exists); product NOT DONE / 三关未齐 / not EXHAUSTED; 真机残差 empty; full Cap sessions sheet still deferred; host-only unchanged.
42. ~~**Cap full sessions sheet from slim SessionStatusBar**~~ — 代码接上 in `cursor/lynx-sessions-sheet-local`. Cap MobileSessionsSheet / MobileSessionStatusBar sheet spirit via `LynxMobileResizableSheet` (0.72/0.98): session-index project+worktree grouped list (portable TS, not Cap Zustand), search, All/pinned/project filter chips (`LYNX_PINNED_SESSION_FILTER_ID` + `resolveMobileSessionSheetDefaultFilter` + `shouldPreserveActiveProjectOnSessionOpen`), tap → switch+close, long-press reuses `buildLynx*MenuItems` (honest unavailable when HTTP missing). Deferred: Cap `@dnd-kit` / MobileWindowMotion polish / iPad sidebar. Docs honesty: tip `f72fbe0c` / tip APK `lynx-v2-debug-f72fbe0` (release exists — do not invent newer); product NOT DONE / 三关未齐 / not EXHAUSTED; 真机残差 empty; host-only unchanged.
43. ~~**Cap worktree create/delete dialogs on SessionsSheet**~~ — 代码接上 in `cursor/lynx-worktree-dialogs-local`. Cap name prompt (not auto `wt-*`) + confirm delete via shared `LynxCreateWorktreeDialog` / `LynxDeleteWorktreeDialog` (ProjectsHome + SessionsSheet). Deepen Cap MobileDeleteWorktreeDialog spirit: `deleteLocalBranch` toggle (API on `deleteLynxWorktree`), archive linked sessions via `archiveLynxSession`, dirty warning via Cap `GET /api/git/status` (`probeLynxWorktreeDirty`). Deferred at merge: remote-branch delete (closed in Next #44), Cap `@dnd-kit` / MobileWindowMotion / iPad sidebar. Docs honesty: base tip `ebe3d408` / tip APK `lynx-v2-debug-ebe3d40` (release exists); product NOT DONE / 三关未齐 / not EXHAUSTED; 真机残差 empty; host-only unchanged.
44. ~~**Cap deleteRemoteBranch on Lynx worktree delete**~~ — 代码接上 in `cursor/lynx-delete-remote-branch-local`. Cap `MobileDeleteWorktreeDialog` / `removeProjectWorktree` remote toggle: Lynx `deleteLynxRemoteBranch` → Cap `DELETE /api/git/remote-branches?directory=` `{ branch, remote? }`; wired into `deleteLynxWorktree` (after worktree remove, Cap order) + `LynxDeleteWorktreeDialog` toggle. Real API only — remote failure after worktree remove reported honestly (`worktreeRemoved`, never fake-success). Deferred unchanged: Cap `@dnd-kit` / MobileWindowMotion / iPad sidebar / host binders. Docs honesty: tip `fd333a09` / tip APK `lynx-v2-debug-fd333a0` (release exists; was stale `b3d340b`); product NOT DONE / 三关未齐 / not EXHAUSTED; 真机残差 empty; host-only unchanged.
45. ~~**Cap SessionsSheet two-step archive + unarchive undo**~~ — 代码接上 in `cursor/lynx-sessions-archive-undo-local`. Cap `MobileSessionsSheet` `confirmingArchive` / `onRequestArchive` / `onConfirmArchive` spirit + `sessionMutationUndo` ~10s window: Lynx `unarchiveLynxSession` → PATCH `/session/:id` `{ time: { archived: 0 } }`; SessionsSheet row two-step archive control + portable undo banner/chip (also from long-press archive). Real API only — never fake-success. Deferred at merge: Cap toast lib / bulk multi-select / ArchivedSessionsDialog (closed in Next #46) / smart-title / `@dnd-kit` / MobileWindowMotion / iPad sidebar / host binders. Docs honesty: tip `a1ea85e0` / tip APK `lynx-v2-debug-a1ea85e` (release exists; was stale `fd333a0`); product NOT DONE / 三关未齐 / not EXHAUSTED; 真机残差 empty; host-only unchanged.
46. ~~**Cap ArchivedSessionsDialog on SessionsSheet**~~ — 代码接上 in `cursor/lynx-archived-sessions-dialog-local`. Cap `ArchivedSessionsDialog` spirit: list archived via OpenChamber `GET /api/experimental/session?archived=true&roots=true` (Cap `experimental.session.list`), project buckets + restore via `unarchiveLynxSession` + preview; honest empty/load/no-runtime. Entry from SessionsSheet (footer + undo-banner View archived). Session-index labels only (index drops archived roots). Deferred unchanged: bulk multi-select / smart-title / Cap toast lib / `@dnd-kit` / MobileWindowMotion / iPad sidebar / host binders. Docs honesty: tip APK `lynx-v2-debug-28bdee8` (release exists for base tip `28bdee8c`); product NOT DONE / 三关未齐 / not EXHAUSTED; 真机残差 empty; host-only unchanged.
47. ~~**Cap session rename smart-title**~~ — 代码接上 in `cursor/lynx-smart-title-local`. Cap `requestSessionSmartTitle` spirit: `requestLynxSessionSmartTitle` GET `/session/:id` then PATCH merged `metadata.openchamber.titleRefresh.requestedAt` (preserve titleRefresh fields + `lastAutoTitle`); wired into SessionsSheet + ProjectsHome rename overlays (Save + smart-title). Close after submit — do not wait for generation; Lynx honest inline/error label (no Cap toast lib). Real routes only — never fake-success. Deferred unchanged: Cap toast lib / bulk multi-select / `@dnd-kit` / MobileWindowMotion / iPad sidebar / host binders. Docs honesty: tip APK `lynx-v2-debug-7b2b88f` (release exists for tip `7b2b88f3`); product NOT DONE / 三关未齐 / not EXHAUSTED; 真机残差 empty; host-only unchanged.
48. ~~**Cap session tree archive/delete + hard-delete undo**~~ — 代码接上 in `cursor/lynx-tree-delete-undo-local`. Cap `MobileSessionsSheet` `collectSessionTreeIds` / `getParentId` + `deleteSessionsWithUndo` / `scheduleSessionDeletes` (~SESSION_DELETE_UNDO_MS 10s): Lynx tree archive/delete via `parentID` (root + descendants) with honest `archivedIds`/`failedIds`; portable delete schedule + undo banner (not Cap sonner/toast). Wired SessionsSheet + ProjectsHome menus. Real APIs only — never fake-success. Deferred leftovers: Cap toast lib (sonner) / bulk multi-select (desktop sidebar folders) / `@dnd-kit` / MobileWindowMotion / iPad. Docs honesty: tip `78a6ac535` / tip APK `lynx-v2-debug-78a6ac5` (release exists); product NOT DONE / 三关未齐 / not EXHAUSTED; 真机残差 empty; host-only unchanged.
49. ~~**Cap MobileProjectEditSurface parity**~~ — 代码接上 in `cursor/lynx-project-edit-surface-local`. Cap label+icon+color+iconImage discover/remove + worktree list delete + portable ↑/↓ reorder (no `@dnd-kit` / Cap toast): Lynx `updateLynxProjectMeta` / `loadLynxProjectMeta` / icon routes / Cap MQ `worktrees/order` (local-only honest when unavailable) + `LynxProjectEditSurface` via `LynxMobileResizableSheet`. Wired ProjectsHome + SessionsSheet `edit`. Real Cap/settings APIs only — unavailable when project not in settings; never fake-success. Deferred: Cap toast lib / `@dnd-kit` / MobileWindowMotion / iPad + host-only. Docs honesty: tip APK `lynx-v2-debug-ba47923` (release exists for tip `ba47923f`; was stale `78a6ac5`); product NOT DONE / 三关未齐 / not EXHAUSTED; 真机残差 empty; host-only unchanged.
50. ~~**Cap SessionsSheet header trailing newChat / newWorktree / addProject**~~ — 代码接上 in `cursor/lynx-sessions-trailing-local`. Cap `MobileSessionsSheet` `trailingActions`: `newChat` when projects exist → `onOpenDraft?.(directory)`; `newWorktree` when active project is git → `LynxCreateWorktreeDialog` / `setNewWorktreeProject`; `addProject` → `DirectoryExplorerSheet` (same as ProjectsHome). Pure helpers + Vitest in `sessionsSheet.ts`. Reuses `lynx.projects.chrome.addProject` / `menu.newWorktree`; adds `lynx.chat.sessionsSheet.newChat`. Deferred unchanged: Cap `@dnd-kit` / MobileWindowMotion / iPad / Cap toast / bulk / host-only. Docs honesty: tip `8f2df6d8` / published APK `lynx-v2-debug-8f2df6d` (do NOT invent newer APK for PR head); product NOT DONE / 三关未齐 / not EXHAUSTED; 真机残差 empty; host-only unchanged (Keychain/camera/IME/Pierre/WKWebView/Mode B/Share ext/iOS IPA/@dnd-kit/MobileWindowMotion/iPad/Cap toast).
51. ~~**Cap Assistant catalog menus + create/enable**~~ — 代码接上 in `cursor/lynx-assistant-catalog-menus-local`. Cap `MobileAssistantTab` long-press Edit/Delete + empty Create + disabled Enable: Lynx `createLynxAssistant` (POST) / `setLynxAssistantsEnabled` (PUT settings + expectedRevision) / `deleteLynxAssistant` (DELETE + expectedRevision); AssistantTab overflow/long-press → Settings assistants EntityEditor + `LynxCenteredDialog` delete; empty Create → Settings assistants; disabled Enable CTA → PUT then refresh; Settings AssistantsSettingsBody Create (resolve first provider/model → POST → open editor) + Enable when disabled. Portable inline/banner errors only (no Cap toast). Real APIs only — never fake-success. Deferred unchanged: Cap `@dnd-kit` / MobileWindowMotion / iPad / Cap toast / bulk / host-only. Docs honesty: tip `c1bb93c4` / published APK `lynx-v2-debug-c1bb93c` (release exists for tip; do NOT invent newer APK for PR head); product NOT DONE / 三关未齐 / not EXHAUSTED; 真机残差 empty; host-only unchanged (Keychain/camera/IME/Pierre/WKWebView/Mode B/Share ext/iOS IPA/@dnd-kit/MobileWindowMotion/iPad/Cap toast).
52. ~~**Cap ProjectsHome per-bucket Show more**~~ — 代码接上 in `cursor/lynx-projects-home-show-more-local`. Cap `visibleCountByBucket` default 3 / +7 Show more per project/worktree bucket: reuse SessionsSheet `sliceLynxSessionsSheetVisible` / `nextLynxSessionsSheetVisibleCount` / `collapseLynxSessionsSheetVisibleCount` + `lynxProjectsHomeBucketKey` (`projectId::worktreeId`); Show more / Show fewer on each worktree group (SessionsSheet already had flat 3/+7). Search uses full catalog (Cap `catalogSessions` spirit) — compact slice / Show more skipped while searching. Deferred unchanged: Cap `@dnd-kit` / MobileWindowMotion / iPad / Cap toast / bulk / host binders. Docs honesty: tip `cfed15657` / published APK `lynx-v2-debug-cfed156` (release exists for tip; was stale `c1bb93c`; do NOT invent newer APK for PR head); product NOT DONE / 三关未齐 / not EXHAUSTED; 真机残差 empty; host-only unchanged.

53. ~~**Android cssVar hex paint + strict smoke text=**~~ — 代码接上 in `cursor/lynx-first-paint-visible-smoke`. Yee 真机 有字无样式: `cssVar()` no longer emits `var(--name, #hex)` (Android drops those inline values); returns Flexoki-light hex. ConnectWelcome done-phase cream/elevated/primary plain hex + brand `OpenChamber Lynx`. Host TextView splash overlay for smoke. Strict `lynx-android-emulator-smoke.sh` requires literal `text=` (false-green content-desc/splash-log fixed). **三关: 真机过 still open** until Yee confirms. Product NOT DONE / 三关未齐 / not EXHAUSTED.

54. ~~**Cap MCP sheet live status + connect/disconnect**~~ — 代码接上 in `cursor/lynx-mcp-sheet-connect-local`. Cap `McpDropdownContent` / `useMcpStore`: Lynx chat MCP sheet loads `GET /mcp` status ∪ `/api/config/mcp` configs; status disc + Cap Switch ON/OFF → `POST /mcp/{name}/connect|disconnect`; refresh; honest failure (never fake-success). `needs_auth` labeled (OAuth system browser stays host-only). Deferred unchanged: Cap `@dnd-kit` / MobileWindowMotion / iPad / Cap toast / bulk / host binders. Docs honesty: tip `7c5a135a` / published APK `lynx-v2-debug-7c5a135` (release exists for tip; do NOT invent newer APK for PR head); product NOT DONE / 三关未齐 / not EXHAUSTED; 真机残差 keeps Connect welcome style confirmation open for Yee.


Do not invent ASR / Bonjour / Capgo / TanStack 1.18. Share / Live Activity / widgets stay later.

---

## 真机残差

**Open (2026-09-09):** Connect welcome **style** on Yee device — tip `a16c3f7` / `lynx-v2-debug-cfed156` showed 有字无样式 (black text, no elevated cards / primary / cream separation). Fixed in `cursor/lynx-first-paint-visible-smoke` (`cssVar` → hex; strict smoke). **真机过 still open** until Yee confirms cream + elevated + primary orange on a build from that branch. Emulator smoke false-green (content-desc / splash log) is fixed in script; local emu verification may still be pending.

Empty for other landed claims. Seed the **kinds** of residual this track must expect (from Cap + Flutter history):

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
| `git` | 代码接上 (wired gitmoji + GitIdentity* editor) | gitmoji toggle; identities list/create/update/delete via `/api/git/identities` (no fake-success) |
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
| `voice` | 代码接上 (status + model download/delete UI via `/api/dictation/*`) | Cap STT model rows + optional Kokoro `ttsModels`; mic/WS ASR host-bound — no invented ASR |
| `about` | 代码接上 (wired + diagnostics export) | Lynx client version **separate** from `/api/system/info`; `openchamber.client-diagnostics.v1` export |

---



## 代码接上 (host bridge deepen + git identities + HTML/Pierre stubs + draft `/` `@` — not landed under 三关)

Slice on `cursor/lynx-linux-gaps-local` (PR into `work/lynx-native`). Package Vitest + `tsc` + rspeedy. Track CI: `.github/workflows/lynx-ci.yml` + `lynx-mobile-ci.yml` are **live** on tip (historical slices predated install). 真机过: not executed. Product **NOT DONE**.

| Item | Cap/web source | Lynx note |
|---|---|---|
| Host HTTP client | Cap runtimeFetch / URLSession·OkHttp | `src/host/httpClient.ts` + iOS URLSession / Android OkHttp stubs |
| Secure store Keychain/Keystore | `@aparajita/capacitor-secure-storage` | `secureStore.ts` + SecItem / EncryptedSharedPreferences API shapes; bounded timeout; never log tokens |
| Camera QR → pairing callback | `mobileQrScan.ts` | Bridge `scanPairingQr` → `qrScanResult` → Lynx parse; adapter unavailable without host |
| IME inset publisher | native composer keyboard | `imeInset.ts` + host keyboard observers → `keyboardInset` / `imeInset` |
| OAuth browser | ASWebAuthenticationSession / Custom Tabs | `oauthBrowser.ts` + iOS/Android launcher stubs with clear inject points |
| Host message channel | Cap plugin call/listen | `hostChannel.ts` Cap-plugin method list; wires adapters |
| Virtual asset scheme handlers | `openchamber-asset://` | Scheme registry + iOS/Android handler stubs (`registerSchemeHandler`) |
| Autocomplete ABOVE glass | Cap `OpenChamberComposerAutocomplete` | `composerAutocompleteLayout` + `ComposerAutocompleteList`; ChatScreen + DraftComposer |
| DraftComposer `/` `@` catalogs | ChatScreen composerCatalog | Same load/detect/suggest/apply path as chat |
| Settings git identities | Cap GitIdentity* `/api/git/identities` | List/create/update/delete + global read; never fake-success |
| Files HTML preview | `MobileFilesSurface` iframe | Cap-like source/preview toggle; preview = honest host WebView stub + text source |
| PierreDiff polish | `PierreDiffViewer` | Portable line-kind/stats + Cap ChangeRow spacing 代码接上; Cap `@pierre/diffs` **unavailable** (honest blocker, not stub-faked) |

**CI绿:** lynx-ci live on tip. Local Vitest `@openchamber/lynx` also. Not 真机过.
**真机过:** not executed (environment: Linux cloud VM).

---

## 代码接上 (composer actions in glass — not landed under 三关)

Slice on `cursor/lynx-composer-actions-in-glass-local` (PR into `work/lynx-native`). Package Vitest + `tsc` + rspeedy. 真机过: not executed. Product **NOT DONE**.

| Item | Cap/web source | Lynx note |
|---|---|---|
| Attach / Send / Stop / Queue inside glass | Cap `OpenChamberComposer` contentView chrome | Controls moved **into** `LynxComposerGlassCard` (Chat + Draft). No action row sibling below glass. |
| Cap pill vs card order | collapsed `+`·input·Send/Stop; expanded `+`·spacer·Agent·model·Send/Stop | `resolveLynxComposerInGlassActionOrder` + `LynxComposerActionsInGlass`; Chat collapses when draft empty |
| Autocomplete ABOVE glass preserved | Cap autocomplete sibling | Still `forbidInsideGlassContentView`; list never nested under composer GlassChrome |

**CI绿:** lynx-ci live on tip + local Vitest/`tsc`/rspeedy. Not 真机过.
**真机过:** not executed (Linux cloud VM). Host Mode B composer overlay / live UIGlassEffect still residual. Agent·model picker sheets → next slice.

---

## 代码接上 (composer Agent·model picker sheets — not landed under 三关)

Slice on `cursor/lynx-agent-model-picker-local` (PR into `work/lynx-native`). Package Vitest + `tsc` + rspeedy. 真机过: not executed. Product **NOT DONE**.

| Item | Cap/web source | Lynx note |
|---|---|---|
| Agent picker sheet | Cap `AgentSelector` + `MobileResizableSheet` → `GET /api/agent` | `LynxComposerPickerSheets` kind=agent; Chat expanded footer + Draft expanded card open overlay; clear = not-selected |
| Model picker sheet | Cap `MobileModelPickerPanel` → `/api/config/providers` | Same overlay kind=model; id `providerID/modelID` |
| Selection → session send | Cap selection store + `prompt_async` body | Updates composer `LynxComposerModel` used by send/queue (no separate session PATCH; Cap same) |
| Autocomplete ABOVE glass preserved | Cap autocomplete sibling | Sheets outside GlassChrome; list never nested under composer contentView |

**CI绿:** lynx-ci live; Android sideload APK live on tip. Not 真机过 / no iOS IPA.
**真机过:** not executed (Linux cloud VM). Host Mode B composer overlay / live UIGlassEffect still residual.

---

## 代码接上 (resizable picker sheets + Draft Stop abort — not landed under 三关)

Slice on `cursor/lynx-resizable-picker-sheets-local` (PR into `work/lynx-native`). Package Vitest + `tsc` + rspeedy. 真机过: not executed. Product **NOT DONE**.

| Item | Cap/web source | Lynx note |
|---|---|---|
| Half-height MobileResizableSheet | Cap `MobileResizableSheet` + snap grabber | `LynxMobileResizableSheet`: grabber, Cap-aligned **0.72 / 0.98** (~72%/98% / 72dvh/98dvh) bottom sheet, scrim + vertical-drag dismiss — **replaces** full-screen `surface.background` picker overlay |
| Picker + explorer reuse | Agent/model pickers; DirectoryExplorer | Composer pickers mount on shared sheet; DirectoryExplorer reused cheaply |
| Draft busy Stop = abort | Cap Chat composerActions.stop / `POST …/abort` | When Draft `busy`, Stop aborts materialize + `abortSession` — never re-send |
| Glass / autocomplete | Cap autocomplete sibling | Triggers stay in-glass; sheets outside; autocomplete ABOVE glass |

**CI绿:** lynx-ci live; Android sideload APK live on tip. Not 真机过 / no iOS IPA.
**真机过:** not executed (Linux cloud VM). Live drag feel / Mode B overlay / UIGlassEffect still residual.

## 代码接上 (composer GlassChrome — not landed under 三关)

Slice on `cursor/lynx-composer-glass-local` (PR into `work/lynx-native`). Package Vitest + `tsc` + rspeedy. 真机过: not executed. Product **NOT DONE**.

| Item | Cap/web source | Lynx note |
|---|---|---|
| Composer GlassChrome / blur-view | Cap `OpenChamberComposer` UIGlassEffect | `LynxComposerGlassCard` on Chat + Draft; iOS glass / glass-interactive; Android blur-radius; no elevated solid fill |
| Autocomplete sibling ABOVE glass | Cap `OpenChamberComposerAutocomplete` | `forbidInsideGlassContentView` remains true; list never nested under composer GlassChrome |
| Optional autocomplete glass chips | Cap search-chip spirit | Per-row `searchChip` GlassChrome **in sibling list tree only** (not composer contentView) |

**CI绿:** lynx-ci live on tip + local Vitest/`tsc`/rspeedy. Not 真机过.
**真机过:** not executed (Linux cloud VM). Host Mode B composer overlay / live UIGlassEffect paint still residual.

---

## 代码接上 (linux closable after #55: portable diff + stage/unstage + rename — not landed under 三关)

Slice on `cursor/lynx-linux-closable-after-55-local` (PR into `work/lynx-native`). Package Vitest + `tsc` + rspeedy. 真机过: not executed. Product **NOT DONE**.

| Item | Cap/web source | Lynx note |
|---|---|---|
| Cap sheet height docs hygiene | `MobileResizableSheet` 72/98dvh | Next #23 for PR#55; replace stale ~50%/92% with **0.72 / 0.98** |
| Portable text diff | Cap Changes + PierreDiffViewer data | `parseLynxUnifiedDiffLines` / stats / line tokens in Changes detail — **not** `@pierre/diffs` runtime |
| Stage / unstage | `stageGitFiles` / `unstageGitFiles` → `POST /api/git/stage\|unstage` | Changes row chips; failure ≠ fake-success |
| Projects rename | Cap session menu rename → `PATCH /session/:id` | Long-press → draft input → `renameLynxSession` |

**CI绿:** lynx-ci live; Android sideload APK live on tip. Not 真机过 / no iOS IPA.
**真机过:** not executed (Linux cloud VM). Host Mode B / Pierre runtime / WKWebView / Keychain / camera / IME still residual.

---

## 代码接上 (diff/chip polish on #56 — not landed under 三关)

Slice on `cursor/lynx-diff-chip-polish-local` (PR into `work/lynx-native`). Package Vitest + `tsc` + rspeedy. 真机过: not executed. Product **NOT DONE**.

| Item | Cap/web source | Lynx note |
|---|---|---|
| Diff add/del coloring | Cap ChangeRow `--status-success` / `--status-error` | Portable lines: **add→status.success**, **del→status.error**; hunk/meta stay `surface.mutedForeground` (del ≠ muted). Still **not** `@pierre/diffs`. |
| Stage/unstage glass chips | Cap ChangeRow +/- + searchChip spirit | `GlassChrome` `searchChip`-sized +/- chips on Changes rows (outside transcript glass rules). Host absent → elevated fallback. |

**CI绿:** lynx-ci live; Android sideload APK live on tip. Not 真机过 / no iOS IPA.
**真机过:** not executed (Linux cloud VM). Pierre runtime / Mode B / live UIGlassEffect still residual.

---

## 代码接上 (Pierre investigation + ChangeRow spacing on #57 tip — not landed under 三关)

Slice on `cursor/lynx-pierre-diffs-local` (base PR#57 tip `858e6d0bb`; PR into `work/lynx-native`). Package Vitest + `tsc` + rspeedy. 真机过: not executed. Product **NOT DONE**.

| Item | Cap/web source | Lynx note |
|---|---|---|
| Cap `@pierre/diffs` | `PierreDiffViewer` → `FileDiff` / `diffs-container` Shadow DOM + `PIERRE_RUNTIME_BASE_CSS` + worker | **Unavailable** in Lynx. `resolveLynxPierreDiffFeature({ preferPierre: true })` still activates **portable-text** and records `LYNX_PIERRE_DIFF_BLOCKERS`. No fake CSS/iframe. |
| Portable feature path | Cap git `file-diff` / `diff` text | Unchanged real APIs; monospace line colors + Cap `+n / -m` slash spacing. |
| ChangeRow chip spacing | Cap `ChangeRow`: `size-6` / `gap-1.5` / `mx-0.5` / `h-8` / `w-3.5` | `LYNX_CHANGE_ROW_SPACING` + stage chip **24px** (was ~32), status letter, Cap slash stats; `diffStats` from `GET /api/git/status`. |

**CI绿:** lynx-ci live; Android sideload APK live on tip. Not 真机过 / no iOS IPA.
**真机过:** not executed. Host WebView sheet would be required before any Pierre HTML mount — out of scope / not claimed.

---


## 代码接上 (Changes revert + generateCommitMessage + commitAndPush — not landed under 三关)

Slice on `cursor/lynx-changes-revert-commitmsg-local` (PR into `work/lynx-native`). Package Vitest + `tsc` + rspeedy. Track CI: `.github/workflows/lynx-ci.yml` + `lynx-mobile-ci.yml` are **live** on tip (historical slices predated install). 真机过: not executed.

| Item | Cap/web source | Lynx note |
|---|---|---|
| Revert file / bulk | `MobileChangesSurface` → `POST /api/git/revert` | `revertLynxGitFile` / `revertLynxGitFiles`; row Revert chip. Failure ≠ fake-success. |
| generateCommitMessage | Cap `gitApi.generateCommitMessage` → `POST /api/small-model/generate` | Cap-default commit magic prompt text + diff collect via `/api/git/diff`. No Cap session-fallback; dead `/api/git/commit-message` unused. |
| commitAndPush | Cap `handleCommit({ pushAfter: true })` | `commitAndPushLynxGitChanges` commit→push. Cap fetch/pull-if-behind completed in Next #28. |

**CI绿:** lynx-ci live on tip. Local Vitest `@openchamber/lynx` also. Not 真机过.
**真机过:** not executed.

---

## 代码接上 (Changes revert glass + Cap confirm + pull-if-behind on #59 tip — not landed under 三关)

Slice on `cursor/lynx-revert-confirm-pull-local` (base PR#59 tip `778c844ae`; PR into `work/lynx-native`). Package Vitest + `tsc` + rspeedy. 真机过: not executed. Product **NOT DONE**.

| Item | Cap/web source | Lynx note |
|---|---|---|
| Revert GlassChrome chip | Cap ChangeRow `arrow-go-back` size-6 | `RevertGlassChip` = GlassChrome `searchChip` + Cap `arrow-go-back` unicode ↩ (same size as stage +/−); not plain ActionChip text. |
| Cap confirm before revert | Cap ChangesPanel Dialog (revert-all / directory) | Was elevated-in-sheet card in #28; **centered Dialog** (scrim+panel) in Next #29. Cap does **not** confirm commit&push — not added. |
| pull-if-behind on commit&push | Cap `handleCommit({ pushAfter: true })` | Parse status `ahead`/`behind`/`tracking`; commit→fetch→pull(rebase) if behind→push if ahead. Failure ≠ silent skip. |

**CI绿:** lynx-ci live; Android sideload APK live on tip. Not 真机过 / no iOS IPA.
**真机过:** not executed.

---

## 代码接上 (Centered Cap Dialog revert confirm on #60 tip — not landed under 三关)

Slice on `cursor/lynx-centered-confirm-dialog-local` (base PR#60 tip `ac8cfd793`; PR into `work/lynx-native`). Package Vitest + `tsc` + rspeedy. 真机过: not executed. Product **NOT DONE**.

| Item | Cap/web source | Lynx note |
|---|---|---|
| Cap centered Dialog | Cap `Dialog` / `DialogContent` (scrim + centered `max-w-md`) | `LynxCenteredDialog` replaces elevated-in-sheet revert confirm card. Scrim dismiss when not busy; Cancel + destructive Revert footer. Follow-on #30 moves mount to shell-root portal. |
| RevertGlassChip + pull-if-behind | unchanged from #28 | Keep glass Cap `arrow-go-back` ↩ chip + commit→fetch→pull-if-behind→push. |

**CI绿:** lynx-ci live; Android sideload APK live on tip. Not 真机过 / no iOS IPA.
**真机过:** not executed.

---

## 代码接上 (Dialog shell portal + theme onError + Cap arrow-go-back on #61 tip — not landed under 三关)

Slice on `cursor/lynx-dialog-portal-theme-local` (base PR#61 tip `7a4c7b6a8`; PR into `work/lynx-native`). Package Vitest + `tsc` + rspeedy. 真机过: not executed. Product **NOT DONE**.

| Item | Cap/web source | Lynx note |
|---|---|---|
| Shell-root DialogPortal | Cap `DialogPortal` → document body | `LynxShellDialogPortalProvider` + `LynxDialogPortal` host at `LynxShellApp` root — **full-screen overlay**; not nested absolute inside Changes `position:relative`. |
| Destructive tokens | Cap Button destructive / `--destructive-foreground` | Fill `status.error`; text `status.onError` → `--destructive-foreground` (never hardcoded `#fff`). |
| Revert chip glyph | Cap Icon `arrow-go-back` sprite | `LYNX_CAP_ARROW_GO_BACK_GLYPH` = ↩ (U+21A9). Cap SVG sprite needs DOM — unavailable on Lynx; no invented brand. |

**CI绿:** lynx-ci live; Android sideload APK live on tip. Not 真机过 / no iOS IPA.
**真机过:** not executed.


## Remaining (honest — not EXHAUSTED)

**Product NOT DONE / 三关未齐 / not EXHAUSTED.** Linux Cap product rows continue to close on tip `7c5a135a9` + follow-ons (connect/settings/chat/projects/changes + Android first-paint #65–#69 + Cap phone overflow **new-session** in Next #32 + Voice model download/delete UI in Next #33 + Voice STT select + Changes dirty badge in Next #34 + PermissionCard metadata + permission auto-accept in Next #35 + Cap share-recipient picker in Next #36 + Projects menus/share in Next #37 + QueuedMessageChips + SessionGoalRow in Next #38 + MobileSessionStatusBar slim strip in Next #39 + SessionGoal create/manage dialog in Next #40 + Cap server message-queue client in Next #41 + Cap full sessions sheet in Next #42 + worktree create/delete dialogs in Next #43 + Cap deleteRemoteBranch on worktree delete in Next #44 + Cap SessionsSheet two-step archive + unarchive undo in Next #45 + Cap ArchivedSessionsDialog in Next #46 + Cap session rename smart-title in Next #47 + Cap session tree archive/delete + hard-delete undo in Next #48 + Cap MobileProjectEditSurface in Next #49 + Cap SessionsSheet header trailing actions in Next #50 + Cap Assistant catalog menus + create/enable in Next #51 + Cap ProjectsHome per-bucket Show more in Next #52 + Android cssVar hex + strict smoke in Next #53 + Cap MCP sheet status/connect in Next #54). Queue chips + SessionGoal row/dialog + slim session status bar + server MQ client + full sessions sheet + worktree dialogs + remote-branch delete + archive/undo + ArchivedSessionsDialog + smart-title + tree delete/undo + MobileProjectEditSurface + SessionsSheet trailing + Assistant catalog menus + ProjectsHome per-bucket Show more + MCP sheet connect JS 代码接上 in #38–#54. Remaining Cap-parity polish is thin (Cap `@dnd-kit` / MobileWindowMotion / iPad sidebar; Cap toast lib / bulk multi-select deferred); **host binders / HTML WKWebView / Pierre `@pierre/diffs` (honest DOM blocker — not ported) / Live Activity / iOS IPA / Share extension + ShareReceiverActivity / clipboard host / 真机** still block EXHAUSTED. **Do not** mark landed under 三关. 真机残差: Connect welcome **style** confirmation still open for Yee (host/device — not Linux code); other claims empty. Tip APK honesty relative to tip: `lynx-v2-debug-7c5a135` — release exists for tip `7c5a135a9` (was stale `cfed156`; do NOT invent newer APK for this PR head); host-only unchanged (Keychain/camera/IME/Pierre/WKWebView/Mode B/Share ext/iOS IPA/@dnd-kit/MobileWindowMotion/iPad/Cap toast).

### 代码接上 prior slice (`cursor/lynx-closable-missing-local` / PR#48)

| Item | Notes |
|---|---|
| Host Xcode/Gradle scaffold + bridge stubs | `packages/lynx/host/**` + README run steps; SDK pods/AAR still unresolved on Linux |
| `.github/workflows/lynx-ci.yml` + `lynx-mobile-ci.yml` | **Live** on tip (lynx-ci green; Android sideload APK green; prerelease `lynx-v2-debug-b170e47`). Template copy under `packages/lynx/ci/` remains for reference. |
| Projects DirectoryExplorer | `/api/fs/home` + `/api/fs/list` + settings `projects[]` add |
| 扫一扫 / 切换实例 chrome | Camera adapter honest `unavailable`; instances → secondary nav |
| Composer `/` `@` agent/model | Cap commands/agents/magic-prompts + `/api/config/providers` models |
| Assistant continuous/stateless admission | `POST …/assistants/:id/messages` — no invented ASR |
| Settings Voice | `/api/dictation/status` + STT select PUT `sttLocalModel` (Next #34) + model download/delete **UI** (Next #33); mic/WS host-bound |
| About diagnostics export | `openchamber.client-diagnostics.v1` local ring buffer |
| `openchamber-asset://` hooks | TS + iOS/Android stub resolvers |
| Predictive / edge-back contract | JS policy + host stubs + wiring notes |

### 代码接上 prior slice (`cursor/lynx-linux-gaps-local`)

| Item | Notes |
|---|---|
| Settings GitIdentity* editor | Real `/api/git/identities` list/create/update/delete (+ global read); no fake-success |
| Files HTML preview | Cap iframe → Lynx labeled text stub + `planLynxHtmlPreview` until host WKWebView sheet |
| DraftComposer `/` `@` catalogs | Same `loadLynxComposerCatalogs` path as ChatScreen |
| Autocomplete above glass | `LynxComposerAutocompleteList` sibling overlay; `forbidInsideGlassContentView`; documented in imeOccupancy + ia-ui |
| Host-bridge deepen | secureStore / httpClient / oauthBrowser / imeInset / hostChannel + iOS/Android stubs |
| Gap-board Missing strikethrough | PR#48 DirectoryExplorer / 扫一扫 / composer `/` `@` / admission / diagnostics / assets / predictive-back |

### 代码接上 prior slice (`cursor/lynx-composer-glass-local`)

| Item | Notes |
|---|---|
| Composer GlassChrome | `LynxComposerGlassCard` replaces elevated solid fill on Chat + Draft; iOS glass/interactive; Android blur-radius |
| Autocomplete ABOVE glass preserved | List stays sibling; `forbidInsideGlassContentView=true`; optional row `searchChip` only in sibling tree |
| Docs honesty | ia-ui + gap-board mark 代码接上 / not 真机过 / NOT DONE |

### 代码接上 prior slice (`cursor/lynx-composer-actions-in-glass-local`)

| Item | Notes |
|---|---|
| Actions inside glass | Chat Attach/Send/Stop/Queue moved into `LynxComposerGlassCard`; Draft keeps Send (+ Attach stub) inside pill |
| Cap order | Collapsed pill `+`·input·Send/Stop; expanded card footer `+`·spacer·Agent·model·Send/Stop (± Queue while working) |
| Autocomplete ABOVE glass | Unchanged sibling; never GlassChrome contentView child |
| Docs honesty | ia-ui + gap-board mark 代码接上 / not 真机过 / NOT DONE |

### 代码接上 prior slice (`cursor/lynx-agent-model-picker-local`)

| Item | Notes |
|---|---|
| Agent picker sheet | Cap MobileResizableSheet spirit; lists `GET /api/agent`; Chat + Draft expanded Agent button |
| Model picker sheet | Lists `/api/config/providers` models; Chat + Draft expanded model button |
| Selection updates composer | `LynxComposerModel` → `prompt_async` agent/provider/model (Cap selection-store spirit; no invent PATCH) |
| Glass / autocomplete | Triggers stay in-glass; sheets + autocomplete stay outside / ABOVE glass |
| Docs honesty | ia-ui + gap-board mark 代码接上 / not 真机过 / NOT DONE |

### 代码接上 prior slice (`cursor/lynx-resizable-picker-sheets-local`)

| Item | Notes |
|---|---|
| Half-height resizable sheet | `LynxMobileResizableSheet`: grabber, Cap **0.72 / 0.98** (~72dvh / ~98dvh) bottom sheet, scrim + vertical-drag dismiss — not full-screen `surface.background` |
| Picker / explorer reuse | Agent·model pickers + DirectoryExplorer mount on shared sheet |
| Draft busy Stop = abort | Stop aborts materialize / `abortSession` (Chat composerActions alignment) — never re-send |
| Glass / autocomplete | Triggers in-glass; sheets outside; autocomplete ABOVE glass |
| Docs honesty | ia-ui + gap-board mark 代码接上 / not 真机过 / NOT DONE |

### 代码接上 prior slice (`cursor/lynx-sheet-height-cap-local` / PR#55)

| Item | Notes |
|---|---|
| Cap sheet height snaps | half **0.72** / expanded **0.98** (~72dvh / ~98dvh); grabber / dismiss / outside-glass unchanged |
| Docs honesty | Next #23; stale ~50%/92% notes replaced; NOT DONE / 三关未齐 |

### 代码接上 prior slice (`cursor/lynx-linux-closable-after-55-local` / PR#56)

| Item | Notes |
|---|---|
| Portable text diff | Unified line kinds + insertions/deletions stats + semantic line colors in Changes detail; Cap `@pierre/diffs` remains stub |
| Cap stage / unstage | `POST /api/git/stage` + `/api/git/unstage` on Changes rows; failure ≠ fake-success |
| Projects session rename | Long-press → rename draft → `PATCH /session/:id` (`renameLynxSession`) |
| Docs honesty | ia-ui + gap-board mark 代码接上 / not 真机过 / NOT DONE |

### 代码接上 prior slice (`cursor/lynx-diff-chip-polish-local` / PR#57)

| Item | Notes |
|---|---|
| Diff add/del tokens | Cap `--status-success` / `--status-error` on portable lines; del distinguished from hunk/muted |
| Stage/unstage glass chips | Cap +/- on `GlassChrome` `searchChip` (Changes sheet only; outside transcript) |
| Docs honesty | ia-ui + gap-board mark 代码接上 / not 真机过 / NOT DONE |

### 代码接上 this slice (`cursor/lynx-pierre-diffs-local`)

| Item | Notes |
|---|---|
| Pierre investigation | Cap `@pierre/diffs@1.3.0-beta.6` in monorepo (`packages/ui`); Lynx **cannot** host — Shadow DOM / react-dom / worker blockers documented |
| Feature path | `resolveLynxPierreDiffFeature` + `preferPierre` → always portable-text; `pierreViewer: 'unavailable'` |
| ChangeRow spacing | Cap-measurable `LYNX_CHANGE_ROW_SPACING`; stage chip 24px; `+n / -m` slash; status letter; status `diffStats` |
| Docs honesty | ia-ui + gap-board mark 代码接上 / not 真机过 / NOT DONE |

### 代码接上 prior slice (`cursor/lynx-changes-revert-commitmsg-local` / Next #27)

| Item | Notes |
|---|---|
| Cap revert file / bulk | `POST /api/git/revert` via `revertLynxGitFile` / `revertLynxGitFiles`; Changes row Revert chip; failure ≠ fake-success |
| Cap generateCommitMessage | Cap mobile path `POST /api/small-model/generate` purpose `commit` + Cap-default magic prompt text + `/api/git/diff` collect; parse subject/highlights. Session-fallback / dead `/api/git/commit-message` **not** ported |
| Cap commitAndPush | `commitAndPushLynxGitChanges` = commit → push (pull-if-behind completed in Next #28); Changes Commit & Push chip |
| Docs honesty | ia-ui unchanged; gap-board Next #27; NOT DONE / 三关未齐 |

### 代码接上 prior slice (`cursor/lynx-revert-confirm-pull-local` / Next #28)

| Item | Notes |
|---|---|
| Revert GlassChrome searchChip | Cap ChangeRow icon size-6 → Lynx `RevertGlassChip` ↩ on GlassChrome `searchChip` (same as stage +/−); not ActionChip text |
| Cap confirm dialog before revert | Cap ChangesPanel Dialog spirit (initially elevated-in-sheet card; replaced by centered modal in #29). Cap does **not** confirm commit&push — omitted honestly |
| Cap pull-if-behind | Parse `ahead`/`behind`/`tracking` from `GET /api/git/status`; commit→fetch→pull(rebase) if behind→push if ahead; failure ≠ silent skip |
| Docs honesty | gap-board Next #28; NOT DONE / 三关未齐 |

### 代码接上 prior slice (`cursor/lynx-centered-confirm-dialog-local` / Next #29)

| Item | Notes |
|---|---|
| Cap centered Dialog confirm | `LynxCenteredDialog`: scrim (`bg-black/50` spirit) + flex-centered `max-w-md` panel — **not** elevated-in-sheet card, **not** MobileResizableSheet half-card |
| RevertGlassChip + pull-if-behind preserved | Unchanged from #28; confirm opens centered modal before `POST /api/git/revert` |
| Cap does not confirm commit&push | Still omitted honestly |
| Docs honesty | gap-board Next #29; NOT DONE / 三关未齐 / no 真机过 |

### 代码接上 this slice (`cursor/lynx-dialog-portal-theme-local` / Next #30)

| Item | Notes |
|---|---|
| Shell-root portal mount | `LynxDialogPortal` → `LynxShellDialogPortalProvider` host on `LynxShellApp` — full-screen overlay (Cap DialogPortal); **not** nested in Changes relative |
| Destructive theme tokens | `status.error` fill + `status.onError` (`--destructive-foreground`) text — never `#fff` |
| Cap arrow-go-back glyph | `LYNX_CAP_ARROW_GO_BACK_GLYPH` ↩ from Cap Icon `arrow-go-back`; Cap SVG sprite DOM-blocked on Lynx |
| Docs honesty | gap-board Next #30; NOT DONE / 三关未齐 / no 真机过 |

### 代码接上 this slice (Android first-paint + live CI honesty / Next #31)

| Item | Notes |
|---|---|
| Flexoki-light token paint | `LYNX_LIGHT_FALLBACKS` + `cssVar(token)` / `tokenColor()` → **resolved `#hex`** (never `var(--name, #hex)` — Android Lynx drops those inline values → 有字无样式). Cap CSS var *names* remain in `LYNX_TOKEN_CSS_VARS` for docs. |
| Android cream windowBackground | `themes.xml` / `colors.xml` `lynx_window_background` `#fffdf4`; nav bar softened (not pure black void) |
| HostActivity + ViewFactory globalProps | MATCH_PARENT LynxView; `globalProps` → `updateGlobalProps` + `TemplateData`; App reads `lynx.__globalProps` |
| ConnectWelcome first paint | Splash + done-phase use plain hex cream/elevated/primary; brand `OpenChamber Lynx` text; host TextView overlay until first_screen+20s |
| Strict emulator smoke | `scripts/lynx-android-emulator-smoke.sh` requires literal `text="Connecting` / `text="OpenChamber Lynx` — **not** content-desc alone, **not** splash console.log (false-green on cfed156 fixed) |
| Live CI | `.github/workflows/lynx-ci.yml` + `lynx-mobile-ci.yml` live |
| Docs honesty | NOT DONE / 三关未齐 / not EXHAUSTED / **真机过 still open** until Yee confirms styled welcome |

### 代码接上 this slice (`cursor/lynx-overflow-new-session-local` / Next #32)

| Item | Notes |
|---|---|
| Cap phone overflow new-session | First overflow item → shell `openDraft` / `LynxDraftComposer` (Cap `mobile.menu.newSession`) |
| Overflow order | Cap phone: new-session · Files · Changes · MCP · refresh (no Capgo update; no iPad Settings) |
| Docs honesty | Tip SHA / APK `lynx-v2-debug-b170e47`; Next #31 notes #67 TextDecoder / #68 page+splash / #69 no-explicit-page |
| Docs honesty | NOT DONE / 三关未齐 / not EXHAUSTED / 真机残差 empty / no 真机过 claim |

### 代码接上 this slice (`cursor/lynx-voice-models-download-local` / Next #33)

| Item | Notes |
|---|---|
| Voice model rows | Cap STT list from status `models` + Download/progress/Delete via existing helpers |
| Kokoro TTS row | When `ttsModels` includes `kokoro-en-v0_19`, show Local TTS row (same routes) |
| No invented ASR | Policy banner + `LYNX_DICTATION_VOICE_POLICY`; mic/WS host-bound |
| Docs honesty | Tip SHA / APK `lynx-v2-debug-b170e47` (was stale `30b1c12`); Voice missing struck; Next #33 |
| Docs honesty | NOT DONE / 三关未齐 / not EXHAUSTED / 真机残差 empty / no 真机过 claim |


### 代码接上 this slice (`cursor/lynx-voice-select-dirty-badge-local` / Next #34)

| Item | Notes |
|---|---|
| Voice STT model select | Cap `LOCAL_STT_MODELS` radio → `PUT /api/config/settings` `{ sttLocalModel }`; status refresh with `localModel` |
| Optional dictationEnabled | Cap Voice enable toggle via same settings blob when types fit |
| Keep #71 download/delete | Progress/delete unchanged; no invented ASR/mic/WS |
| Preview / browser TTS / say | Labeled unavailable — no invented audio |
| Overflow Changes dirty badge | Cap `dirtyChangeCount` from git status `entries.length` when ok; no-runtime/failure → no fake badge |
| Docs honesty | Tip SHA / APK `lynx-v2-debug-b170e47` (was stale `1a5c899`); Next #34 |
| Docs honesty | NOT DONE / 三关未齐 / not EXHAUSTED / 真机残差 empty / no 真机过 claim |

### 代码接上 this slice (`cursor/lynx-permission-metadata-auto-accept-local` / Next #35)

| Item | Notes |
|---|---|
| PermissionCard metadata | Cap `PermissionCard` + `types/permission.ts` `metadata`; Lynx `formatLynxPermissionMetadataLines` → plain text bash/edit/write/webfetch/generic (no DOM/react-dom/WorkerHighlightedCode) |
| Permission auto-accept | Cap `GET/PUT /api/permission-auto-accept` + lineage `lynxAutoRespondsPermission` + composer/draft toggle + client auto-reply `once` when enabled; failure ≠ fake-success (server runtime remains authoritative) |
| Docs honesty | Tip SHA on this PR head; APK may still `lynx-v2-debug-b170e47` until mobile-ci — do not invent APK SHA; Next #35 |
| Docs honesty | NOT DONE / 三关未齐 / not EXHAUSTED / 真机残差 empty / no 真机过 claim |

### 代码接上 this slice (`cursor/lynx-share-recipient-picker-local` / Next #36)

| Item | Notes |
|---|---|
| Share draft Partial target | Cap `NativeShareDraft` + `isAssignedNativeShareDraft`; Lynx `shareDraft.ts` — never silent-default |
| Full-page recipient picker | Cap `MobileShareRecipientPicker` → `LynxShareRecipientPicker` via shell DialogPortal (**full-page overlay, never a sheet**); plain Lynx views (no react-dom Dialog) |
| Bridge wiring | Cap `MobileShareBridge` spirit: unassigned → picker; assigned → `dispatchAssignedDraft` → POST `…/assistants/:id/share`; cancel drops/acks without inventing success |
| Shell mount | `LynxShareBridge` inside `LynxShellDialogPortalProvider`; host injects drafts via `shareInbox.acceptDraft` |
| Host-only (separate) | iOS Share Extension / Android `ShareReceiverActivity` stay host-only — not claimed by this JS picker |
| Docs honesty | Tip APK `lynx-v2-debug-93b4355`; Next #36 |
| Docs honesty | NOT DONE / 三关未齐 / not EXHAUSTED / 真机残差 empty / no 真机过 claim |

### 代码接上 this slice (`cursor/lynx-projects-menus-share-local` / Next #37)

| Item | Notes |
|---|---|
| Project / worktree menus | Cap `MobileRowActionsSheet` spirit via `buildLynxProjectMenuItems` / `buildLynxWorktreeMenuItems` long-press on ProjectsHome cards |
| Session share / copy / unshare | Cap/OpenCode `POST|DELETE /session/:id/share`; never fake-success without `share.url`; copy uses navigator.clipboard when present else labeled unavailable |
| newSession | Project/worktree → `openDraft({ directory })` / DraftComposer materialize in that directory |
| syncSessions | Cap-style `POST /api/openchamber/session-index/sync` for project dirs; honest failure/unsupported |
| edit / closeProject | Settings `projects[]` meta via `/api/config/settings`; close confirm via `LynxCenteredDialog` portal; labeled unavailable when not in settings |
| newWorktree / deleteWorktree | Cap `/api/git/worktrees` create/delete; confirm delete via centered dialog; labeled unavailable on 404/501 |
| Docs honesty | Tip APK `lynx-v2-debug-0b470a2`; Next #37 |
| Docs honesty | NOT DONE / 三关未齐 / not EXHAUSTED / 真机残差 empty / no 真机过 claim |

### 代码接上 this slice (`cursor/lynx-queue-chips-goal-local` / Next #38)

| Item | Notes |
|---|---|
| QueuedMessageChips | Cap chips above composer; Lynx `LynxQueuedMessageChips` + `queuedMessageChips.ts` on local `composerActions` queue — remove / send-now / flush; portable ↑/↓ reorder (no `@dnd-kit`) |
| Server message-queue | Cap `/api/openchamber/message-queue` thin client 代码接上 in Next #41; TanStack/Zustand flights still deferred |
| SessionGoalRow | Cap compact strip; Lynx `sessionGoal.ts` + `LynxSessionGoalRow` via GET `/session/:id` metadata + PATCH status; file objective GET `/api/goals/objective/:id` when `objectiveFile`; never fake-success |
| MobileSessionStatusBar (full Cap sheet) | Slim strip 代码接上 in Next #39; **full** Cap sessions sheet 代码接上 in Next #42; worktree create/delete dialogs in Next #43; remote-branch delete in Next #44; two-step archive + unarchive undo in Next #45; ArchivedSessionsDialog in Next #46; smart-title in Next #47; Cap `@dnd-kit` / MobileWindowMotion / Cap toast lib / bulk multi-select still deferred |
| Docs honesty | Tip APK `lynx-v2-debug-905c42e`; Next #38 |
| Docs honesty | NOT DONE / 三关未齐 / not EXHAUSTED / 真机残差 empty / no 真机过 claim |

### 代码接上 this slice (`cursor/lynx-session-status-bar-local` / Next #39)

| Item | Notes |
|---|---|
| Slim MobileSessionStatusBar | Cap related-session chips + busy/working indicator above composer (with SessionGoal + queue); **not** full Cap sheet |
| Pure helpers | Cap `shouldPreserveActiveProjectOnSessionOpen` + `resolveMobileSessionSheetDefaultFilter`; status normalize; session-index related list |
| Shell wiring | session-index → relatedSessions / orderedSessionIds; chip tap → openChat; "All" → Projects home (honest Cap sheet analogue) |
| Deferred | Cap `@dnd-kit` / MobileWindowMotion / iPad sidebar (full sessions sheet in #42; worktree dialogs in #43; server MQ thin client in #41) |
| Docs honesty | Tip APK `lynx-v2-debug-ca32a72` (release exists); Next #39 |
| Docs honesty | NOT DONE / 三关未齐 / not EXHAUSTED / 真机残差 empty / no 真机过 claim |

### 代码接上 this slice (`cursor/lynx-session-goal-dialog-local` / Next #40)

| Item | Notes |
|---|---|
| set/clear helpers | Cap `setSessionGoal` / `clearSessionGoal` → `setLynxSessionGoal` / `clearLynxSessionGoal`; GET+PATCH metadata + PUT/DELETE `/api/goals/objective/:id`; never fake-success |
| SessionGoalDialog | Cap create/manage overlay via `LynxCenteredDialog` + shell `LynxDialogPortal`; objective + optional token budget; clear/save/start |
| Row + create entry | Row tap → manage dialog; create entry when no goal opens create dialog; Cap `/goal` arm toggle (never auto-send; arm applies on user Send) |
| Complete | Cap complete via existing `setLynxSessionGoalStatus('complete')` |
| Docs honesty | Tip `8def01d0` / APK `lynx-v2-debug-8def01d` (release exists); Next #40 |
| Docs honesty | NOT DONE / 三关未齐 / not EXHAUSTED / 真机残差 empty / no 真机过 claim |

### 代码接上 this slice (`cursor/lynx-message-queue-server-local` / Next #41)

| Item | Notes |
|---|---|
| messageQueueServer.ts | Cap-compatible HTTP helpers over `LynxRuntimeFetch`: list/get scope (directory+session), admit text, reorder by queueItemIDs, remove, send-now, flush→send-now first; honest parse; no-runtime/HTTP never fake-success |
| composer + chips wire | Prefer server queue when runtime reachable; unavailable (501/transport) → local queue; chips keep portable ↑/↓ (no `@dnd-kit`) |
| Vitest | Happy-path parse + failure paths (`messageQueueServer.test.ts`) + composer server/local coverage |
| Docs honesty | Tip `c02f917f` / APK `lynx-v2-debug-c02f917` (release exists); Next #41 |
| Docs honesty | NOT DONE / 三关未齐 / not EXHAUSTED / 真机残差 empty / no 真机过 claim |
| Still deferred | Cap TanStack/Zustand MQ sync flights; `@dnd-kit`; host-only unchanged (full sessions sheet in #42; worktree dialogs in #43; remote-branch delete in #44) |

### 代码接上 this slice (`cursor/lynx-sessions-trailing-local` / Next #50)

| Item | Notes |
|---|---|
| Trailing helpers | `resolveLynxSessionsSheetTrailingActionIds` / `TrailingActiveProject` / `NewChatDirectory` — Cap gating (newChat if projects; newWorktree if active git; addProject always) |
| SessionsSheet header | `LynxMobileResizableSheet` `trailing` slot: newChat → `onOpenDraft?.(directory)`; newWorktree → existing `LynxCreateWorktreeDialog`; addProject → `DirectoryExplorerSheet` |
| i18n | `lynx.chat.sessionsSheet.newChat`; reuse `lynx.projects.chrome.addProject` + `lynx.projects.menu.newWorktree` |
| Vitest | Focused trailing appear / directory resolve coverage in `sessionsSheet.test.ts` |
| Docs honesty | Tip `8f2df6d8` / published APK `lynx-v2-debug-8f2df6d` (do NOT invent newer); Next #50 |
| Docs honesty | NOT DONE / 三关未齐 / not EXHAUSTED / 真机残差 empty / no 真机过 claim |
| Still deferred | Cap `@dnd-kit` / MobileWindowMotion / iPad / Cap toast / bulk; host-only unchanged |

### 代码接上 this slice (`cursor/lynx-assistant-catalog-menus-local` / Next #51)

| Item | Notes |
|---|---|
| createLynxAssistant / setLynxAssistantsEnabled / deleteLynxAssistant | Cap POST `/api/openchamber/assistants`, PUT `…/settings` `{enabled,expectedRevision}`, DELETE `…/:id` + expectedRevision — Vitest happy + failure/no-runtime |
| AssistantTab menus | Long-press/overflow Edit → Settings assistants EntityEditor (focus id); Delete → `LynxCenteredDialog` portal; empty Create CTA → Settings assistants; disabled Enable CTA → PUT then refresh |
| Settings AssistantsSettingsBody | Create button: resolve first provider/model → POST → open EntityEditor; Enable when disabled banner |
| Portable errors | Inline/banner only — no Cap toast / sonner |
| Docs honesty | Tip `c1bb93c4` / published APK `lynx-v2-debug-c1bb93c` (do NOT invent newer); Next #51 |
| Docs honesty | NOT DONE / 三关未齐 / not EXHAUSTED / 真机残差 empty / no 真机过 claim |
| Still deferred | Cap `@dnd-kit` / MobileWindowMotion / iPad / Cap toast / bulk; host-only unchanged |

### 代码接上 this slice (`cursor/lynx-projects-home-show-more-local` / Next #52)

| Item | Notes |
|---|---|
| Per-bucket Show more | Cap `visibleCountByBucket` on ProjectsHome worktree/main groups — default 3 / +7; Show more / Show fewer |
| Search bypass | Cap `catalogSessions` spirit — keyword search filters full bucket catalog and skips compact slice / Show more while `searching` |
| Reuse SessionsSheet helpers | `sliceLynxSessionsSheetVisible` / `nextLynxSessionsSheetVisibleCount` / `collapseLynxSessionsSheetVisibleCount` + `lynxProjectsHomeBucketKey` (`projectId::worktreeId`); no new Cap APIs |
| Vitest | Bucket-key + Cap 3/+7 coverage in `sessionsSheet.test.ts` |
| Docs honesty | Tip `cfed15657` / published APK `lynx-v2-debug-cfed156` (was stale `c1bb93c`; do NOT invent newer); Next #52 |
| Docs honesty | NOT DONE / 三关未齐 / not EXHAUSTED / 真机残差 empty / no 真机过 claim |
| Still deferred | Cap `@dnd-kit` / MobileWindowMotion / iPad / Cap toast / bulk; host-only unchanged |

### 代码接上 this slice (`cursor/lynx-mcp-sheet-connect-local` / Next #54)

| Item | Notes |
|---|---|
| MCP sheet status | Cap `GET /mcp` + `/api/config/mcp` merged rows (status ∪ config names) |
| Connect / disconnect | Cap Switch spirit → `POST /mcp/{name}/connect` / `disconnect`; refresh; busy guard |
| Honesty | Failure / no-runtime never fake ON; `needs_auth` labeled (OAuth browser host-only) |
| Vitest | `mcpSheet.test.ts` — parse/tone/merge/load/connect/disconnect |
| Docs honesty | Tip `7c5a135a9` / published APK `lynx-v2-debug-7c5a135` (do NOT invent newer); Next #54 |
| Docs honesty | NOT DONE / 三关未齐 / not EXHAUSTED; 真机残差 keeps Connect welcome style confirmation |
| Still deferred | Cap `@dnd-kit` / MobileWindowMotion / iPad / Cap toast / bulk; host-only unchanged |

### Still missing / host-only / 真机

| Remaining | Why |
|---|---|
| Native Keychain / Keystore live OS wiring | Stubs + JS adapter 代码接上; SecItem / EncryptedSharedPreferences still 真机 |
| Real QR camera / AVCapture / CameraX | Adapter + chrome 代码接上; binder returns unavailable until host |
| OAuth system browser open | Cap routes + host stubs 代码接上; ASWebAuthenticationSession / Custom Tabs 真机 |
| Host WKWebView / WebView HTML preview sheet | Text stub only — no invent Lynx DOM iframe |
| PierreDiff interactive viewer | **Blocked:** `@pierre/diffs` needs `diffs-container` Shadow DOM + `react-dom` + worker; Lynx/rspeedy has none. Feature path → portable-text only (`resolveLynxPierreDiffFeature`). Do not fake CSS/iframe. |
| Composer glass / actions / pickers 真机 / Mode B host overlay | GlassCard + in-glass actions + half-height resizable Agent·model sheets JS 代码接上; live UIGlassEffect + host Mode B overlay / drag feel still 真机 |
| IME keyboard binding + occupancy 真机 | Contract + inset publisher stubs 代码接上; LynxView IME must be host-bound |
| Edge-swipe / Predictive Back pan arena 真机 | Contract + stubs 代码接上; native gesture ownership still host |
| Haptics / HEIC / media pick / APNs·FCM token mint | Adapters 代码接上; native plugins still host |
| Share extension / Android `ShareReceiverActivity` | **Host-only** (separate from Next #36 JS full-page picker). Inbox + recipient picker 代码接上; native extension/receiver still host |
| Native clipboard binder | Next #37 copyLink uses `navigator.clipboard` when present; otherwise labeled unavailable — host clipboard plugin still host-only |
| MobileSessionStatusBar / sessions sheet | Slim strip 代码接上 in #39; full Cap sessions sheet 代码接上 in #42; worktree create/delete dialogs 代码接上 in #43; remote-branch delete 代码接上 in #44; two-step archive + unarchive undo 代码接上 in #45; ArchivedSessionsDialog 代码接上 in #46; smart-title 代码接上 in #47; tree archive/delete + delete undo 代码接上 in #48; MobileProjectEditSurface 代码接上 in #49; header trailing newChat/worktree/addProject 代码接上 in #50; ProjectsHome per-bucket Show more 代码接上 in #52. Remaining: Cap `@dnd-kit` / MobileWindowMotion / iPad sidebar / Cap toast lib (sonner) / bulk multi-select (desktop sidebar folders) |
| Cap server message-queue | Thin Lynx client 代码接上 in #41 (`messageQueueServer` + composer wire); full Cap TanStack/Zustand sync + `@dnd-kit` still deferred |
| Live Activity / Widgets / Control Center | iOS-only host — later |
| Android sideload APK + lynx-ci | **Live** on tip (`lynx-mobile-ci` assembleRelease + prerelease `lynx-v2-debug-*`; lynx-ci green). First-paint cream/globalProps 代码接上 — **not** 真机过. |
| iOS IPA / CocoaPods Lynx resolve | Still missing on Linux; Mac/device required |
| FCM for `com.yee94.openchamber.lynx.debug` | Sideload id unique from Cap; Firebase Android app not registered yet (pitfalls §6) |
| Bonjour / Nearby, invented ASR, TanStack 1.18, Capgo OTA | 故意不移植 |
| 真机过 | Empty 真机残差 until a written device log |

Do **not** mark product rows **landed** under 三关 until CI绿 (track workflow running on GH) + 真机过.

## How to move a row

1. Implement against the inventory source, not a screenshot guess.
2. Add or update a focused test / harness (`docs/lynx-acceptance.md`).
3. Land on `work/lynx-native` only.
4. Flip **missing → landed** only after 代码接上 + CI绿.
5. Flip **landed →** keep a **真机残差** row until a physical device pass is written down.
6. Never silently recategorize a missing feature as 故意不移植 to make the board look green.
