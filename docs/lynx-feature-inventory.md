# Lynx mobile rewrite — feature inventory

Independent track: **`work/lynx-native`**. Do **not** merge to `main`. Do **not** treat this as an Expo or Flutter rewrite. The product surface to match is Capacitor + shared UI (`packages/mobile` + `packages/ui`), not a new brand.

This file is the **document gate** before large Lynx feature coding. Every row cites a source that exists on the baseline. Do not invent screens, brands, or capabilities that are not here.

## Baseline (read on `main`, 2026-09-06)

| Fact | Value |
|---|---|
| `main` HEAD at branch creation | `b444b0316` `release: v1.19.7-beta.7` |
| Root `package.json` | `1.19.7-beta.7` |
| Lynx app skeleton | **does not exist** — no `apps/mobile_lynx`, no Lynx package, no Lynx CI |
| Official mobile shell | Capacitor WebView wrapping `MobileApp` (`packages/mobile`) |
| Sibling native track | Flutter lives on `work/flutter-native`. Do not merge it. Do not copy Expo/Flutter stack choices. |

## Files read (do not guess)

Tabs / shell

- `packages/ui/src/mobile/mobileTabs.ts` — four roots only: `projects` / `assistant` / `scheduled` / `settings`
- `packages/ui/src/mobile/mobileNavigation.ts` — secondary kinds `chat` / `draft` / `assistant` / `instances`
- `packages/ui/src/mobile/MobileTabsRoot.tsx`
- `packages/ui/src/mobile/MobileTabBar.tsx`
- `packages/ui/src/mobile/MobilePhoneShell.tsx`
- `packages/ui/src/mobile/useNativeIosTabBar.ts`
- `packages/ui/src/lib/iosNativeUi.ts` — Capacitor WebView-era gate (`openchamber.iosNativeUi`, default **off**)
- `packages/ui/src/apps/MobileApp.tsx`
- `packages/ui/src/apps/renderMobileApp.tsx`
- `packages/ui/src/router/DOCUMENTATION.md`
- `packages/ui/src/router/pathContract.ts`

Surfaces

- `packages/ui/src/mobile/projects/MobileProjectsHome.tsx`
- `packages/ui/src/mobile/projects/useMobileProjectsHomeModel.ts`
- `packages/ui/src/mobile/chat/MobileChatScreen.tsx`
- `packages/ui/src/mobile/assistant/MobileAssistantTab.tsx`
- `packages/ui/src/mobile/scheduled/MobileScheduledTab.tsx`
- `packages/ui/src/mobile/settings/MobileSettingsTab.tsx`
- `packages/ui/src/components/chat/TimelineList.tsx` — **1.19 LegendList** contract
- `packages/ui/src/components/chat/MessageList.tsx` — current Cap default still TanStack (see list contract)
- `packages/ui/src/components/chat/DOCUMENTATION.md`
- `packages/ui/src/composer/DOCUMENTATION.md`
- `packages/ui/src/components/assistants/DOCUMENTATION.md`
- `packages/ui/src/apps/mobileConnections.ts`
- `packages/ui/src/apps/mobileQrScan.ts`
- `packages/ui/src/apps/deepLinks.ts`

Settings

- `packages/ui/src/lib/settings/metadata.ts` (`SettingsPageSlug`, `MOBILE_SETTINGS_PAGE_SLUGS`, groups)
- `packages/ui/src/lib/settings/search.ts`
- `packages/ui/src/components/views/SettingsView.tsx`
- `packages/ui/src/components/sections/shared/SETTINGS_DESIGN_SPEC.md`

Native / product docs

- `packages/mobile/README.md`
- `packages/mobile/HANDOFF.md`
- `packages/mobile/capacitor.config.ts`
- `packages/docs/content/docs/zh-cn/mobile.mdx`
- `packages/docs/content/docs/voice.mdx`
- `docs/pairing-v2-implementation-plan.md`
- `docs/RELEASING.md`
- Official IA photos: `docs/references/mobile_projects.png`, `docs/references/mobile_schedules.png`, `docs/references/mobile_chat.png`, `docs/references/chat_mobile_dark.png`

