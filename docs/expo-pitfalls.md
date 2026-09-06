# Expo rewrite — historical pitfalls

These are product and process traps already paid for on Capacitor and Flutter. Expo must not re-learn them. Pair with [`docs/expo-feature-inventory.md`](expo-feature-inventory.md).

## Identity / IA

### No local PIN / Face ID / app lock

OpenChamber mobile has **no** local device lock. There is no biometric gate, no in-app PIN pad, and no “lock the transcript” setting.

The word **passcode** in this product means the **Capacitor connection-onboarding server password**: unlock a password-protected OpenChamber instance (`GET/POST /auth/session`) so the app can mint and store a **client token**. That token lives in Keychain / Keystore. Never present Face ID as a substitute for instance auth, and never add a second lock screen “for security.”

### No Chat dock tab

1.19 IA is four roots: **Projects / Assistant / Scheduled / Settings**. Chat is a **pushed secondary**. Adding a fifth Chat tab copies a desktop mental model and breaks the README shots (`docs/references/mobile_*.png`). Widget/CI tests must assert four destinations.

### Do not invent `openchamber.iosNativeUi`

On Capacitor, `packages/ui/src/lib/iosNativeUi.ts` persists `openchamber.iosNativeUi` (default **off**) and gates the WebView→UIKit overlays. That toggle exists because the ship path is still a WKWebView.

This Expo track **is** native. There is no fallback WebView product, so there is no product switch. Do not:

- persist `openchamber.iosNativeUi`
- add an Appearance row for it
- document “turn on native UI”
- keep a CSS glass clone behind a flag

Native composer / dock / Live Activity are always on where the OS supports them. Live Activity on Cap is already ungated from this setting — keep that.

### Do not invent Bonjour「附近」

Official “nearby” is **LAN / home-network HTTP** (`mobileConnections.ts`). There is **no** 「附近」 copy and **no** Bonjour / mDNS / `NWBrowser` / Android NSD scanner UI. A pairing payload already carries LAN candidates. Building a discovery browser is a new product, not parity.

## Connection / relay

### Relay-only must skip the 1.5s LAN headstart

`RELAY_RACE_HEADSTART_MS = 1_500` exists so a **live LAN** can win before relay starts. The code path is:

```text
no relay candidate     → probe direct only
no direct candidates   → probeRelay() immediately
both present           → direct first; start relay after 1.5s (or sooner if every direct is already unreachable)
```

A pairing payload with **only** `type: 'relay'` must not sleep 1.5s, must not probe `192.168.x`, and must not surface `connect.error.unreachable` / “LAN failed”. Status after success is `已连接 · 中继` / `Connected · Relay`.

Yee’s walk is often **relay-only** (no home LAN). A 1.5s stall here is a product bug.

### Persist the full candidate set

Pairing v2 (`connectionPayload.ts`) carries `lan` + `relayUrl` + `hostEncPubJwk` + optional grant + `serverId`. Reload must not drop relay. Home ↔ away is a **reprobe**, not a re-pair. Never log the pairing secret, grant, or client token.

### Do not send the bearer to an unverified LAN host

`/health` is unauthenticated. When the device knows `serverId` from relay pairing, a direct candidate must report the same id before `Authorization: Bearer` is sent. A DHCP-reassigned printer is not the OpenChamber box.

## Chat list / performance

### LegendList, not 1.18 TanStack

- Do **not** merge or cherry-pick `cursor/tanstack-chat-physics-29a6` / `v1.18.5`.
- Cap/WebView on `1.19.6+` defaulted the **WebView** list back to TanStack (`oc:legend-timeline` opt-in).
- Expo (and Flutter) still implement the **LegendList contract**: one list owns history + live tail; `initialScrollAtEnd`, `maintainScrollAtEnd`, `maintainVisibleContentPosition`; no StickToBottom / Virtua / 1.18 physics port.

A `ScrollView` of every message is not an implementation. A TanStack Virtual RN port of the 1.18 branch is not an implementation.

### Do not `setState` the whole Chat on every SSE token

Flutter’s first chat stuttered because every `message.*` rebuilt the screen. Structure (ids/order) and the live tail must update independently. Streaming Markdown is paced (Cap iOS/web 64ms; Android Cap 128ms). Incomplete fences must not throw.

## Native chrome

### Real UIKit / system APIs, not CSS clones

Forbidden on iOS: `BlurView` + opacity pretending to be `UIGlassEffect`; a custom pill pretending to be `UITabBar` on iOS 26. Use `UITabBar` / `UIGlassEffect` / `UITextView` (Expo modules or Swift). Android **degrades honestly** — Material / solid pill / system IME — and does not fake liquid glass.

### Occupancy is the collapsed composer only

