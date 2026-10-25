# Yuri mobile rebrand validation

Local validation date: 2026-10-25. Package version: `2.1.10-beta.11`.
No release, remote registration or signing-profile validation was performed.

## Implemented contracts

- Package `@yuri/mobile`; custom native plugins/classes `Yuri*`; TypeScript bridges
  and contract files `yuri-*`; Android Java namespace `com.yuri.app`.
- Native application ID `com.yee94.yuri`, debug Android ID `com.yee94.yuri.debug`.
  Apple extensions and App Group are enumerated in `README.md`.
- `yuri://` deep links, `yuri-asset://` virtual assets, `yuri:ime-state`, and
  `yuri-relay-v1` HKDF context require matching UI/Host consumers.
- `YuriOTA.shellApiVersion = 2`; publishers must require shell API 2 and the new
  application ID. `YURI_OTA_UPDATE_URL` has no unverified production default.
- Final supplied B SVG/PNG artwork is checked into `assets/`, with reproducible
  iOS/Composer/Widget/Android/adaptive/monochrome/notification/splash generation.
- Existing applications retain their sandbox. Manual local-draft/attachment
  recovery and fresh pairing are documented; cross-sandbox access is not assumed.

## Evidence

| Check | Result |
| --- | --- |
| `bun run --cwd packages/mobile test` | 11 suites passed, 51 tests passed; 1 iOS Photos test skipped without explicit simulator parameters |
| `bun run --cwd packages/mobile type-check` | Passed |
| `bun run --cwd packages/mobile lint` | Passed |
| Icon generator run twice + SHA-256 comparison | Identical outputs; generated SVG/XML parsed successfully |
| Xcode `YuriWidget` simulator build | Passed arm64 + x86_64, including symbol asset compilation and Live Activity Swift |
| `bun run --cwd packages/mobile build:android:debug` | Passed production Web build, Capacitor sync and Gradle APK build (285 tasks) |
| APK metadata/DEX inspection | `com.yee94.yuri.debug`, `Yuri Debug`, activity `com.yuri.app.MainActivity`; baked shell API 2; renamed native plugin class present, previous class absent |
| `bun run --cwd packages/mobile build:ios:simulator` | Passed full simulator app + three embedded extensions, including Icon Composer assets; MLKit simulator exclusion restored by the existing build script |
| iOS packaged Info.plist/native-binary inspection | Main `com.yee94.yuri` and all three `com.yee94.yuri.Yuri*` extension IDs verified; shell API 2; no old brand in application/extension executables or app dylib |
| `bun run dead-code` | Completed (non-blocking); reports 19 mobile files, including contract exports, native TS bridges and package-script entrypoints that Knip does not discover; these are retained public consumers |

Native Java parser/backoff/crypto tests compile and execute production code;
the Swift video tests compile production code and exercise real HTTP ranges and
AVFoundation playback. Virtual-asset model tests alone do not prove device behavior.

Initial full Android/iOS build attempts stopped in the shared UI build because
`GitHubSettings.tsx` contained a malformed patch header; the UI owner repaired it.
Both Android and iOS retries passed. The local debug APK retains the existing development
version defaults (`versionCode=1`, `versionName=1.0-debug`); production builds must
set `YURI_ANDROID_VERSION_CODE` and `YURI_ANDROID_VERSION_NAME` through the release
pipeline. APK: `android/app/build/outputs/apk/debug/app-debug.apk`.
The simulator app retains local version `1.0` / build `1`; it is generated under
Xcode DerivedData's `Build/Products/Debug-iphonesimulator/App.app` and is unsigned.
The existing simulator build was subsequently installed and exercised as described below;
no rebuild or signing operation was needed.

## Independent simulator runtime acceptance

On 2026-10-25, created a fresh **Yuri Rebrand Acceptance** iPhone 17 Pro,
iOS 26.5 simulator (`860FDC20-2861-4AC4-9F61-E541591EBCA3`). Existing simulator
devices and their app data were untouched. Installed the already-built unsigned
`App.app`; confirmed the installed bundle reports `com.yee94.yuri`, display name
`Yuri`, local version/build `1.0` / `1`, and shell API **2**.

- Normal launch reached the native mobile connection screen, with the final B
  mark, “连接到 Yuri” and `yuri://connect` placeholder visible.
- SpringBoard displayed the final B Icon Composer artwork and the label `Yuri`.
- Terminated the app before opening `yuri://settings`. iOS correctly identified
  Yuri in its first-open confirmation; after accepting, the unpaired app reached
  its connection screen. A second cold launch stayed on the same live process
  for a 15-second observation interval, with accessibility application name Yuri.
- Terminated the app before opening `yuri://connect?v=2&p=invalid`. The app
  returned to its connection screen and retained the same live process for
  15 seconds. This proves launch/no-crash behavior, not successful pairing or
  authenticated settings navigation. No valid credentials or Host were supplied.
- Stopped only this simulator's serve-sim stream and shut down only this newly
  created device after evidence capture; retained its installation for inspection.

Evidence directory: `.scratch/yuri-rebrand/mobile-evidence/`:

| File | Evidence |
| --- | --- |
| `01-first-launch.png` | Startup mark |
| `02-launched.png` | Fully rendered connection screen |
| `03-home-icon.png` | Installed launcher icon and Yuri label |
| `04-cold-settings.png` | OS confirmation identifies the Yuri URL handler |
| `04-cold-settings-settled.png` | Settled UI after cold settings deep link |
| `05-cold-invalid-pairing.png` | Settled UI after cold malformed pairing link |
| `runtime-result.json` | Installed identity, shell version, process IDs and survival checks |
| `*-accessibility.json` | Corresponding accessible UI evidence |

The initial `04-cold-settings-opened.png` caught a transient blank launch frame;
the settled capture and accessibility tree above confirm it subsequently rendered.
The evidence directory is ignored scratch material and must accompany any handoff
that needs the screenshots.

## Remaining platform acceptance

Release signing and app-ID/App-Group ownership; TestFlight/Store registration;
APNs and notification-click routing; physical-device deep-link cold/hot launches;
native Composer/TabBar input; LAN and Relay reconnect; real icon rendering on
Android launchers/lock screen and iOS physical devices; old-app data recovery;
production OTA identity/shell gating. Simulator launcher and unpaired cold-launch
checks above are complete; no real phone or production service was used.

The only old-brand source-text exceptions are the seven exact previous identities
in `README.md`'s migration table. No runtime aliases generate old identities.
