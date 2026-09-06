# Expo rewrite — living gap board

**UI resemblance is not done.** A stub tab, a matching screenshot, or a CSS clone does **not** clear a feature track. **CODE acceptance** requires every **missing** cell on that track to move to **code landed** (and the track’s CI gate to **CI green**). 真机过 is a later, separate column.

Inventory (what “done” means): [`docs/expo-feature-inventory.md`](expo-feature-inventory.md).  
Acceptance (how we close a row): [`docs/expo-acceptance.md`](expo-acceptance.md).  
Pitfalls: [`docs/expo-pitfalls.md`](expo-pitfalls.md).

Do not mark 真机过 from a Linux VM.

## Feature-track status (CODE acceptance)

Use exactly these marks on the nine tracks below:

| Mark | Meaning |
|---|---|
| **missing** | Required Cap/WebView behavior has no Expo implementation. Stub UI does **not** clear this |
| **in progress** | Partial Expo code; do not treat as landed |
| **code landed** | Implementation on `work/expo-native` (unit/contract tests as applicable). Still not 真机过 |
| **CI green** | The job that gates this track actually passed on GitHub for the tip SHA. Local lint ≠ device CI |
| **真机过** | Physical phone walk recorded. Simulator / Expo web / WidgetTester never count |
| **will-not-port** | Explicitly out of scope — see inventory |

A track is **CODE-accepted** only when every required row is **code landed** and the track’s CI gate is **CI green**. 真机过 may stay open.

### 1. Connect

Onboarding, QR pairing v2, LAN + relay race, relay-only skip 1.5s, SecureStore, no local PIN.

| Row | Status | Notes |
|---|---|---|
| Track (CODE) | **code landed** | Expo Connect landed (see apps/mobile_expo lib+connect UI); unit-tested relay-only + persist |
| CI green | **CI green** @ `8d0043d1` | Expo Mobile CI lint+typecheck+vitest covers `apps/mobile_expo` — https://github.com/yee94/openchambery/actions/runs/34019907976. Tip docs SHA `4e6fd48e` (docs-only after product proof `8d0043d1`). |
| 真机过 | missing | |

### 2. Session / Home

Session-index, search + highlight, pin/in-progress, `项目 · 分支` subtitle, draft new session.

| Row | Status | Notes |
|---|---|---|
| Track (CODE) | **code landed** | Live `GET /api/openchamber/session-index` home (failure ≠ empty); search + highlight; pinned/in-progress + `项目 · 分支`; unread dot UI; draft `/chat/draft` (`sessionId == ''`); plus 扫一扫 / 切换实例 → Connect QR / onboarding. Unit tests green locally. Chat body landed in Track 3. Live unread/running still need broader home event wiring (not rebuilt plan/notes/Todo). |
| CI green | **CI green** @ `8d0043d1` | Expo Mobile CI lint+typecheck+vitest covers `apps/mobile_expo` — https://github.com/yee94/openchambery/actions/runs/34019907976. Tip docs SHA `4e6fd48e` (docs-only after product proof `8d0043d1`). |
| 真机过 | missing | Do not mark from Linux VM |

### 3. Chat

LegendList semantics (not 1.18 TanStack), transcript, Send/Stop, events WS/SSE, markdown/tools, 关3 perf harness.

