# Expo rewrite — 三关 acceptance

A slice is not “mobile done” until the relevant 关 is closed **or** explicitly left as 真机过 residual. Automated green on Linux is never 真机过.

Inventory: [`docs/expo-feature-inventory.md`](expo-feature-inventory.md).  
Board: [`docs/expo-gap-board.md`](expo-gap-board.md).  
Visual contract: [`docs/expo-ia-ui.md`](expo-ia-ui.md).

## 关1 — Feature / API parity vs Cap inventory

**Owner:** Expo implementation track.

Walk [`expo-feature-inventory.md`](expo-feature-inventory.md). Every **required** row must have an Expo implementation that talks to the **same OpenChamber / OpenCode APIs** as Capacitor (SDK v2 + `RuntimeAPIs` / `runtimeFetch` equivalents). Do not invent parallel REST.

Minimum checks (expand as slices land):

| Check | Pass when |
|---|---|
| IA | Four dock roots only; Chat is pushed; no PIN lock; no `iosNativeUi` |
| Connect | `GET /health`, `GET/POST /auth/session`, pairing redeem. Relay-only skips 1.5s |
| Home | `GET /api/openchamber/session-index` (failure ≠ empty). Subtitle `项目 · 分支` |
| Chat | Send/Stop hit official prompt/abort. LegendList contract. Re-enter → latest |
| Settings | All `MOBILE_SETTINGS_PAGE_SLUGS` except **Voice**. No Capgo About updater |
| Events | Prefer `/api/global/event/ws`, SSE fallback |
| Tokens | Secure store; never logged |
| Removals | No plan mode, no notes/Todo product, no Bonjour scanner, no Chat tab |

关1 can be **code-complete** on CI (typed clients + contract tests) while 真机过 remains residual for pairing on a live `wss://` phone, Local Network prompt, and hosted OAuth.

This bootstrap does **not** pass 关1. The inventory exists; the client does not.

## 关2 — Visual / IA vs README screenshots

**Owner:** Expo UI teammate (pixels) + this track (IA contract).

Comparison targets (checked into `main`, shown on the root README):

| File | Surface |
|---|---|
| `docs/references/mobile_projects.png` | Projects home — cards, pin/in-progress, dock |
| `docs/references/mobile_chat.png` | Pushed Chat — transcript, composer, live diff |
| `docs/references/mobile_schedules.png` | Scheduled — segments, status discs, dock |
| `docs/references/chat_mobile_dark.png` | Dark chat reference (secondary) |

**Screenshot ownership**

| Artifact | Who captures | Cadence |
|---|---|---|
| Cap/WebView README shots above | Product / Cap track (already on `main`) | Frozen comparison targets until product changes them |
| Expo device / Simulator shots | **Expo UI teammate** | Each visual slice; store under `docs/expo-native-screenshots/` when that teammate lands them (directory does not exist yet — do not commit placeholder PNGs) |
| Flutter shots on `work/flutter-native` | Flutter track | Not Expo’s source of truth. Useful as “another native rewrite” only |

关2 rules:

- Match **IA and optical sizes** (header 56, dock four roots, project surfaces, `项目 · 分支`), not the screenshot’s accidental UIKit-blue theme. Official `--primary` stays OpenChamber orange / sand. See Flutter’s later note: do not recolor to the photo’s grouped-gray.
- iOS glass must be **real** `UIGlassEffect` / `UITabBar`. A teammate screenshot of a BlurView clone does not pass 关2.
- Android shots must show the **honest degrade**, not a failed glass port.
- This agent does not claim 关2 from a cloud VM.

This bootstrap does **not** pass 关2. Stub tabs are not visual parity.

## 关3 — Performance harness (self-built)

**Owner:** Expo implementation track.

Cap/WebView already has production chat physics and a large MessageList. Flutter built `apps/mobile_flutter/test/chat_transcript_perf_test.dart` as the CI gate. Expo must **build its own** harness — do not import Flutter tests, and do not claim Cap traces we did not record.

### Planned tests (analogous to Flutter `chat_transcript_perf_test`)

Fixture (same order of magnitude as Flutter): **250 turns / 500 messages**, large fenced code, reasoning on every 3rd turn plus the live tail, estimated ≥ 25k lines.

| Gate | Planned bound (tune on first red CI, then freeze) |
|---|---|
| Mount Markdown / row parses | Viewport window, not O(n) |
| First frames after mount | CI CPU wall budget (not a 16ms phone frame) |
| Fling + settle | CI CPU wall budget; parse count capped |
| Identical apply / same ids | 0 list structure rebuilds |
| N SSE tokens on the live tail | 0 neighbor-row rebuilds; paced Markdown (64ms iOS / 128ms Android, matching Cap) |
| Reasoning expand/collapse | Neighbor rows unchanged; collapsed traces unmount Markdown |

Self-compare vs WebView (same session fixture, same device class, once a debug APK exists):

- Time to first latest-edge paint
- Fling frame time (device Timeline / RN perf monitor — **not** claimed from CI)
- Token stream: list rebuild count
- Memory after 500-message mount

CI on Linux can run the harness (Jest/Vitest + RN testing library, or a Detox-free Jest fake list). A Simulator GPU Timeline is **local / 真机过 residual**, same as Flutter’s “Local Timeline (not CI)” section.

There is **no** Expo `integration_test` job in this bootstrap. Do not add one until it actually runs.

### Prerelease debug builds (side-by-side)

When the Android debug APK job exists:

- `applicationIdSuffix .debug` → `com.yee94.openchamber.debug`
- Launcher label **OpenChamber Expo**
- Upload a **GitHub prerelease** (not `/releases/latest`) with a direct APK link, same pattern as Flutter `flutter-v2-debug-*`
- Install beside official **OpenChamber** (`com.yee94.openchamber`) for 关1/关3 walks
- Relay-first walk — do not require LAN

This bootstrap does **not** publish an APK and does **not** pass 关3.

## Bootstrap slice — what is actually accepted

| 关 | This PR |
|---|---|
| 关1 | Inventory written. No API client. **Fail / not claimed** |
| 关2 | Contract written; screenshot ownership assigned. Stub UI only. **Fail / not claimed** |
| 关3 | Harness **planned**, not implemented. **Fail / not claimed** |
| CI | Lint + typecheck on `work/expo-native` only. **Not** a device build |

## Commands (as they land)

```bash
# App
cd apps/mobile_expo
npx expo start
npx expo start --ios      # macOS + Xcode
npx expo start --android  # Android SDK

# Static (this slice)
cd apps/mobile_expo
npx expo lint
npx tsc --noEmit

# Later: performance harness (not in this PR)
# npx jest src/chat/chat_transcript_perf.test.ts
```
