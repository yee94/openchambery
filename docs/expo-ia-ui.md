# Expo rewrite — IA + UI contract

For the **Expo UI teammate**. Implementation track owns APIs and native modules; this file is the shared visual/IA contract so pixels and navigation do not drift.

Authoritative product shots (Cap/WebView, on `main`):

- `docs/references/mobile_projects.png`
- `docs/references/mobile_chat.png`
- `docs/references/mobile_schedules.png`
- `docs/references/chat_mobile_dark.png` (dark chat)

Root README embeds the first three. Those PNGs are the **comparison targets** for 关2 ([`docs/expo-acceptance.md`](expo-acceptance.md)).

Inventory of *what* exists: [`docs/expo-feature-inventory.md`](expo-feature-inventory.md).  
Pitfalls (especially “no Chat tab”, “no iosNativeUi”, “no fake glass”): [`docs/expo-pitfalls.md`](expo-pitfalls.md).

## Dock IA

```
┌─────────────────────────────────────┐
│  Root tab body (lazy + keep-alive)  │
│  Projects | Assistant | Scheduled   │
│  | Settings                         │
├─────────────────────────────────────┤
│  Dock — four destinations only      │
└─────────────────────────────────────┘

open session / New Session / assistant / instances
        ▼
┌─────────────────────────────────────┐
│  Pushed secondary (dock hidden)     │
│  Chat | draft | assistant | instances│
│  Native back: iOS left-edge /       │
│  Android predictive back            │
└─────────────────────────────────────┘
```

| Rule | Detail |
|---|---|
| Four roots | `projects` / `assistant` / `scheduled` / `settings` |
| Chat | **Pushed**. Never a dock item |
| Keep-alive | Tab bodies mount on first visit and stay mounted (scroll/draft survive) |
| Two-page window | Stack metadata may be deep; render top + predecessor only |
| Header | Shared collapsing title (`MobileTabPageHeader` analogue). 48px collapse distance; **layout height does not change** |
| Plus on Projects | 扫一扫 / 切换实例 / new session — not a fifth tab |

Copy keys already exist (`mobile.tabs.*`). Expo may start with English stubs; shipping UI must go through a real locale dictionary (do not paste English into `zh-CN`).

## Pushed Chat

Optical notes from the official mobile CSS / Flutter’s later audit (measure against the PNG, then the CSS):

| Token | Official (Cap) |
|---|---|
| Detail nav band | 56px, `max(1rem, safe-area)` inset |
| Back / overflow | 40px glass discs (`mobileGlass`) |
| Title | ~0.9375rem / 1.4, centered |
| Sticky header | Transparent + fade — not a frost banner |
| FileTypeIcon | `h-3 w-3` on mobile |
| File marks | `+N/-M` with a slash |
| Composer occupancy | **Collapsed pill only** (native iOS). Accessories dock above it |
| Re-enter | Jump to **latest**, not last user send |
| Subtitle | Sync hint and/or `项目 · 分支` — not a second title |

Composer swipe (left/right) changes session. Transcript RTL opens the session list. Interactive back is **not** a mid-screen swipe on iOS.

## Glass rules (iOS)

Native is **always on**. No Appearance toggle.

| Surface | Required API | Forbidden |
|---|---|---|
| Dock (iOS 26) | `UITabBar` / `UITabBarController` + system liquid glass | Custom nested glass pills, CSS `backdrop-filter` clone, hover-lift theatre |
| Dock (older iOS) | System translucent `UITabBar` | Fake iOS 26 lens |
| Composer (iOS 26) | `UIGlassEffect` on the real composer chrome; `UITextView` owns IME | RN `TextInput` in a BlurView sold as glass |
| Composer (older iOS) | `UIBlurEffect` material | |
| Autocomplete | Glass list **above** the card; not inside the effect contentView if glyphs vanish | |
| Live Activity | ActivityKit (iOS 17+) | Gating it on a UI toggle |

Selected dock glyph uses theme `--primary`; unselected uses secondary label. RN may host a chrome-only native view; **taps must not fork a second tab stack**.

## Android degradation (honest)

| iOS | Android |
|---|---|
| Liquid-glass dock | Floating capsule **or** platform navigation — same four roots. Not `UIGlassEffect` |
| Glass composer | Solid / system material pill. IME via `windowSoftInputMode` / RN keyboard insets — **one** inset, not a double pad |
| Live Activity | Absent |
| WidgetKit / NSE | FCM (+ optional widgets later) |
| `UIImpactFeedbackGenerator` | `performHapticFeedback` |
| VisionKit QR | ML Kit / CameraX / system scanner |
| PHPicker | `ACTION_PICK_IMAGES` |

Do not ship a “glass everywhere” Android theme. 关2 Android shots should look like Android.

## Theme / type

- Semantic OpenChamber tokens (OKLCH → sRGB). Light / Dark / System.
- README photos are **type and icon optical** targets. Do **not** recolor the app to the screenshot’s UIKit blue / grouped gray.
- Official `--primary` stays orange / golden sand.
- Dock icons: ~23px, four glyphs (folder / sparkles / calendar / gear), selected wash covers the **full tab slot**.
- Project shell icon ~38 / glyph ~32; session overflow hit ~36.

## Screenshot cadence

| When | What the UI teammate captures |
|---|---|
| After first real Projects home | Light + scrolled + dark, vs `mobile_projects.png` |
| After first real Chat + composer | Light + activity + dark, vs `mobile_chat.png` / `chat_mobile_dark.png` |
| After Scheduled filters | Light + dark, vs `mobile_schedules.png` |
| After iOS glass lands | Device (not only Widget/Jest), iOS 26 if available |
| After Android degrade lands | Same IA, honest material — do not crop out the dock |

Store Expo shots in `docs/expo-native-screenshots/` **when they are real**. Do not commit empty placeholders. Name them `NN-surface[-variant].png` (Flutter’s folder on `work/flutter-native` is the naming precedent, not the pixels).

## Comparison targets (do / don’t)

**Do** compare:

- Dock count and order
- Chat pushed (dock gone)
- Project card hierarchy (directories inset; same-dir branches are rows, not cards)
- Pin / in-progress subtitle `项目 · 分支`
- Scheduled two-segment + three-filter tracks
- Composer occupancy vs transcript

**Don’t** compare:

- Screenshot theme hue
- Flutter Material 3 goldens (rejected once already)
- 1.18 TanStack chat physics recordings
- Cap `iosNativeUi=off` WebView composer as the iOS target (iOS target is native glass)

## Collaboration split

| Track | Owns |
|---|---|
| Expo implementation (`work/expo-native`) | APIs, navigation state, LegendList, native modules, CI, gap board |
| Expo UI teammate | Tokens, type, glass layout, goldens/shots, 关2 sign-off |
| Cap `main` | Inventory source of truth until a row is will-not-port |
| Flutter `work/flutter-native` | Sibling native rewrite — steal honesty, not widgets |