## Runtime model

| Surface | Entry | What it is |
|---|---|---|
| **Capacitor iOS/Android** | `packages/web/mobile.html` → `renderMobileApp.tsx` → `MobileApp.tsx` | Bundled mobile UI only. Connects to an **existing** OpenChamber server. Does **not** embed the web or OpenCode server. |
| **Hosted mobile web (H5/PWA)** | Same `MobileApp` | No Capacitor-only onboarding, QR pairing, widgets, native plugins, or `instances` / `about` mobile-only pages. |
| **Desktop / VS Code / web** | Other app entries | Share chat, settings, sync. Not the Lynx rewrite target. |

Package IDs (`packages/mobile/HANDOFF.md`, `packages/mobile/README.md`):

- Release: `com.yee94.openchamber`
- Android debug suffix: `com.yee94.openchamber.debug`
- Java/R namespace still `com.openchamber.app` (do not confuse with the install id)
- App Group: `group.com.yee94.openchamber`

Lynx must keep the same install identity if it is meant to replace or sit beside this client. Changing the Android application id without a matching FCM `google-services.json` entry is a known outage (see `docs/lynx-pitfalls.md`).

## Official mobile IA (contrast)

Committed README screenshots (`docs/references/`):

| Asset | Surface |
|---|---|
| `mobile_projects.png` | Projects home — collapsing title, search, project cards, session rows, floating four-tab dock |
| `mobile_schedules.png` | Scheduled tab — task cards, status discs, same dock |
| `mobile_chat.png` | Pushed chat — detail-nav back, transcript, composer foot |
| `chat_mobile_dark.png` | Dark chat |

`docs/references/screenshots/README.md` also allows an optional `mobile.png` for the root README. That placeholder is **not** committed.

IA facts that Lynx must not “improve”:

1. **Four root tabs only.** Chat is a **pushed secondary page**, never a fifth dock item (`mobileTabs.ts`, `mobileNavigation.ts`).
2. Projects / Assistant / Scheduled / Settings are siblings. Assistant conversation and session chat reuse the same second-level page chrome (`MobileDetailNavigation`).
3. Phone overlays (sessions, files, changes, MCP, update) are **sheets**, not extra tabs (`MobileApp.tsx` window IDs).
4. iPad is a different layout: persistent sessions sidebar, Files/Changes side panel, Settings half-sheet. Do not flatten iPad into the phone dock.
5. Connection onboarding is Capacitor-only. Hosted H5 never shows that welcome.

Flutter-track goldens on `work/flutter-native` (`docs/flutter-native-screenshots/`) are a **sibling** visual review, not this track’s source of truth. Prefer the official `docs/references/mobile_*.png` photos when IA disagrees.

## Navigation contract

### Root tabs (`MobileTabId`)

| Tab id | Icon | i18n key | Source |
|---|---|---|---|
| `projects` | `folder-open` | `mobile.tabs.projects` | `packages/ui/src/mobile/mobileTabs.ts` |
| `assistant` | `sparkling` | `mobile.tabs.assistant` | same |
| `scheduled` | `calendar-schedule` | `mobile.tabs.scheduled` | same |
| `settings` | `settings-3` | `mobile.tabs.settings` | same |

Native iOS 26 optional overlay: `OpenChamberTabBar` (`packages/ui/src/lib/native-ios-tab-bar.ts`). Android and hosted H5 keep the Web `MobileTabBar`. Adoption is gated by `openchamber.iosNativeUi`.

### Secondary pages (`MobileSecondaryState`)