Cap iOS publishes collapsed pill height only. Expanding the field, showing the scroll-to-bottom chevron, or opening `/` `@` must not shove Changes / queue / accessories. Repeat that contract in Expo.

### Native never owns the page stack

`OpenChamberNavigation` is a **progress driver**. RN/React owns routes. iOS back is a **physical left-edge** pan, not a mid-screen Material swipe.

## Updates / CI / secrets

### Capgo is WebView-only

`@capgo/capacitor-updater` hot-swaps the **bundled web UI**. Expo is not a WebView. Do not:

- wire Capgo into this app
- treat EAS Update as the ship path for native chrome
- bump `shellApiVersion` stories that only make sense for Cap JS bundles

Ship IPA/APK (and later a signed-release workflow that **reuses existing secret names**).

### Debug APK must sit beside the official app

| Build | applicationId | Label |
|---|---|---|
| Cap / Flutter / Expo **release** | `com.yee94.openchamber` | OpenChamber |
| Cap **debug** | `com.yee94.openchamber.debug` | OpenChamber Debug |
| Flutter **debug** | `com.yee94.openchamber.debug` | OpenChamber v2 |
| Expo **debug** (this track) | `com.yee94.openchamber.debug` | **OpenChamber Expo** |

Use `applicationIdSuffix ".debug"`. Launcher **art** stays the official mark. Do not invent a second Firebase project — `google-services.json` already lists the `.debug` client.

Honest: only one `.debug` package can be installed at a time. Side-by-side means **vs release OpenChamber**, not vs Flutter v2 and Cap debug simultaneously.

### Secrets: reuse existing GitHub Actions names only

Do not create `EXPO_*` / `EAS_*` secret aliases. When a signed workflow is added later, reuse:

- Android: `ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`, `ANDROID_KEY_PASSWORD`
- Gradle env: `OPENCHAMBER_ANDROID_KEYSTORE_PATH` / `_PASSWORD` / `KEY_ALIAS` / `KEY_PASSWORD`, `OPENCHAMBER_ANDROID_VERSION_CODE` / `VERSION_NAME`
- iOS: `IOS_DISTRIBUTION_CERTIFICATE_BASE64`, `IOS_DISTRIBUTION_CERTIFICATE_PASSWORD`, `IOS_APP_PROFILE_BASE64`, `IOS_WIDGET_PROFILE_BASE64`, `IOS_NSE_PROFILE_BASE64`, `IOS_SHARE_PROFILE_BASE64`, plus the four `*_PROFILE_NAME` secrets, `APPLE_TEAM_ID`, `APP_STORE_CONNECT_KEY_ID`, `APP_STORE_CONNECT_ISSUER_ID`, `APP_STORE_CONNECT_PRIVATE_KEY_BASE64`

Never print secret values. Never log tokens, pairing secrets, grants, or bearer headers.

### Do not claim green device builds you did not run

Linux CI that only lints is not an iOS Simulator build and not 真机过. The first Expo workflow (`expo-mobile-ci.yml`) is lint/typecheck only. Say so.

### Prereleases stay off the stable feed

Semver prereleases and debug APK tags must never enter `/releases/latest`, Vercel `latest*.yml`, or `deploy/update-service/release-manifest.json`. Same rule as Flutter `flutter-v2-debug-*`.

## Product removals — do not “helpfully” restore

| Removed / omitted | Why |
|---|---|
| Plan mode (`/plan-feature`) | Removed in 1.19.2 |
| Project notes / Todo panel | Removed in 1.19.2 |
| Voice settings + STT/TTS client | Official slug still exists; native rewrite does not ship working STT/TTS (Flutter omitted the page) |
| Chat as a root tab | Never 1.19 IA |
| Capgo About updater | WebView-only |
| Experimental session-list fallback on index `501` | Not the 1.19 mobile happy path |
| Pierre diffs / extra mermaid packages | Do not add undeclared dependencies |

`todowrite` / `todoread` **tool cards** in a transcript are agent tools, not the removed notes product.

## Logging / security

- Never log pairing `secret`, `grant`, client tokens, relay private material, or composer body.
- Native plugins receive opaque ids and bytes — not host paths or tunnel keys.
- Share catalog stores `serverInstanceID` / `assistantID` / `connectionKey` — not server tokens.
- Live Activity push tokens are Activity-instance tokens; do not log them.

## Process

- Work **only** on `work/expo-native`. Do not merge to `main`.
- Do not modify `../opencode`.
- Do not ask the user for GitHub tokens; use existing Actions auth.
- Flutter `docs/flutter-native-gap.md` is a honesty template, not a source to paste into Expo code.
- Keep `packages/mobile` Capacitor tree compiling; this track does not replace it on `main`.