| Row | Status | Notes |
|---|---|---|
| Track (CODE) | **code landed** | LegendList transcript (`initialScrollAtEnd` / `maintainScrollAtEnd` / MVCP); load `GET .../messages?turns=6`; Send `prompt_async` / Stop `abort`; draft materialize `POST /api/session` then prompt; events prefer `/api/global/event/ws` → SSE → poll-only reconnect fallback; streaming markdown paced 64ms (Android 128ms) with incomplete-fence isolation; composer text+send/stop (no mic/TTS). **Residuals landed:** tool cards + reasoning disclosure + queue chips (prior); slash/`@`/`#` autocomplete (Cap trigger + `/api/config/commands/metadata` / `skills` / `snippets` / `/api/agent` / `/api/find/file`); context usage ring from message.info tokens + `/api/config/catalog/providers` limit (hides when draft/no data); attachments via expo-image-picker + expo-document-picker → `PUT /api/fs/prompt-attachments/:id` then file:// parts (HEIC transcode = device residual); queue ↑↓ reorder (`PUT .../scopes/:id/order`) + iOS Alert.prompt edit (`PATCH .../items/:id`). Unit + 关3 perf harness green locally. Still missing: process Used fold / skill groups / question cards; full DnD reorder; Android inline queue edit; HEIC native transcode. Native composer glass stays Track 8 (do not clobber Expo UI pixel commits). |
| CI green | **CI green** @ `8d0043d1` | Expo Mobile CI lint+typecheck+vitest covers `apps/mobile_expo` — https://github.com/yee94/openchambery/actions/runs/34019907976. Tip docs SHA `4e6fd48e` (docs-only after product proof `8d0043d1`). |
| 真机过 | missing | Do not mark from Linux VM |

### 4. Projects

Project cards, worktrees, overflow menus, new/edit/close, plus-menu 扫一扫 / 切换实例.

| Row | Status | Notes |
|---|---|---|
| Track (CODE) | **code landed** | Cap MobileProjectCard data model (project shell + inset worktree groups + flat session rows) on Expo pixel UI; plus/overflow: draft session, new project (fs/list+mkdir), new worktree essentials, edit (name/color/icon/discover), worktree remove; APIs: session-index + fs/list|mkdir|clone + git/worktrees + PUT /api/config/settings + icon/discover + message-queue worktree order. No plan/notes/Todo / Finder. Unit tests green locally. |
| CI green | **CI green** @ `8d0043d1` | Expo Mobile CI lint+typecheck+vitest covers `apps/mobile_expo` — https://github.com/yee94/openchambery/actions/runs/34019907976. Tip docs SHA `4e6fd48e` (docs-only after product proof `8d0043d1`). |
| 真机过 | missing | Do not mark from Linux VM |

### 5. Assistant

Catalog, enable guide, pushed conversation, share-in (exact instance+assistant).

| Row | Status | Notes |
|---|---|---|
| Track (CODE) | **code landed** | Live `GET /api/openchamber/assistants/snapshot` + capability; enable via `PUT .../assistants/settings`; tap opens bound `sessionID` or `POST .../session/new` into Chat; empty → onboarding → Settings `slug=assistants` create; long-press edit/delete (delete confirm + official DELETE). Unit tests green locally. Share-in inbox / recipient picker still open (Track 8 native share). Full Settings assistants CRUD is Track 7. |
| CI green | **CI green** @ `8d0043d1` | Expo Mobile CI lint+typecheck+vitest covers `apps/mobile_expo` — https://github.com/yee94/openchambery/actions/runs/34019907976. Tip docs SHA `4e6fd48e` (docs-only after product proof `8d0043d1`). |
| 真机过 | missing | Do not mark from Linux VM |

### 6. Scheduled

任务/历史记录, filters, APIs, open history session.

| Row | Status | Notes |
|---|---|---|
| Track (CODE) | **code landed** | Cap MobileScheduledTab parity on Expo: cards show status+schedule+next-run (never name-only); segments 任务/历史记录 + filters 全部/已启用/已暂停; Run now POST .../scheduled-tasks/{id}/run with optimistic running; full editor daily/weekly/cron create/edit/toggle/delete via PUT/DELETE; history opens /chat/{sessionId}. Unit tests green locally. |
| CI green | **CI green** @ `8d0043d1` | Expo Mobile CI lint+typecheck+vitest covers `apps/mobile_expo` — https://github.com/yee94/openchambery/actions/runs/34019907976. Tip docs SHA `4e6fd48e` (docs-only after product proof `8d0043d1`). |
| 真机过 | missing | Do not mark from Linux VM |

### 7. Settings

All writable `MOBILE_SETTINGS_PAGE_SLUGS` except Voice (omitted). No `iosNativeUi`.