| Kind | Purpose | Source |
|---|---|---|
| `chat` | Metadata-only route stack; phone renders top + predecessor | `mobileNavigation.ts` |
| `draft` | New-session draft composer | same |
| `assistant` | Assistant conversation page | same |
| `instances` | Instance management above Projects | same |

Back priority (`MOBILE_BACK_PRIORITY`): overlays `0` → secondary page `1` → root tab `2`.

Phone chat stack: arbitrary-depth metadata, two-page DOM window, native edge / Predictive Back (`packages/mobile/README.md` § Native Back Navigation, `packages/ui/src/mobile/mobileBackNavigation.ts`). Hosted H5 has **no** page-back touch gesture; it uses history `popstate`.

### Overlay window IDs (`MobileApp.tsx`)

| Window ID | Surface |
|---|---|
| `mobile-sessions` | Sessions sheet / iPad sidebar |
| `mobile-files` | Files browser sheet |
| `mobile-direct-file` | Single-file preview |
| `mobile-changes` | Changes list |
| `mobile-direct-diff` | Single-file diff |
| `mobile-turn-diff` | Turn diff |
| `mobile-mcp` | MCP panel |
| `mobile-settings` | Settings half-sheet (**iPad only**) |
| `mobile-update` | Update dialog |
| `mobile-overflow-menu` | Chat overflow popover |

Shared primitive: `packages/ui/src/components/ui/MobileResizableSheet.tsx`. Overlay root: `#mobile-overlay-root`.

### Shared URL path contract (deep links / hosted H5 / desktop)

From `packages/ui/src/router/DOCUMENTATION.md` and `pathContract.ts`:

| Primary | Paths |
|---|---|
| session | `/session/$id`, `/session/$id/{git,diff,terminal,files,diagram,plan}` |
| new session | `/session/new`, `/new` |
| schedule | `/schedule`, `/schedule/history`, `/schedule/tasks/$projectId/$taskId` |
| assistant | `/assistant`, `/assistant/$assistantId` |
| settings | `/settings/$slug[/$entityId]` |
| connect | `/connect` |

Phone primary navigation is **store-based tabs**, not these URLs. The path contract still applies to deep links and hosted H5 history.

### Deep links (`openchamber://`)

Source: `packages/ui/src/apps/deepLinks.ts`, applied in `deepLinkNavigation.ts`.

| Route | Intent |
|---|---|
| `connect?v=2&p=…` | pairing v2 redeem |
| `session/$id` | open session |
| `new-session` / `new` | new session |
| `open-project` / `project/…` | open project directory |
| `sessions?filter=` | `all` \| `attention` \| `recent` |
| `status` | status |
| `settings[/section]` | settings slug |
| `changes[/path]` | changes |
| `view/{files,mcp,instances,update}` | overlay view |

Legacy pairing v1 direct links are rejected (`packages/ui/src/apps/mobileQrScan.test.ts`).

## Settings slugs (complete)

Canonical type: `SettingsPageSlug` in `packages/ui/src/lib/settings/metadata.ts`.

### All 26 slugs

