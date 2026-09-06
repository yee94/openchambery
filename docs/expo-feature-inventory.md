# Expo rewrite — Cap / WebView feature inventory

Independent track: **`work/expo-native`**. Do **not** merge to `main`. Do **not** touch the 1.18 TanStack line (`cursor/tanstack-chat-physics-29a6`, `v1.18.5`).

Native is the product. There is **no** Appearance `openchamber.iosNativeUi` toggle and **no** WebView-fallback switch. iOS chrome (composer, liquid-glass dock on iOS 26, Live Activity, share, NSE, widgets, haptics, IME) is always on via **real** UIKit / Expo native modules (`UIGlassEffect`, `UITabBar`, …). Android uses native Android surfaces — not a broken iOS glass clone, and not a WebView composer.

Status legend used in every table:

| Mark | Meaning |
|---|---|
| **required** | Cap/WebView ships this on current `main`. Expo must reimplement it as native (not a WebView). |
| **will-not-port** | Explicitly out of scope for this track. Do not rebuild. |
| **device-only** | Code or contract can land in CI, but 真机过 stays residual until a real phone walk. |

This file is the inventory. Living progress lives in [`docs/expo-gap-board.md`](expo-gap-board.md). Acceptance is [`docs/expo-acceptance.md`](expo-acceptance.md). Pitfalls are [`docs/expo-pitfalls.md`](expo-pitfalls.md). IA/UI contract is [`docs/expo-ia-ui.md`](expo-ia-ui.md).

## Baseline (read on main, 2026-09-06)

| Fact | Value |
|---|---|
| `main` HEAD | `b444b0316` `release: v1.19.7-beta.7` |
| Root `package.json` | `1.19.7-beta.7` |
| CHANGELOG tip | `[1.19.7-beta.7]` Live Activity complete/stop-timer; push titles shortened |
| Chat list on Cap/WebView | **TanStack Virtual is the WebView runtime default** (`oc:legend-timeline` opt-in). Expo still adopts **LegendList product semantics** (same as Flutter): `initialScrollAtEnd` / `maintainScrollAtEnd` / `maintainVisibleContentPosition`. Do not port 1.18 TanStack physics. |
| App path | `apps/mobile_expo` (Capacitor `packages/mobile` left in place) |

## Information architecture (do not invent a fifth dock tab)

Four dock roots only (`packages/ui/src/mobile/mobileTabs.ts`):

| Tab id | Label key | Role |
|---|---|---|
| `projects` | `mobile.tabs.projects` | Home. Session index, pin/in-progress, project cards |
| `assistant` | `mobile.tabs.assistant` | Assistant catalog / conversations |
| `scheduled` | `mobile.tabs.scheduled` | Scheduled tasks + history |
| `settings` | `mobile.tabs.settings` | Settings home → `MOBILE_SETTINGS_PAGE_SLUGS` |

**Chat is a pushed secondary**, not a dock tab (`mobileNavigation.ts`: `secondary.kind === 'chat' | 'draft' | 'assistant' | 'instances'`). Back priority: overlays → secondary page → root tab. Phone stack is metadata-only at arbitrary depth; the host renders the top two pages.

## Files read on main (do not guess)

Tabs / shell

- `packages/ui/src/mobile/mobileTabs.ts` — four roots only
- `packages/ui/src/mobile/MobileTabsRoot.tsx`
- `packages/ui/src/mobile/MobileTabBar.tsx`
- `packages/ui/src/mobile/MobileTabPageHeader.tsx`
- `packages/ui/src/mobile/MobilePhoneShell.tsx`
- `packages/ui/src/mobile/MobileSurface.tsx`
- `packages/ui/src/mobile/MobileDetailNavigation.tsx`
- `packages/ui/src/mobile/mobileNavigation.ts` / `mobileBackNavigation.ts` / `useMobileNavigationStore.ts`
- `packages/ui/src/mobile/useNativeIosTabBar.ts`
- `packages/ui/src/lib/iosNativeUi.ts` — Capacitor WebView-era gate (`openchamber.iosNativeUi`, default **off**). **Deleted for Expo.** Native is always on.

Surfaces