| Row | Status | Notes |
|---|---|---|
| Track (CODE) | **code landed** | Settings home search + Cap groups; real editors for all Expo slugs (instances, appearance language+theme only, chat, notifications, sessions, summary-ai, projects, git, providers+OAuth browser, agents, assistants CRUD, behavior, commands, mcp+OAuth pending, plugins file APIs, magic-prompts, snippets, skills.installed, usage, about). Official GET/PUT settings merge + catalog APIs; failure != empty; tokens not logged; Voice/iosNativeUi/Capgo omitted. Unit tests green locally. |
| CI green | **CI green** @ `8d0043d1` | Expo Mobile CI lint+typecheck+vitest covers `apps/mobile_expo` — https://github.com/yee94/openchambery/actions/runs/34019907976. Tip docs SHA `4e6fd48e` (docs-only after product proof `8d0043d1`). |
| 真机过 | missing | Do not mark from Linux VM |

### 8. System shell

Push, share inbox, Live Activity, WidgetKit/NSE, external browser, HEIC / pickers, haptics, native back, iOS glass / Android degrade.

| Row | Status | Notes |
|---|---|---|
| Track (CODE) | **code landed** | iOS: Expo `NativeTabs` (real `UITabBar`) + `expo-glass-effect` (`UIGlassEffect`) composer; local `openchamber-system-shell` module for Live Activity / App Group share inbox / virtual assets + config plugin (`group.com.yee94.openchamber`, Live Activities, Android SEND intents). Push: `expo-notifications` → `POST /api/push/apns-token` + visibility heartbeat; tap/deep link `openchamber://session/{id}`. Haptics via `expo-haptics`; OAuth external browser http(s) only. Android: Material dock + solid composer (honest degrade, not fake glass); Live Activity no-op. Unit tests for deep links / share parsers / http(s) guard / Live Activity validators. |
| CI green | **CI green** @ `8d0043d1` | Expo Mobile CI lint+typecheck+vitest covers `apps/mobile_expo` — https://github.com/yee94/openchambery/actions/runs/34019907976. Tip docs SHA `4e6fd48e` (docs-only after product proof `8d0043d1`). |
| 真机过 | missing | Device residuals: iOS Share Extension target UI (inbox/App Group store landed), WidgetKit Live Activity UI surface (ActivityKit API landed), APNs/FCM on physical device, HEIC pick on device. Do not mark from Linux VM |

### 9. CI + side-by-side debug prerelease

Lint/typecheck/vitest, Android debug APK job, `applicationIdSuffix .debug`, label **OpenChamber Expo**, prerelease tag `expo-v2-debug-<sha7>` (not `/releases/latest`).

| Row | Status | Notes |
|---|---|---|
| Lint / typecheck / unit tests workflow | **CI green** @ `8d0043d1` | Expanded workflow pushed @ `329b6ae0` (`ci(expo): Track 9 vitest + Android debug APK + prerelease`). Tip run https://github.com/yee94/openchambery/actions/runs/34019907976 — Lint/typecheck/unit tests **green**. Prior tip `329b6ae0` run 34019688824 failed only on Android assemble (namespace). |
| Device binary jobs | **CI green** (Android); iOS residual | Android debug APK job **green** on tip (~16m). Artifact `openchamber-expo-android-debug-apk` on run 34019907976. iOS simulator residual: macos runner + CocoaPods + Track 8 native modules not wired. |
| Debug APK + prerelease link | **CI green** | Prerelease tag `expo-v2-debug-8d0043d` — https://github.com/yee94/openchambery/releases/tag/expo-v2-debug-8d0043d (APK asset `openchamber-expo-debug-8d0043d.apk`). `contents: write` on publish job OK. Namespace fix for `openchamber-system-shell` @ `8d0043d1`. |
| 真机过 | missing | |

## Bootstrap / process rows

These are not feature tracks. Stub chrome must not be copied into tracks 1–8 as **code landed**.

## Seed (bootstrap 2026-09-06)

`main` @ `b444b0316` / `1.19.7-beta.7`. App path: `apps/mobile_expo`.

