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
## Missing

Seeded from the inventory. Grouped so a slice can pick a coherent vertical.

### Host / skeleton

| Item | Cap/web source | Lynx note |
|---|---|---|
| Lynx rspeedy bundle + signed host apps | `packages/lynx` scaffold | Package exists; CocoaPods/Gradle Lynx SDK and APK/IPA CI still missing |
| ~~Connect / splash while auto-connect resolves~~ | `MobileApp.tsx` welcome | **代码接上** ConnectWelcome splash + welcome; host LynxView chrome still thin |
| ~~Instance list, add, delete, password unlock~~ | `mobileConnections.ts` | **代码接上** instances UI on welcome + settings/instances |
| QR + pairing-link redeem v2 | `mobileQrScan.ts` | Link parse + redeem exist; **camera plugin** is host-owned |
| `openchamber://` parse + apply | `deepLinks.ts` | Parse/build exist; **apply / navigation** still missing |
| Secure store (Keychain / Keystore) | Capacitor secure storage | Injected adapter only — **native Keychain/Keystore wiring** still missing |
| Four-tab **product** content (session-index, catalogs) | `mobileTabs.ts` | Shell IA + Projects/Assistant/Scheduled tab bodies **代码接上**; rich pixel polish / swipe menus still missing |
| Host Tab/Nav **binary** (linked Lynx SDK) | `packages/lynx/host/*` | Strategy + sources landed; not an Xcode/Gradle project yet |

### Projects (chat list)

| Item | Cap/web source |
|---|---|
| ~~Project cards + worktree groups~~ | `MobileProjectsHome.tsx` | **代码接上** in `ProjectsHome` (worktree groups from session-index + optional parent map) |
| ~~Session rows, search, pin / in-progress~~ | `useMobileProjectsHomeModel.ts` | **代码接上** search + pin/busy cues |
| ~~`项目 · 分支` subtitle~~ | `formatHomeSessionSubtitle` | **代码接上** |
| ~~Collapsing MobileTabPageHeader~~ | `MobileTabPageHeader.tsx` | **代码接上** glass search + primary + |
| Swipe / long-press actions | `sessionMenuModel.ts` | |
| New-session draft page | `kind: 'draft'` | Draft secondary push landed; composer body still stub |
| Add project directory explorer | `DirectoryExplorerDialog` | |
| Header 扫一扫 / 切换实例 | `MobileProjectsHome` | |
| ~~Session index as data source~~ | `GET /api/openchamber/session-index` (server) | Client + home projection + **Projects UI** 代码接上 |

### Chat

| Item | Cap/web source | Lynx note |
|---|---|---|
| ~~**LegendList-semantics timeline**~~ | `TimelineList.tsx` | **代码接上** in `packages/lynx/src/chat` (list semantics + LynxTimelineList). Rich turn cards still missing |
| Chat header / overflow | `MobileChatScreen.tsx` | Header back + title landed; overflow menu missing |
| ~~Send / Stop / queue / abort~~ | ChatInput + queue | **代码接上** hooks + official routes; composer text input host binding still thin |
| Questions / permissions | chat cards | |
| Activity / sorted / collapsed | chat DOCUMENTATION | |
| ~~Load-older button (no scroll auto-load)~~ | timeline controller | **代码接上** button + bounce forbid tests |
| Nested child session stack + predecessor | `mobileNavigation.ts` | |
| Files / Changes / turn-diff sheets | `MobileFilesSurface`, `MobileChangesSurface` | |
| MCP sheet | `mobile-mcp` | |
| Context usage | `mobileContextUsage.ts` | |
| Composer attachments, `/` `@`, agent/model | composer DOCUMENTATION | |
| Native-quality IME (not WebView FLIP) | pitfalls §3 | |
| Session swipe (composer only) | `useEdgeSwipeSessionSwitch.ts` | |

### Assistant / Scheduled / Settings