- `packages/ui/src/mobile/projects/MobileProjectsHome.tsx` + `useMobileProjectsHomeModel.ts` (`formatHomeSessionSubtitle` → `项目 · 分支`)
- `packages/ui/src/mobile/projects/MobileProjectCard.tsx` / `MobileSessionRow.tsx` / `MobileRowActionsSheet.tsx`
- `packages/ui/src/mobile/chat/MobileChatScreen.tsx` + header / context-progress
- `packages/ui/src/mobile/assistant/MobileAssistantTab.tsx`
- `packages/ui/src/mobile/scheduled/MobileScheduledTab.tsx`
- `packages/ui/src/mobile/settings/MobileSettingsTab.tsx`
- `packages/ui/src/mobile/sessionMenuModel.ts`
- `packages/ui/src/components/chat/TimelineList.tsx` — LegendList contract
- `packages/ui/src/stores/useFeatureFlagsStore.ts` — WebView flag `oc:legend-timeline`
- `packages/ui/src/apps/MobileApp.tsx` — Capacitor-only connection onboarding, Files/Changes hosts
- `packages/ui/src/apps/mobileConnections.ts` — `RELAY_RACE_HEADSTART_MS = 1_500`; relay-only skips it
- `packages/ui/src/apps/mobileQrScan.ts` / `MobilePairingLinkForm.tsx`
- `packages/ui/src/lib/connectionPayload.ts` — pairing v2 (`lan` / `tunnel` / `relay`)
- `packages/ui/src/apps/deepLinks.ts` — `openchamber://` vocabulary
- `packages/ui/src/apps/MobileFilesSurface.tsx` / `MobileChangesSurface.tsx`
- `packages/ui/src/apps/MobileShareBridge.tsx` / `mobileShareDrain.ts` / `mobileShareDraftHandoff.ts`

Settings

- `packages/ui/src/lib/settings/metadata.ts` (`MOBILE_SETTINGS_PAGE_SLUGS`, groups)
- `packages/ui/src/components/sections/shared/SETTINGS_DESIGN_SPEC.md`
- `.agents/skills/settings-ui-patterns/SKILL.md`

Native contracts / shell

- `packages/mobile/HANDOFF.md`
- `packages/mobile/README.md`
- `packages/mobile/contracts/*` (composer, keyboard, haptics, share, navigation, media, tab-bar, virtual-asset, external-browser)
- `packages/ui/src/lib/native-ios-composer.ts` / `native-ios-tab-bar.ts` / `native-ios-live-activity.ts`
- `CHANGELOG.md` (1.19.0–1.19.7-beta.7)
- `.github/workflows/mobile-ci.yml` / `mobile-release.yml` / `mobile-beta-ota.yml`

Visual targets

- `docs/references/mobile_projects.png`
- `docs/references/mobile_chat.png`
- `docs/references/mobile_schedules.png`
- `docs/references/chat_mobile_dark.png`
- Root `README.md` (those three mobile shots)

## Settings slug checklist (`MOBILE_SETTINGS_PAGE_SLUGS`)

Source: `packages/ui/src/lib/settings/metadata.ts`. Mobile Settings home is search + grouped drill-in. **Do not invent slugs.**