| Slug | Title | Group | Kind | In `MOBILE_SETTINGS_PAGE_SLUGS` | Availability |
|---|---|---|---|---|---|
| `home` | Settings | personalization | single | **No** (nav shell, not a listed page) | all |
| `instances` | Switch instance | connection | single | **Yes** | `ctx.isMobile` only |
| `appearance` | Appearance | personalization | single | Yes | all |
| `chat` | Chat | personalization | single | Yes | all |
| `notifications` | Notifications | personalization | single | Yes | all |
| `sessions` | Sessions | personalization | single | Yes | all |
| `summary-ai` | Summary AI | personalization | single | Yes | all |
| `shortcuts` | Shortcuts | personalization | single | **No** | `!ctx.isVSCode` |
| `projects` | Projects | workspace | split | Yes | all |
| `git` | Git | workspace | single | Yes | `!ctx.isVSCode` |
| `remote-instances` | Remote Instances | workspace | single | **No** | `!ctx.isVSCode` |
| `providers` | Providers | opencode | split | Yes | all |
| `agents` | Agents | opencode | split | Yes | all |
| `assistants` | Assistants | opencode | split | Yes | all |
| `behavior` | Behavior | opencode | single | Yes | all |
| `commands` | Commands | opencode | split | Yes | all |
| `mcp` | MCP | opencode | split | Yes | all |
| `plugins` | Plugins | opencode | split | Yes | all |
| `global-config` | Global Configuration | opencode | single | **No** | all |
| `magic-prompts` | Magic Prompts | content | split | Yes | `!ctx.isVSCode` |
| `snippets` | Snippets | content | split | Yes | all |
| `skills.installed` | Skills | content | split | Yes | all |
| `skills.catalog` | Skills Catalog | content | single | **No** | all |
| `usage` | Usage | system | split | Yes | all |
| `voice` | Voice | system | single | Yes | `!ctx.isVSCode` |
| `about` | About | system | single | Yes | `ctx.isMobile` only |

Mobile phone Settings tab hosts `SettingsView` with `visiblePageSlugs={[...MOBILE_SETTINGS_PAGE_SLUGS]}` (`MobileSettingsTab.tsx`, `MobileApp.tsx`). That is **21** listed pages.

Excluded from the dedicated mobile list (still exist on desktop/web): `home` (search shell only), `shortcuts`, `remote-instances`, `global-config`, `skills.catalog`.

### Settings page → component map

From `packages/ui/src/components/views/SettingsView.tsx`:

| Slug | Component |
|---|---|
| `home` | inline `SettingsHome` |
| `projects` | `ProjectsPage` |
| `instances` | `MobileInstancesSurface` (Capacitor only) |
| `remote-instances` | `RemoteInstancesPage` |
| `appearance` | `OpenChamberPage section="visual"` |
| `chat` | `OpenChamberPage section="chat"` |
| `shortcuts` | `OpenChamberPage section="shortcuts"` |
| `sessions` | `OpenChamberPage section="sessions"` |
| `summary-ai` | `OpenChamberPage section="summary-ai"` |
| `notifications` | `OpenChamberPage section="notifications"` |
| `voice` | `OpenChamberPage section="voice"` |
| `about` | `AboutSettings` |
| `providers` | `ProvidersPage` |
| `usage` | `UsagePage` |
| `agents` | `AgentsPage` |
| `assistants` | `AssistantsSettingsPage` |
| `behavior` | `BehaviorPage` |
| `commands` | `CommandsPage` |
| `mcp` | `McpPage` |
| `plugins` | `PluginsPage` |
| `global-config` | `GlobalConfigPage` |
| `skills.installed` | `SkillsPage` |
| `skills.catalog` | `SkillsCatalogPage` |
| `git` | `GitPage` |
| `magic-prompts` | `MagicPromptsPage` |
| `snippets` | `SnippetsPage` |

Search index: `packages/ui/src/lib/settings/search.ts`.

Appearance mobile-only fields that exist in Cap/web (do not invent extras):

- `mobileKeyboardMode` — hosted H5 (`native` \| `resize-content`)
- `openchamber.iosNativeUi` — Capacitor iOS WebView-era native composer + tab bar (default off)
- theme / font / spacing / PWA install name — `OpenChamberVisualSettings`

Default theme IDs that **do** exist: `flexoki-light` / `flexoki-dark` (`packages/ui/src/lib/theme/themes/index.ts`). That is a theme name, not a separate product.

## Feature areas

Counts below are inventory rows (user-visible capabilities + owning modules), not story points.

### 1. Auth and connection (Capacitor-only)

