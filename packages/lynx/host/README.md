# Lynx native host scaffolds

Linux-doable Xcode / Gradle **project files + deepened bridge stubs**. CocoaPods / Maven Lynx Engine
artifacts are **not** resolved on this Linux agent — do not claim APK/IPA green from these files alone.

Application id stays `com.yee94.openchamber` / `.debug` (FCM / Cap identity).

## Layout

```text
host/
  README.md                 ← this file
  ios/
    Podfile                 ← Lynx / XElement pods (Mac resolve)
    OpenChamberLynx.xcodeproj/project.pbxproj
    OpenChamberLynxEmbedding.swift
    OpenChamberLynxHostController.swift
    OpenChamberLynxViewFactory.swift
    OpenChamberLynxBridge.swift          ← page ↔ host channel (QR/OAuth/IME/secureStore)
    OpenChamberLynxHttpClient.swift      ← URLSession inject
    OpenChamberLynxSecureStore.swift     ← Keychain (SecItem*) wrapper
    OpenChamberLynxCameraAdapter.swift   ← QR / 扫一扫 → pairing callback
    OpenChamberLynxOAuthBrowser.swift    ← ASWebAuthenticationSession stub
    OpenChamberLynxImeInset.swift        ← keyboard inset publisher
    OpenChamberLynxVirtualAsset.swift    ← openchamber-asset:// scheme hooks
    OpenChamberLynxPredictiveBack.swift  ← Predictive Back / edge-back contract
  android/
    settings.gradle / build.gradle / …
    app/src/main/java/…/OpenChamberLynx*.kt  ← Mode A + same bridge surfaces
```

## Mac / device run steps (honest)

### iOS (requires macOS + Xcode 16+)

1. `cd packages/lynx && bun run build:rspeedy` → `dist/main.lynx.bundle`
2. Copy / symlink the bundle into the host app resources as `main.lynx.bundle`
3. `cd packages/lynx/host/ios && pod install` (needs CocoaPods + Lynx podspecs)
4. Open `OpenChamberLynx.xcworkspace` (after pods) or the `.xcodeproj` stub
5. Select an iPhone simulator / device; Run
6. Inject adapters from the host before first Lynx paint:
   - HTTP (`OpenChamberLynxHttpClient` / URLSession) + Keychain secure store + metadata store
   - Camera (扫一扫 → `qrScanResult` → Lynx pairing parse), Haptics, Media
   - VirtualAsset scheme handler (`registerSchemeHandler`)
   - OAuth `ASWebAuthenticationSession` presentationAnchor
   - IME inset publisher → bridge `keyboardInset` / `imeInset`
   - Predictive Back / edge pan → Lynx bridge events
7. Autocomplete/command list must sit **ABOVE** glass composer (not `UIGlassEffect.contentView`)
8. Write a 真机过 log (device, OS, SHA) on `docs/lynx-gap-board.md` — never tick without it

### Android (requires Android SDK + Lynx AAR)

1. Same rspeedy bundle → assets `main.lynx.bundle`
2. `cd packages/lynx/host/android`
3. Point `lynxSdk` dependency at the official Lynx Android artifact (not resolved on Linux)
4. `./gradlew :app:assembleDebug` on a machine with the SDK
5. Install `com.yee94.openchamber.debug`; inject the same adapters as iOS
6. OAuth: Custom Tabs + `openchamber://` intent-filter resume
7. Secure store: EncryptedSharedPreferences (MasterKey / AES256_GCM)
8. Predictive Back (API 34+) must share **one** owner with Lynx gesture arena — see `OpenChamberLynxPredictiveBack.kt`

## Bridge contract (JS)

TypeScript mirrors live under `packages/lynx/src/host/`:

| Module | Host stub |
|---|---|
| `bridge.ts` / `hostChannel.ts` | `OpenChamberLynxBridge` (Cap plugin invoke/listen spirit) |
| `httpClient.ts` | `OpenChamberLynxHttpClient` |
| `secureStore.ts` | `OpenChamberLynxSecureStore` (Keychain / Keystore) |
| `camera.ts` | `OpenChamberLynxCameraAdapter` → pairing callback |
| `oauthBrowser.ts` | `OpenChamberLynxOAuthBrowser` (ASWebAuthenticationSession / Custom Tabs) |
| `imeInset.ts` | `OpenChamberLynxImeInset` |
| `virtualAsset.ts` | `OpenChamberLynxVirtualAsset` (+ scheme handler registry) |
| `media.ts` / `haptics.ts` | existing Media / Haptics stubs |
| `predictiveBack.ts` | `OpenChamberLynxPredictiveBack` |

Without a host binder, JS returns **unavailable** — never fake-success.

## What this slice does **not** claim

- Linked Lynx SDK / green CocoaPods or Gradle resolve on Linux
- Signed IPA / APK CI green
- 真机过
- Live Keychain/CameraX/ASWebAuthenticationSession on this Linux agent

## CI note

`packages/lynx/ci/lynx-ci.yml` is the track template. Installing as `.github/workflows/lynx-ci.yml` requires a token with `workflow` scope (OAuth App pushes without that scope are rejected).