| Slug | Group | Cap/WebView | Expo mark | Notes |
|---|---|---|---|---|
| `instances` | connection | Capacitor-only Switch instance | **required** | Saved connections, QR, add URL/token. Hosted `mobile.html` in a browser does **not** expose this |
| `appearance` | personalization | Language, theme, density, `iosNativeUi` on Cap iOS | **required** (minus toggle) | Language + theme + mobile visual tokens. **No `iosNativeUi` row** |
| `chat` | personalization | Render mode, stream transport, follow-up, reasoning, wrap | **required** | GET/PUT `/api/config/settings`. Capacitor locks stream transport to SSE |
| `notifications` | personalization | Native + in-app toggles | **required** | `nativeNotificationsEnabled` / `notifyOn*` + APNs/FCM register |
| `sessions` | personalization | Defaults, retention, zen | **required** | Settings blob |
| `summary-ai` | personalization | Small-model / title / commit | **required** | Settings blob + `GET /api/small-model` |
| `projects` | workspace | Project list / worktrees | **required** | `projects[]` from settings blob + live project APIs |
| `git` | workspace | Identities, gitmoji | **required** | `GET /api/git/identities` |
| `providers` | opencode | Catalog + credentials | **required** | `GET /api/config/catalog/providers` — failure ≠ empty |
| `agents` | opencode | Agent list | **required** | `GET /api/agent` |
| `assistants` | opencode | Snapshot + sharing | **required** | `GET /api/openchamber/assistants/snapshot` |
| `behavior` | opencode | Agents.md / style | **required** | + `GET /api/behavior/agents-md` |
| `commands` | opencode | Slash catalog | **required** | `POST /api/config/commands/metadata` `{catalog:true}` |
| `mcp` | opencode | MCP servers | **required** | `GET /api/config/mcp` |
| `plugins` | opencode | Plugin list | **required** | `GET /api/config/plugins` |
| `magic-prompts` | content | Overrides | **required** | `GET /api/magic-prompts` |
| `snippets` | content | Snippet catalog | **required** | `GET /api/config/snippets` |
| `skills.installed` | content | Installed skills | **required** | `GET /api/config/skills?summary=true` |
| `usage` | system | Quota per provider | **required** | `GET /api/quota/{providerId}`; one failure stays on that row |
| `voice` | system | TTS / STT settings | **will-not-port** | Official metadata still lists Voice. Cap WebView has the page + `/api/dictation/ws` + `POST /api/tts/speak`. Expo does **not** ship working STT/TTS (same as Flutter) — omit the row/page |
| `about` | system | Versions + OTA | **required** | Native client version ≠ instance OpenChamber / OpenCode versions. Capgo UI is **will-not-port** |
| `shortcuts` | personalization | Keyboard | **will-not-port** | `isAvailable: !isVSCode` on desktop/web; not in `MOBILE_SETTINGS_PAGE_SLUGS` |
| `remote-instances` | workspace | SSH | **will-not-port** | Desktop/web; not in mobile slug list |
| `global-config` | opencode | `opencode.json` | **will-not-port** | Not in mobile slug list |
| `skills.catalog` | content | External catalog | **will-not-port** | Not in mobile slug list (installed skills only) |
| `home` | — | Settings search hub | **required** | Implicit mobile Settings home, not a dock tab |

## Shell / IA inventory

| Feature | Cap/WebView source | Expo mark | Notes |
|---|---|---|---|
| Four-tab dock | `mobileTabs.ts`, `MobileTabBar.tsx` | **required** | Projects / Assistant / Scheduled / Settings only |
| Chat dock tab | — | **will-not-port** | Never existed on 1.19 mobile |
| Pushed Chat / draft / assistant / instances | `mobileNavigation.ts` | **required** | Secondary stack; dock hides on Chat |
| Collapsing tab header | `MobileTabPageHeader.tsx` | **required** | Title collapse over 48px scroll; layout height stable |
| Floating project surfaces | `MobileSurface.tsx` | **required** | One surface per project; worktrees inset |
| Native iOS tab bar | `OpenChamberTabBar`, `useNativeIosTabBar` | **required** | iOS 26 `UITabBar` + `UIGlassEffect`. Older iOS: system translucent `UITabBar`. Not a CSS clone |
| Web `iosNativeUi` gate | `iosNativeUi.ts` | **will-not-port** | Capacitor default **off**. Expo: native always on; do not persist this key |
| Hosted `mobile.html` selector | web | **will-not-port** | Native app has no surface selector |
| Edge-swipe session switch | `useEdgeSwipeSessionSwitch.ts` | **required** | Composer-owned left/right session rank |
| Header swipe → sessions sheet | `useHeaderSwipeToSessions.ts` | **required** | Transcript RTL → session list |
| Native back (iOS edge / Android predictive) | `OpenChamberNavigation` | **required** | Native never owns the React/RN page stack; it drives progress |
| Status bar / safe area | Capacitor StatusBar overlay | **required** | System insets; no fake CSS safe-area |
| Keyboard / IME | iOS `--oc-kb-layout`; Android `adjustNothing` + FLIP | **required** | Native field owns IME. Android: system IME inset, not a second pad |
| Haptics light/medium/heavy | `OpenChamberHaptics` | **required** | iOS `UIImpactFeedbackGenerator`; Android `performHapticFeedback` |
| App-icon badge | iOS `attentionCount` + APNs `aps.badge` | **required** (iOS) / **will-not-port** (Android invent) | Official relay rejects `platform === 'android'` for badge. Do not invent ShortcutBadger |
| Local PIN / Face ID / app lock | — | **will-not-port** | Does not exist. Passcode = **server connection password** |

## Connection / onboarding inventory