| Feature | Source |
|---|---|
| Welcome / connect screen | `MobileApp.tsx` → `MobileConnectionWelcome` |
| Saved instances + connect / delete | `mobileConnections.ts`, `MobileInstancesSurface` |
| Password unlock for protected servers | `useMobileConnection`, `submitPassword` |
| QR scan pairing v2 | `mobileQrScan.ts`, `MobilePairingLinkForm.tsx` |
| Pairing link paste / redeem | `MobilePairingLinkForm.tsx`, `connectionPayload.ts` |
| Manual URL + client token | welcome + instances surfaces |
| Ordered LAN + relay transport candidates | `mobileConnections.ts` (`MobileTransportCandidate`) |
| Secure token storage (Keychain / Keystore) | `mobileConnections.ts`, `@aparajita/capacitor-secure-storage` |
| Deep link `openchamber://connect` | `deepLinks.ts` |
| Auto-connect last instance | `autoConnectLastInstance` in `mobileConnections.ts` |
| Reachability badge: local network vs relay | `packages/docs/content/docs/zh-cn/mobile.mdx` |

**There is no Nearby / Bonjour / mDNS client.** Pairing v2 explicitly excluded LAN discovery (`docs/pairing-v2-implementation-plan.md`). “家庭网络 / 本地网络” means a **direct HTTP candidate** the user already paired, not device browse. See `docs/lynx-pitfalls.md`.

### 2. Projects tab (chat list / home)

| Feature | Source |
|---|---|
| Project cards + worktree groups | `mobile/projects/MobileProjectsHome.tsx`, `MobileProjectCard.tsx` |
| Session rows | `MobileSessionRow.tsx` |
| Search | `mobileProjectSearch.ts` |
| Pinned / in-progress sections | `MobileProjectsHomeContainer.tsx`, `useMobileProjectsHomeModel.ts` |
| Home subtitle `项目 · 分支` | `formatHomeSessionSubtitle` in `useMobileProjectsHomeModel.ts` |
| Swipe / long-press session actions | `MobileRowActionsSheet.tsx`, `sessionMenuModel.ts` |
| New session draft | `mobileNavigation.ts` `kind: 'draft'` |
| Add project | `DirectoryExplorerDialog` from `MobileApp` |
| Header QR / switch instance | `MobileProjectsHome` |
| Session indicators (busy, questions) | `mobileSessionIndicator.ts` |
| Unread / attention dots | projects home model + CHANGELOG 1.19.2 |

### 3. Chat (session conversation)