| Item | Cap/web source | Lynx note |
|---|---|---|
| ~~Assistant catalog + conversation page~~ | `MobileAssistantTab.tsx`, `AssistantView.tsx` | **代码接上** catalog + LynxChatScreen chrome; ensure-session labeled when unbound |
| Continuous / stateless admission | assistants DOCUMENTATION | Mode labels shown; admission APIs not fully ported |
| Share welcome + inbox | `AssistantShareWelcome`, `MobileShareBridge` | |
| ~~Scheduled list / history / editor~~ | `MobileScheduledTab.tsx` | **代码接上** list + history hooks; editor labeled stub |
| ~~Settings search + **all 21 mobile slugs**~~ | `MOBILE_SETTINGS_PAGE_SLUGS` | **代码接上** home search + grouped rows + push stubs |
| Settings split collection → entity editor | `SettingsView.tsx` | |

### Native platform

| Item | Cap/web source |
|---|---|
| APNs + FCM registration | `useNativePushRegistration.ts` |
| Share extension / Android share receiver | `packages/mobile` share |
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
3. ~~Four-tab shell IA~~ — navigation + Projects/Assistant/Scheduled tab bodies 代码接上. Remaining: swipe menus, draft composer body, share welcome.
4. ~~Projects home data path + UI~~ — session-index bindings + ProjectsHome UI in `packages/lynx` (failure ≠ empty). Remaining: directory explorer / 扫一扫 / instance switch chrome.
5. ~~**LegendList-semantics chat list** + send/stop on official APIs~~ — 代码接上 in `packages/lynx/src/chat`. Remaining: rich turn cards, SSE live tail, Files/Changes, native IME.
6. ~~**Settings home + slug map**~~ — 代码接上 search + 21 rows. Bodies: wired/list/stub in settings-ci slice. Remaining: rich entity editors.
7. ~~**Assistant catalog + Scheduled list/history**~~ — 代码接上 snapshot/list/history hooks. Remaining: editor chrome, share welcome, admission flows.
8. ~~**Connect welcome + instances UI**~~ — 代码接上 splash/list/paste. Remaining: host QR camera + Keychain wiring + 真机.
9. ~~**Projects MobileTabPageHeader**~~ — 代码接上 collapsing header + glass search + primary +. Remaining: pixel polish / menu.
10. ~~**CI skeleton (Linux)**~~ — `packages/lynx/ci/lynx-ci.yml` → install as `.github/workflows/lynx-ci.yml` (needs `workflow` token scope) type-check + vitest + rspeedy. Remaining: Android APK + iOS sim runners (do not claim 真机过).

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
| `notifications` | 代码接上 (wired hooks) | Toggles via settings blob; APNs/FCM register host-owned |
| `sessions` | 代码接上 (wired GET/PUT) | Auto-delete + retention from settings blob |
| `summary-ai` | 代码接上 (row + labeled stub body) | Settings blob + `/api/small-model` |
| `projects` | 代码接上 (list) | `projects[]` from settings blob; editor stub |
| `git` | 代码接上 (wired gitmoji + stub editor) | gitmoji toggle; identities editor stub |
| `providers` | 代码接上 (list) | `/api/config/catalog/providers` (failure ≠ empty); editor stub |
| `agents` | 代码接上 (list) | `GET /api/agent` (failure ≠ empty); editor stub |
| `assistants` | 代码接上 (list) | assistants snapshot list; editor stub |
| `behavior` | 代码接上 (row + labeled stub body) | agents.md + response style |
| `commands` | 代码接上 (list) | commands metadata catalog; editor stub |
| `mcp` | 代码接上 (list) | `GET /api/config/mcp`; editor stub |
| `plugins` | 代码接上 (list) | `GET /api/config/plugins`; editor stub |
| `magic-prompts` | 代码接上 (list) | `/api/magic-prompts`; editor stub |
| `snippets` | 代码接上 (list) | `/api/config/snippets`; editor stub |
| `skills.installed` | 代码接上 (list) | `/api/config/skills?summary=true`; editor stub |
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