| Feature | Cap/WebView source | Expo mark | Notes |
|---|---|---|---|
| First-launch connect screen | `MobileApp.tsx`, `mobileConnections.ts` | **required** | Capacitor-only. URL, pairing link, client token, instance UI password |
| Saved connections (max 12) | `openchamber.mobile.connections.v1` | **required** | Metadata in app storage; **token in Keychain / Keystore** |
| Auto-connect last instance | HANDOFF | **required** | Delete-active → connect screen |
| Server password unlock | `submitPassword` | **required** | This is the “passcode”. Not Face ID |
| Pairing v2 QR | `mobileQrScan.ts`, `connectionPayload.ts` | **required** | Persist full candidates (`lan` + `relayUrl` + `hostEncPubJwk` + grant + `serverId`) |
| Pairing deep link | `openchamber://connect?v=2&p=…` | **required** | One-time redeem; secrets never logged or persisted as the grant |
| LAN + relay race | `RELAY_RACE_HEADSTART_MS = 1500` | **required** | Direct keeps priority for 1.5s, then relay races |
| Relay-only payload | `directList.length === 0` → `probeRelay()` | **required** | **Skip the 1.5s headstart.** No LAN error. Status `已连接 · 中继` / `Connected · Relay` |
| Server-id mismatch gate | `/health` `serverId` | **required** | Do not send bearer to a reassigned LAN host |
| Official 「附近」 / Bonjour / mDNS | — | **will-not-port** | Official “nearby” **is** LAN/home HTTP. There is no 「附近」 string and no `NWBrowser` / NSD scanner. Do not invent one |
| Device id dedupe | `openchamber.mobile.deviceId` | **required** | `mobile:{uuid}` client key |
| Secure storage | `@aparajita/capacitor-secure-storage` | **required** | Never log tokens |
| LAN HTTP cleartext | Android `usesCleartextTraffic` | **required** | Home `http://192.168.x` |
| iOS Local Network prompt | `NSLocalNetworkUsageDescription` | **device-only** | Plist can land; prompt is phone-only |
| Home ↔ away hot-switch | candidate refresh + reprobe | **required** (code) / **device-only** (真机) | Same saved device, LAN preferred |

## Projects home inventory

| Feature | Cap/WebView source | Expo mark | Notes |
|---|---|---|---|
| Session index home | `GET /api/openchamber/session-index` | **required** | Index-driven. Failure ≠ empty success |
| Pinned + in-progress buckets | `derivePinnedSessions` / `listInProgressHomeSessions` | **required** | 1.19.2: unread rows match normal style; keep unread dot |
| Subtitle `项目 · 分支` | `formatHomeSessionSubtitle` | **required** | 1.19.3-beta.4 |
| Session search + highlight | 1.19.3-beta.1 | **required** | Matches loaded directory titles |
| Plus menu: 扫一扫 / 切换实例 / new session | `MobileProjectsHome` | **required** | QR + instances + draft |
| Project card overflow | `sessionMenuModel.ts` | **required** | new session, new worktree, sync, edit, close |
| Session overflow | `rename` `pin` `share` `copyLink` `unshare` `refreshTranscript` `archive` `delete` | **required** | |
| Worktree overflow | new session / delete worktree | **required** | |
| Show more / fewer pagination | `mobileSessionPagination.ts` | **required** | Display snapshot bounded; search uses catalog |
| New project / edit project | `MobileProjectEditSurface.tsx` | **required** | |
| Flat mobile session tree | `MobileProjectsHome` comment | **required** | Nested subagents exist for archive helpers; home list is flat |

## Chat / composer inventory