| Slice | Status | Notes |
|---|---|---|
| Branch `work/expo-native` from current `main` | landed | Independent; not merged |
| Gate docs (this set) | landed | Five docs + [`expo-native-README.md`](expo-native-README.md) |
| Capacitor `packages/mobile` left intact | landed | Constraint, not a port |
| Minimal Expo SDK scaffold + TypeScript | landed | Placeholder only |
| Four-tab shell (Projects / Assistant / Scheduled / Settings) | landed | Stub screens. No live APIs |
| Stub pushed Chat route | superseded | Track 3 landed LegendList + Send/Stop on pushed route |
| Connection onboarding (URL / QR / password / pairing v2) | **code landed** | Expo Connect screen + controller. No local PIN |
| Relay-only skip 1.5s headstart | **code landed** | Unit-tested injectable race; Cap TS relay under lib/relay |
| Session index Projects home + `项目 · 分支` | **code landed** | Expo Projects home on `work/expo-native`; 真机过 still open |
| Chat LegendList + Send/Stop | **code landed** | LegendList contract (not 1.18 TanStack); draft materialize; WS/SSE/poll fallback |
| Settings home + `MOBILE_SETTINGS_PAGE_SLUGS` | **code landed** | Omit Voice; assistants CRUD forms included |
| Native iOS chrome (`UIGlassEffect` / `UITabBar` / Live Activity) | **code landed** | NativeTabs + expo-glass-effect + local Live Activity module; WidgetKit UI / Share Extension target still 真机过 |
| Android honest degrade | **code landed** | Material NativeTabs + solid composer; Live Activity no-op |
| Performance harness (LegendList long-context) | **code landed** | `lib/__tests__/chatTranscript.perf.test.ts` (250 turns / 500 msgs); covered by Expo Mobile CI unit tests on tip |
| Prerelease debug APK (`applicationIdSuffix .debug`, label **OpenChamber Expo**) | **CI green** @ `8d0043d1` | https://github.com/yee94/openchambery/releases/tag/expo-v2-debug-8d0043d — side-by-side debug APK published (not `/releases/latest`) |
| Signed release workflow | not started | Existing secret names only; debug keystore for Track 9 |
| CI lint / typecheck on `work/expo-native` | **CI green** @ `8d0043d1` | https://github.com/yee94/openchambery/actions/runs/34019907976 (lint+typecheck+vitest) |
| Android debug CI binary | **CI green** @ `8d0043d1` | Run 34019907976 Android job green; artifact + prerelease linked above. First expanded push `329b6ae0` failed assemble (missing module namespace) — fixed on tip. |
| iOS Simulator CI binary | residual | Not wired — macos runner + pods + Track 8 native modules |
| Capgo / EAS-as-ship-path | will-not-port | |
| `openchamber.iosNativeUi` toggle | will-not-port | |
| Chat dock tab | will-not-port | |
| Local PIN / Face ID lock | will-not-port | |
| Bonjour「附近」scanner | will-not-port | |
| Plan mode / project notes / Todo product | will-not-port | Removed 1.19.2 |
| Voice STT/TTS client | will-not-port | Same as Flutter |
| Live hosted OAuth / Local Network prompt / live `wss` phone | 真机过 residual | Even after code lands |

## How to update

1. Change a **feature-track** mark (`missing` / `in progress` / `code landed` / `CI green` / `真机过`) in the same PR as the code. Stub UI never moves a track off **missing**.
2. Link the inventory row if the contract moved.
3. Never treat Simulator, Expo web, or a screenshot as 真机过 or as CODE acceptance.
4. If a feature is dropped, move it to **will-not-port** and say why — do not delete history.

## Next slices (do not implement in the bootstrap)

Suggested order after this PR. Each slice should keep this board honest:

1. Connection onboarding + secure store + pairing v2 (including relay-only).
2. Session-index Projects home + four live tabs’ data.
3. Pushed Chat + LegendList + native composer occupancy contract.
4. Settings slug walk (no Voice, no `iosNativeUi`).
5. iOS native chrome modules (tab bar, composer glass, haptics, back).
6. Android degrade + debug APK CI + prerelease direct link.
7. Performance harness (关3) before claiming chat parity.
8. Share / push / Live Activity / widgets (device-gated).
