# OpenChamber Expo

Independent **React Native + Expo** rewrite of OpenChamber mobile.

| | |
|---|---|
| Track | `work/expo-native` — do **not** merge to `main` |
| SDK | Expo **57** (React Native 0.86) |
| Capacitor | `packages/mobile` stays; this app sits beside it |
| Docs | [`docs/expo-native-README.md`](../../docs/expo-native-README.md) |

Native is always on. There is no WebView fallback and no `openchamber.iosNativeUi` product switch. Chat is a **pushed** route, not a dock tab.

This bootstrap is a **placeholder shell** (four tabs + stub Chat). It does not implement Cap API parity, LegendList, or native glass.

## Run

```bash
cd apps/mobile_expo
npm install
npx expo start
```

| Command | Target |
|---|---|
| `npx expo start` | Dev server / QR |
| `npx expo start --ios` | iOS Simulator (macOS + Xcode) |
| `npx expo start --android` | Android emulator / device |
| `npx expo start --web` | Web preview of the stub only — **not** the ship path |

Package scripts: `npm start`, `npm run ios`, `npm run android`, `npm run web`.

## Check

```bash
cd apps/mobile_expo
npm run lint
npm run typecheck
```

CI (`.github/workflows/expo-mobile-ci.yml`) runs those two jobs on push to `work/expo-native`. It does **not** build an IPA or APK.

## Identity (planned native binaries)

| | Value |
|---|---|
| Release applicationId / iOS bundle | `com.yee94.openchamber` |
| Debug Android | `applicationIdSuffix .debug` → `com.yee94.openchamber.debug` (not wired in this stub) |
| Debug label | **OpenChamber Expo** |
| URL scheme | `openchamber://` |

Side-by-side is vs the official Capacitor **release** app. See [`docs/expo-pitfalls.md`](../../docs/expo-pitfalls.md).

## Out of scope here

Capgo, EAS Update as ship path, Voice STT/TTS, plan mode, project notes/Todo, Bonjour「附近」, local PIN/Face ID, 1.18 TanStack chat physics.
