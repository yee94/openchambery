# OpenChamber Lynx (`@openchamber/lynx`)

Independent track: **`work/lynx-native`**. Do **not** merge to `main`. This is the native Lynx client skeleton for the Capacitor `MobileApp` product surface — not Expo, not Flutter, not a Capgo app store, not Finder.

## Host embedding (slice 1 lock)

Full-page auto skin of Tab/Nav is **not** free. It depends on who owns chrome (`docs/lynx-ia-ui.md`, `docs/lynx-acceptance.md`).

| Host | Mode | Who paints Tab / Nav | Full-page auto glass? |
|---|---|---|---|
| **iOS 26+** with a real `UITabBarController` | **B** | Host liquid-glass tab bar | **No** — Lynx is content only |
| **iOS &lt; 26** | **A** | Lynx `<blur-view>` dock (`light` / `dark`) | Yes |
| **Android** | **A** | Lynx capsule with `blur-radius` | Yes, as an **Android降级** — not `UIGlassEffect` |

Rules:

1. Chat is a **pushed** secondary page. It is never a fifth dock item. The dock / host tab bar **hides** on chat, draft, assistant conversation, and instances.
2. Do not ship Mode C (Capacitor WebView dock + optional native overlay). Lynx does not need `openchamber.iosNativeUi`.
3. A binary that draws both a host `UITabBar` **and** a Lynx floating dock has failed IA.
4. Connect / pairing, LegendList messages, Settings editors, FCM, and full CI matrices are **other tracks**.

Code: `src/host/embedding.ts`. Native mirrors: `host/ios/`, `host/android/`.

## Package layout

```text
packages/lynx/
  src/                 Lynx page + shell + glass + tests
  host/ios/            UIKit embedding strategy (Lynx SDK not linked yet)
  host/android/        Mode A host activity (Lynx SDK not linked yet)
  lynx.config.ts       Intended Rspeedy 3.8+ bundle notes
```

This package lives under `packages/*` so it joins the existing Bun workspace. It does **not** wrap WKWebView.

Install identity when a binary exists later: `com.yee94.openchamber` / `.debug`. Do not invent a new application id without a matching FCM app.

## Shell IA

Four roots only: **Projects**, **Assistant**, **Scheduled**, **Settings**. Labels reuse `mobile.tabs.*`.

Secondary kinds (`chat` / `draft` / `assistant` / `instances`) push above the dock. Root tab content in this slice is a **labeled stub** — not connected to OpenChamber APIs.

Chat list engine, when that track lands, is **1.19 LegendList** semantics. This package must not introduce the 1.18 TanStack Virtual split.

## Glass (Lynx 3.8 `<blur-view>`)

| Attr | iOS 26+ mapping | Android |
|---|---|---|
| `blur-effect=glass` | `UIGlassEffect` | unused |
| `blur-effect=glass-container` | `UIGlassContainerEffect` | unused |
| `glass-style` | `UIGlassEffect.Style` | unused |
| `glass-interactive` | interactive glass | unused |
| `glass-tint-color` | tint | unused |
| `spacing` | fusion distance | unused |
| `blur-radius` / `blur-sampling` | n/a for liquid glass | **intentional downgrade** |

Do not wrap the transcript or Settings rows in glass.

## Commands

```sh
bun run --cwd packages/lynx type-check
bun run --cwd packages/lynx test
bunx vitest run --project @openchamber/lynx
```

Rspeedy bundle + iOS simulator + Android APK CI are **not** in this slice.

## 三关

| Gate | This slice |
|---|---|
| 代码接上 | Shell / embedding / glass contracts only. No server routes. |
| CI绿 | Package typecheck + Vitest. No APK/IPA job yet. |
| 真机过 | **not executed** (Linux cloud agent; no Xcode/adb device) |