| Feature | Cap/WebView source | Expo mark | Notes |
|---|---|---|---|
| Pushed Chat screen | `MobileChatScreen.tsx` | **required** | Dock hidden. 56px detail nav |
| Draft new session | `secondary.kind === 'draft'` | **required** | `sessionId == ''` until `POST /api/session` |
| LegendList transcript | `TimelineList.tsx` | **required** | Expo contract: LegendList (or RN port). Not 1.18 TanStack |
| Re-enter scrolls to latest | 1.19.3-beta.5 | **required** | Not last-sent user message |
| Send / Stop | `prompt_async` / abort | **required** | Native never submits itself; JS/RN owns wait/queue/errors |
| Message queue | `QueuedMessageChips` | **required** | Server admission; abort promotes head |
| Question cards | session questions | **required** | |
| Slash / `@` / `#` autocomplete | `composer-autocomplete` | **required** | iOS: glass list above composer. Search stays in app code |
| Attachments + HEIC | `OpenChamberMedia.transcode` | **required** | `PUT /api/fs/prompt-attachments/:id` then `file://` parts. 25 MiB cap on Flutter; match Cap |
| Photo / file pickers | iOS PHPicker + document picker; Android Photo Picker | **required** | |
| Context usage ring | `MobileContextProgressButton` | **required** | |
| Activity / Used fold | 1.19.6 process fold | **required** | Do not rebuild plan-mode Activity |
| Reasoning disclosure | `ReasoningPart` | **required** | Default collapsed; stream auto-expands |
| Transcript refresh / share / fork / copy | session overflow + message footer | **required** | |
| Files sheet | `MobileFilesSurface.tsx` | **required** | Search, copy, raw, HTML preview |
| Changes / turn diff | `MobileChangesSurface.tsx` | **required** | `edit`/`multiedit` single-file sheet; `apply_patch` all files |
| HTML preview fullscreen + source | 1.19.5 / 1.19.6 | **required** | Relay must not white-screen |
| Permission prompts | session permissions | **required** | |
| Composer swipe to other sessions | Chat DOCUMENTATION | **required** | Only composer is the swipe surface |
| iOS native composer | `OpenChamberComposer` + `UIGlassEffect` | **required** | Always on. Occupancy = collapsed pill only |
| Android composer | web Composer + IME FLIP | **required** | Solid / system material. **Not** fake glass |
| Dictation PCM + `/api/dictation/ws` | `useKeyboardShortcuts` / dictation | **will-not-port** | Same as Flutter. Server APIs stay |
| Read aloud / `POST /api/tts/speak` | `useServerTTS` | **will-not-port** | Same as Flutter |
| Plan mode / `/plan-feature` | removed 1.19.2 | **will-not-port** | Do not rebuild |
| Project notes / Todo panel | removed 1.19.2 | **will-not-port** | Tool cards `todowrite`/`todoread` may still appear as **agent tools**, not a notes product |
| Capgo OTA from Chat/About | `capgoAdapter.ts` | **will-not-port** | WebView bundle hot update only |

## Assistant / Scheduled inventory

| Feature | Cap/WebView source | Expo mark | Notes |
|---|---|---|---|
| Assistant catalog | `MobileAssistantTab.tsx` | **required** | Cards: avatar, name, mode, summary. Enable guide when off |
| Assistant conversation page | `secondary.kind === 'assistant'` | **required** | Pushed; store owns selected assistant |
| Share-to-assistant | Share inbox + recipient picker | **required** | Exact instance+assistant. No silent default |
| Scheduled list + filters | `MobileScheduledTab` + dialog | **required** | 任务/历史记录; 全部/已启用/已暂停 |
| Open task history | 1.19.3-beta.2/3 | **required** | History row opens that session; in-progress from start |
| Scheduled APIs | `scheduledTasksApi.ts` | **required** | `GET /api/openchamber/scheduled-tasks`, project CRUD + `/run` |
| Scheduled editor covers dock | 1.19.6 Cap quirk when native UI off | **required** | Editor is an in-tab cover (`tabBarCovered`), not a fake fifth root |

## Native chrome / device capabilities

| Contract | Cap source | Expo mark | Notes |
|---|---|---|---|
| iOS 26 liquid-glass dock | `OpenChamberTabBar` | **required** | `UITabBarController` chrome-only. Taps emit selection; RN owns the stack |
| iOS composer `UIGlassEffect` | `OpenChamberComposer` | **required** | iOS 26 glass; older: `UIBlurEffect`. Never log composer text |
| Live Activity / Dynamic Island | `OpenChamberLiveActivity` | **required** | iOS 17+. One Activity for every busy session. Start after 5s. 1.19.7-beta.7: complete → stop timer. **Not** gated by `iosNativeUi` |
| WidgetKit + Control Center + NSE | `OpenChamberWidget` | **required** | App Group `group.com.yee94.openchamber` |
| Share extension / Android share receiver | `OpenChamberShare` | **required** | Catalog stores routing metadata only — never server tokens |
| Push APNs + FCM | HANDOFF | **required** | `POST /api/push/apns-token` (and Android FCM equivalent) + visibility. Host binds relay |
| Virtual image assets | `OpenChamberVirtualAsset` | **required** (native analogue) | Cap scheme `openchamber-asset://` is WebView-specific. Expo can use file/memory URIs |
| External browser OAuth | `OpenChamberExternalBrowser` | **required** | http(s) only. **device-only** for live hosted-provider/MCP round-trip |
| Deep links | `deepLinks.ts` | **required** | `connect` / `session` / `new-session` / `open-project` / `sessions` / `status` / `settings` / `changes` / `view` |
| Capgo updater | `@capgo/capacitor-updater` | **will-not-port** | Ship IPA/APK. Do not invent Expo-as-Capgo |
| EAS Update as store replacement | — | **will-not-port** | Same class of JS-bundle OTA. Native chrome requires a binary |
| WebView fallback toggle | — | **will-not-port** | Forbidden on this track |

