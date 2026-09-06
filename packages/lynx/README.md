# OpenChamber Lynx (`@openchamber/lynx`)

Independent track: **`work/lynx-native`**. Do **not** merge to `main`. This is the native Lynx client for the Capacitor `MobileApp` product surface — not Expo, not Flutter, not a Capgo app store, not Finder.

This package owns both:

1. **Shell / host / glass scaffold** (four-root dock IA, embedding modes, Lynx 3.8 `<blur-view>`).
2. **Connect / pairing v2 / session-index** TypeScript client (same OpenChamber routes Capacitor mobile uses).

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
4. LegendList-semantics timeline + Settings home (21 slugs) are in this package; rich turn cards, settings editors, FCM, and full CI matrices remain later.

Code: `src/host/embedding.ts`. Native mirrors: `host/ios/`, `host/android/`.

## Connect / pairing / session-index

TypeScript client layer (not pixel UI). Maps to Cap/UI routes under `packages/ui` + `packages/mobile`.

- Pairing v2 parse (`openchamber://connect?v=2&p=…`). Legacy v1 links are rejected.
- `openchamber://` intent parse/build (same union as `packages/ui/src/apps/deepLinks.ts`).
- Saved-instance persistence: ordered LAN + relay **candidates**, token in an injected secure store.
- Connect / auto-connect / password unlock / pairing redeem on a **reachable** candidate (`GET /health`, `GET|POST /auth/session`, `POST /api/client-auth/pairing/redeem`).
- Session-index GET / pin / lookup keyed by runtime identity, with failure ≠ empty.
- Projects-home projection (API/types, not UI polish).

Does **not** own: Nearby / Bonjour, native ASR, FCM/APNs registration, E2EE relay tunnel implementation (inject `openRelayTunnel`), rich chat cards / SSE, Settings **editors**, CI.

### Adapters the host must inject

| Adapter | Cap counterpart |
|---|---|
| `http.request` | CapacitorHttp then fetch |
| `secureStore` | Keychain / Keystore (`@aparajita/capacitor-secure-storage`) |
| `metadataStore` | localStorage `openchamber.mobile.connections.v1` |
| `openRelayTunnel` | `createRelayTunnelClient` (optional until relay lands) |
| `getDevicePlatform` | Capacitor `ios` / `android` |

Do not log tokens, pairing secrets, or bearer headers. See `DOCUMENTATION.md`.

## Package layout

```text
packages/lynx/
  src/                 Lynx page + shell + glass + connect + tests
  host/ios/            UIKit embedding strategy (Lynx SDK not linked yet)
  host/android/        Mode A host activity (Lynx SDK not linked yet)
  lynx.config.ts       Intended Rspeedy 3.8+ bundle notes
```

This package lives under `packages/*` so it joins the existing Bun workspace. It does **not** wrap WKWebView.

Install identity when a binary exists later: `com.yee94.openchamber` / `.debug`. Do not invent a new application id without a matching FCM app.

## Shell IA

Four roots only: **Projects**, **Assistant**, **Scheduled**, **Settings**. Labels reuse `mobile.tabs.*`.

Secondary kinds (`chat` / `draft` / `assistant` / `instances`) push above the dock. Root tab content in this slice is a **labeled stub** — not wired to pixel UI yet (session-index data path exists under `src/session-index/`).

Chat list engine is **1.19 LegendList** semantics (`src/chat`). This package must not introduce the 1.18 TanStack Virtual split.

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
bun run --cwd packages/lynx build:rspeedy   # writes dist/main.lynx.bundle (gitignored)
bun run --cwd packages/lynx dev:rspeedy    # needs Lynx Explorer / host to preview
```

See `RUNNABLE.md` for Linux-box results. iOS simulator + Android APK CI / 真机 are still **not** in this slice (no Xcode/adb on the Linux agent).

## 三关

| Gate | This slice |
|---|---|
| 代码接上 | Shell / embedding / glass contracts + connect/pairing/session-index client. Host must still inject HTTP + Keychain + (later) relay tunnel. |
| CI绿 | Package typecheck + Vitest. No APK/IPA job yet. |
| 真机过 | **not executed** (Linux cloud agent; no Xcode/adb device) |