| Feature | Source |
|---|---|
| Phone chat shell (header, back, menu) | `mobile/chat/MobileChatScreen.tsx`, `MobileChatHeader.tsx` |
| Shared transcript + composer | `ChatView.tsx`, `ChatContainer.tsx`, `ChatInput.tsx`, `MessageList.tsx` |
| **1.19 LegendList timeline** | `TimelineList.tsx` — one list owns history + live tail |
| Context usage | `MobileContextProgressButton.tsx`, `mobileContextUsage.ts` |
| ~~Transcript sync hint~~ | `useMobileTranscriptSyncHint.ts` → Lynx `transcriptSyncHint.ts` (**代码接上** Next #57; no Cap Zustand flights) |
| Sessions sheet | `MobileSessionsSheet.tsx` |
| Edge-swipe session switch (composer) | `useEdgeSwipeSessionSwitch.ts` |
| ~~Header swipe → sessions~~ | `useHeaderSwipeToSessions.ts` → Lynx `headerSwipeToSessions.ts` (**代码接上** Next #57; host pan bind thin) |
| Overflow menu | `MobileApp.tsx` (`mobile-overflow-menu`) |
| Tool patch sheets (`edit`, `multiedit`, `apply_patch`) | `MobileChangesSurface.tsx` |
| Turn / direct diffs | `MobileChangesSurface.tsx`, `DiffView` |
| Files surface | `MobileFilesSurface.tsx` (HTML preview via `runtimeFetch`, not iframe `src` on relay) |
| MCP sheet | `McpDropdown` in `MobileApp.tsx` |
| Session status bar | `MobileSessionStatusBar.tsx` |
| Questions / permissions | chat question cards in `ChatContainer` |
| Activity / sorted / collapsed turns | `packages/ui/src/components/chat/DOCUMENTATION.md` |
| Queue chips + goal strip | `QueuedMessageChips`, `SessionGoalRow` |
| Load-older (mobile: **button only**, no scroll auto-load) | `useChatTimelineController` |
| Nested child session push | `mobileNavigation.ts` + `ChatContainer` predecessor page |
| Interactive back | `mobileBackNavigation.ts`, `OpenChamberNavigation` |
| Compaction / `/compact` activity | chat DOCUMENTATION |
| Markstream assistant markdown (Cap experiment) | `useFeatureFlagsStore.ts` `oc:markstream-react` |

### 4. Compose

| Feature | Source |
|---|---|
| Web composer (Android + hosted + iOS default) | `ChatInput.tsx`, `packages/ui/src/composer/` |
| Native iOS composer overlay | `packages/ui/src/lib/native-ios-composer.ts`, `OpenChamberComposer` |
| Gated by `openchamber.iosNativeUi` | `iosNativeUi.ts`, Appearance settings |
| Send / Stop / queue while busy | `composer-send-manager.ts`, ChatInput |
| Attachments + citations | composer `DOCUMENTATION.md` |
| Autocomplete `/` `@` | `packages/ui/src/lib/composer-autocomplete/` |
| Agent cycle / model picker | ChatInput + native forwards |
| Android native photo picker | `native-media-pick.ts`, `OpenChamberMedia.pickMedia` |
| HEIC transcode | `native-image-transcode.ts` |
| Keyboard lift / IME | `androidKeyboardTransition.ts`, Capacitor Keyboard `resize: 'none'` |
| Dictation (existing WebView / server path only) | `ComposerDictation.tsx`, `useDictation.ts` |
| Draft persistence | composer + sync restoration modules |

### 5. Assistant tab

| Feature | Source |
|---|---|
| Catalog cards | `mobile/assistant/MobileAssistantTab.tsx` |
| Onboarding / enable guide | same + Settings → Assistants |
| Conversation as secondary page | `AssistantView.tsx`, `MobilePhoneShell` |
| Continuous vs stateless modes | `packages/ui/src/components/assistants/DOCUMENTATION.md` |
| Share welcome (native only) | `AssistantShareWelcome` |
| Context menu: edit, delete, share guide | `MobileAssistantTab.tsx` |
| Jump from assistant reply into source session | `openSession` on phone |

### 6. Scheduled tasks tab

| Feature | Source |
|---|---|
| Tab scaffold | `mobile/scheduled/MobileScheduledTab.tsx` |
| Task list + history | `ScheduledTasksDialog.tsx` → `ScheduledTasksWorkspace` |
| Task editor overlay | `ScheduledTaskEditorDialog` + mobile back |
| Run now / delete / CRUD | `scheduledTasksApi.ts` |

### 7. Settings tab

| Feature | Source |
|---|---|
| Full settings nav + search | `MobileSettingsTab.tsx` → `SettingsView` |
| Split collection → entity editor | `SettingsView.tsx` |
| All 21 mobile slugs above | `components/sections/*` |
| Instance management | `MobileInstancesSurface` |

### 8. Share (native)

| Feature | Source |
|---|---|
| Share inbox bridge | `MobileShareBridge.tsx`, `packages/mobile/src/openchamber-share.ts` |
| iOS Share Extension | `packages/mobile/ios/.../OpenChamberShareExtension/` |
| Android `ShareReceiverActivity` | Android sources in `packages/mobile/android/` |
| Generic-share Assistant picker | `MobileShareRecipientPicker.tsx` (full page, not a sheet) |
| Draft handoff to composer | `mobileShareDraftHandoff.ts` |
| Direct Share / shortcuts | `packages/mobile/README.md` § Native Share Inbox |
| iOS `INSendMessageIntent` donations | README + assistants DOCUMENTATION |

### 9. Notifications, push, Live Activity

| Feature | Source |
|---|---|
| Notification settings | `NotificationSettings.tsx` (`slug: notifications`) |
| Native push (APNs / FCM) | `useNativePushRegistration.ts` |
| Push tap → deep link | `deepLinkNavigation.ts` |
| Live Activity (iOS 17+) | `useNativeLiveActivity.ts`, `OpenChamberLiveActivity` |
| Web push (H5/PWA only) | `NotificationSettings.tsx`, `packages/web/src/sw.ts` |
| Server APNs + FCM relay | `packages/web/server/lib/notifications/` |

FCM package names must match `packages/mobile/android/app/google-services.json` (`com.yee94.openchamber` and `.debug`).

### 10. Updates and About

| Feature | Source |
|---|---|
| About page (mobile-only slug) | `AboutSettings.tsx` |
| Native client version ≠ instance OpenChamber / OpenCode versions | `mobileAppVersion.ts` |
| Capgo self-hosted OTA | `packages/ui/src/lib/mobile-updates/` (`capgoAdapter.ts`, `coordinator.ts`) |
| OTA notice UI | `MobileOtaUpdateNotice.tsx` |
| Android APK opens system browser | `OpenChamberExternalBrowser` |
| Diagnostics export via system save picker | `AboutSettings` + `OpenChamberMedia.saveFile` |
| Prerelease / TestFlight / APK links | `docs/RELEASING.md`, `packages/mobile/README.md` |

Capgo **is** in this repo (`@capgo/capacitor-updater`). It is the Capacitor **web-bundle** OTA path. A Lynx native binary is not a web bundle; do not invent a second Capgo product. See pitfalls.

### 11. Voice (existing only — do not invent)

| Feature | Source |
|---|---|
| Settings page `voice` | `VoiceSettings.tsx` |
| Composer dictation (WebView `getUserMedia` + `/api/dictation/ws`) | `useDictation.ts`, `dictation-client.ts` |
| Server / browser / on-device **web** STT options | `packages/docs/content/docs/voice.mdx` |
| TTS speak | `useLocalTTS.ts` → `/api/dictation/tts/speak` |
| Browser TTS preview | `browserVoiceService.ts` |
| Mic permission copy | iOS `Info.plist`, Android `AndroidManifest.xml` |

There is **no** Capacitor native ASR plugin. Phone docs already warn that mobile-browser built-in TTS is weak. Lynx must not add Siri, system speech recognizer, or a new on-device model unless that exact Cap/web path is being ported.

### 12. Native chrome and system integration

| Feature | Source |
|---|---|
| Status bar overlay | Capacitor `StatusBar`, `MobileApp.tsx` |
| Haptics | `OpenChamberHaptics` |
| Physical scale / pt | `OpenChamberPhysicalScale`, `designPtScale.ts` |
| Virtual progressive images | `openchamber-virtual-asset.ts` (`openchamber-asset://`) |
| iOS widgets + Control Center | `mobileWidgetSnapshot.ts`, `OpenChamberWidget` |
| Native back / Predictive Back | `OpenChamberNavigation` |

## First-party Capacitor plugins

| Plugin | Platforms | Purpose | TS / native |
|---|---|---|---|
| `OpenChamberShare` | iOS, Android | Share inbox / drafts / assistant catalog | `packages/mobile/src/openchamber-share.ts` |
| `OpenChamberVirtualAsset` | iOS, Android | Streaming virtual image URLs | `openchamber-virtual-asset.ts` |
| `OpenChamberMedia` | iOS, Android | HEIC, save picker, Android photo picker | `native-media-pick.ts` |
| `OpenChamberNavigation` | iOS, Android | Edge / back gesture progress | `mobileBackNavigation.ts` |
| `OpenChamberHaptics` | iOS, Android | Impact feedback | haptics hooks |
| `OpenChamberPhysicalScale` | iOS, Android | Display metrics | `designPtScale.ts` |
| `OpenChamberComposer` | **iOS only** | Native glass composer | `native-ios-composer.ts` |
| `OpenChamberTabBar` | **iOS only** (26+) | Native liquid-glass dock | `native-ios-tab-bar.ts` |
| `OpenChamberLiveActivity` | **iOS only** (17+) | Dynamic Island / lock screen | `native-ios-live-activity.ts` |
| `OpenChamberExternalBrowser` | **Android only** | System browser for APK URLs | Android plugin |
| `CapacitorUpdater` | iOS, Android | Capgo self-hosted OTA | `openchamber-ota.ts` |

Third-party: `@capacitor/keyboard`, `@capacitor/status-bar`, `@capacitor/push-notifications`, `@capacitor/app`, `@aparajita/capacitor-secure-storage`.

Contracts live under `packages/mobile/contracts/`.

## Chat list engine (Lynx hard contract)

Cap/web **runtime default on current `main`** is TanStack Virtual (`useFeatureFlagsStore.ts`: `oc:legend-timeline` must be exactly `'1'` to opt into LegendList). That is a Capacitor A/B leftover after 1.19.5-beta.7 flipped the default back (`CHANGELOG.md`).

**This Lynx track does not follow that default.**

Lynx list semantics are the **1.19 LegendList** contract in `packages/ui/src/components/chat/TimelineList.tsx`:

- One list owns history turns **and** the live streaming tail (single scroll position).
- `initialScrollAtEnd` opens at the live edge.
- `maintainScrollAtEnd` follows growth (including footer height).
- `maintainVisibleContentPosition` preserves the read position on history prepend.
- Just-sent turn parks with a real trailing spacer item; do not write scroll to fight iOS rubber-band.
- **Rows are never recycled** (tool-call expand / reveal state).
- Mobile load-older is an explicit top button, not scroll auto-load.

**Forbidden:** bringing back the 1.18 TanStack Virtual split (`StaticHistoryList` + `StreamingTailContent`, `anchorTo: 'end'`, `followOnAppend`, auto-follow pin, force-bottom watchdog). See `docs/lynx-pitfalls.md`.

Markstream `maxLiveNodes` is **in-bubble** node virtualization. It does not replace the chat list.

## Brands that exist vs do not invent

| Name | In this repo? | What it actually is |
|---|---|---|
| **Flexoki** | Yes | Default theme pair `flexoki-light` / `flexoki-dark` |
| **Capgo** | Yes | Self-hosted Capacitor web-bundle OTA (`@capgo/capacitor-updater`) |
| **Finder** | Desktop only | macOS reveal-in-Finder (`openInApps.ts`). **Not** a mobile file manager |
| Expo / Flutter (this track) | No | Flutter is a **sibling** branch. This track is Lynx |
| Bonjour / Nearby browse | No | Not implemented |
| Native ASR product | No | Only the existing voice settings + WebView dictation |

## Inventory size

| Bucket | Count |
|---|---|
| Root tabs | 4 |
| Secondary page kinds | 4 |
| Overlay window IDs | 10 |
| Settings slugs (all) | 26 |
| Settings slugs on mobile tab | 21 |
| Deep-link intent types | 9 |
| First-party native plugins | 11 |
| Feature-area rows in this file | ~120 |

Lynx starts from **zero landed product surfaces**. Use `docs/lynx-gap-board.md` for status.

## Related docs

- `docs/lynx-pitfalls.md` — hard “do not” list
- `docs/lynx-gap-board.md` — landed / missing / Android downgrade / next / 真机残差 / 故意不移植
- `docs/lynx-acceptance.md` — 三关 + harness + host chrome
- `docs/lynx-ia-ui.md` — IA, glass, embedding
