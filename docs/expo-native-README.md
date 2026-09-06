# Expo native rewrite track

Independent **React Native + Expo** rewrite of OpenChamber mobile.

| Rule | Detail |
|---|---|
| Branch | **`work/expo-native` only**. Do **not** merge to `main`. |
| Do not touch | 1.18 TanStack Virtual / `cursor/tanstack-chat-physics-29a6` / `v1.18.5` |
| Product semantics | Current `main` 1.19 IA + **LegendList** chat-list contract — not 1.18 TanStack physics |
| Capacitor | `packages/mobile` stays intact. This app lives at [`apps/mobile_expo`](../apps/mobile_expo) |
| Native | Always on. No WebView fallback toggle. Do **not** invent `openchamber.iosNativeUi` as a product switch |
| OTA | Capgo is Capacitor/WebView-only. Do not treat Capgo (or EAS Update) as the ship path |

## Gate docs (Phase 1 — read these first)

| Doc | Role |
|---|---|
| [`docs/expo-feature-inventory.md`](expo-feature-inventory.md) | Full Cap/WebView inventory. Each row: **required** / **will-not-port** / **device-only** |
| [`docs/expo-pitfalls.md`](expo-pitfalls.md) | Historical pitfalls this track must not repeat |
| [`docs/expo-gap-board.md`](expo-gap-board.md) | Living board + nine CODE-acceptance feature tracks (`missing` → 真机过). UI resemblance ≠ done |
| [`docs/expo-acceptance.md`](expo-acceptance.md) | 三关: Feature/API · Visual/IA · Performance |
| [`docs/expo-ia-ui.md`](expo-ia-ui.md) | IA + UI contract for the Expo UI teammate |

Flutter’s [`docs/flutter-native-gap.md`](https://github.com/yee94/openchambery/blob/work/flutter-native/docs/flutter-native-gap.md) on `work/flutter-native` is the **checklist template** (depth and honesty). Do not copy Flutter widgets or Dart into this app.

## App path

`apps/mobile_expo` — same layout as Flutter’s `apps/mobile_flutter`. Not a Bun workspace member. Capacitor `packages/mobile` is unchanged.

## This bootstrap slice

Docs + a placeholder four-tab Expo shell + stub Chat route + lint/typecheck CI. **Not** Cap parity. Next slices are listed on the [gap board](expo-gap-board.md).