## API / runtime inventory (happy path)

Failure must not masquerade as authoritative empty success.

| Area | Endpoints (Cap/WebView) | Expo mark |
|---|---|---|
| Health / session | `GET /health`, `GET/POST /auth/session` | **required** |
| Pairing redeem | `POST /api/client-auth/pairing/redeem` | **required** |
| Session index | `GET /api/openchamber/session-index` (+ sync/pin/directory/snapshot) | **required** |
| Sessions | OpenCode SDK v2 session/message/prompt/abort | **required** |
| Events | `/api/global/event/ws` prefer, SSE fallback | **required** |
| Assistants | `GET /api/openchamber/assistants/snapshot` + capability | **required** |
| Scheduled | `/api/openchamber/scheduled-tasks`, `/api/projects/:id/scheduled-tasks` | **required** |
| Settings blob | `GET/PUT /api/config/settings` | **required** |
| Attachments | `PUT /api/fs/prompt-attachments/:id` | **required** |
| Push | `POST /api/push/apns-token`, `POST /api/push/visibility` | **required** |
| Dictation / TTS | `/api/dictation/ws`, `POST /api/tts/speak` | **will-not-port** (client) |

## Recent main — required / do not rebuild

| Version | Rule |
|---|---|
| 1.19.0 | Native composer / iOS 26 dock / Live Activity / push-relay exist on Capacitor. Expo reimplements as native, not WebView |
| 1.19.2 | **Removed** plan mode (`/plan-feature`) and project notes/Todo — do not rebuild. Unread pin/in-progress rows keep the dot, match normal style |
| 1.19.3-beta.1 | Session search matches loaded directory titles + highlight |
| 1.19.3-beta.2/3 | Scheduled opens that task’s history; in-progress from start |
| 1.19.3-beta.4 | Pinned/in-progress subtitle `项目 · 分支` |
| 1.19.3-beta.5 | Re-entering a session scrolls to latest |
| 1.19.6 | WebView chat list **defaulted back to TanStack**. Process fold “运行了/运行中”. Expo still uses LegendList semantics |
| 1.19.6 / 1.19.7-beta.5 | Markstream React is WebView assistant-body default. Expo may choose a native Markdown engine; do not silently ship plain `Text` |
| 1.19.7-beta.7 | Live Activity marks a session complete and stops the timer; push titles are short sentences |

## Android degradation (intentional)

| iOS-native effect | Android product path |
|---|---|
| iOS 26 `UIGlassEffect` dock | RN/Expo floating capsule or Material 3 navigation — **not** liquid glass |
| UIKit glass composer | Solid floating pill + system IME |
| Live Activity / Dynamic Island | Not applicable |
| WidgetKit / Control Center / NSE | FCM + optional Android widgets later |
| `UIImpactFeedbackGenerator` | `performHapticFeedback` |
| LAN HTTP | `usesCleartextTraffic=true` |
| VisionKit QR | CameraX / ML Kit / Google Code Scanner |

## Bundle / identity (reuse, do not invent)

| Item | Value |
|---|---|
| Release applicationId / iOS bundle | `com.yee94.openchamber` |
| Debug Android | `applicationIdSuffix .debug` → `com.yee94.openchamber.debug` |
| Debug launcher label (this track) | **OpenChamber Expo** (Cap debug = “OpenChamber Debug”; Flutter debug = “OpenChamber v2”) |
| App Group | `group.com.yee94.openchamber` |
| Extensions | `.OpenChamberWidget` / `.OpenChamberNotificationService` / `.OpenChamberShareExtension` |
| URL scheme | `openchamber://` |
| Firebase | Existing `google-services.json` clients only (`openchamber-8bf7e`). No second project |

Honest collision: Capacitor debug, Flutter v2 debug, and Expo debug share `com.yee94.openchamber.debug` if all use `.debug`. Side-by-side is vs the **release** Cap app (`com.yee94.openchamber`). Do not install two `.debug` builds on one phone.

## Out of scope this bootstrap

Inventory and a placeholder shell only. No Cap API client, no LegendList wiring, no native glass modules, no pairing, no signed IPA. See the [gap board](expo-gap-board.md).
