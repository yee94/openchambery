# OpenChamber Mobile

Capacitor shell for the dedicated OpenChamber mobile web surface.

The mobile package reuses the web build, then rewrites `mobile.html` to `index.html` in `packages/mobile/dist` so native iOS/Android always launch `MobileApp` instead of the hosted surface selector.

## Runtime Model

- The native app bundles the mobile UI only; it does not embed the OpenChamber web server or OpenCode server.
- On first launch in Capacitor, the app shows a connection screen for an existing OpenChamber server.
- Connections are saved locally in the app and can be managed from Settings under `Switch instance`.
- About reports the installed native client version separately from the connected instance's OpenChamber and OpenCode versions. Mobile update checks send the native client version to the instance.
- Android update actions pass the APK URL to the configured system default browser, which owns the download and installation handoff.
- The connection screen and `Switch instance` Settings page are Capacitor-only. Hosted `mobile.html` in a normal browser keeps the regular web behavior.
- Password-protected OpenChamber servers can be unlocked from the mobile app. The app stores the issued client token with the saved connection.
- Chat `edit` and `multiedit` rows open their exact single-file tool patch in a resizable phone sheet or the iPad Changes panel. An `apply_patch` row opens every renderable file patch from that invocation. The initial target focuses its first changed line, and apply-patch turn-snapshot records open the owning turn diff.
- iOS and Android register the `openchamber://` URL scheme. Opening a validated `openchamber://connect?v=2&p=...` link invokes the same one-time pairing redemption used by the QR scanner, including on cold launch; pairing secrets remain transient and are never logged or persisted.
- Pairing v2 Relay candidates carry their own `relayUrl`. Native and hosted mobile persist that endpoint with the connection metadata and use it for later reconnects, so official and self-hosted Relay connections can coexist on one client.

## Native Haptics Hot Path

- The `OpenChamberHaptics` Capacitor 8 plugin provides fire-and-forget impact feedback at three strengths: `impactLight`, `impactMedium`, and `impactHeavy`.
- Shared UI maps `triggerMobileHaptic('light' | 'medium' | 'heavy')` to the matching native method. Button taps use light; swipe threshold commits use medium.
- iOS registers the plugin from `OpenChamberBridgeViewController` and reuses one main-thread `UIImpactFeedbackGenerator` per style (`.light` / `.medium` / `.heavy`), preparing on creation and after every impact.
- Android registers the plugin before `BridgeActivity.onCreate`, then runs `WebView.performHapticFeedback` on the UI thread: `CLOCK_TICK` (light), `KEYBOARD_TAP` (medium), and `CONFIRM` / `LONG_PRESS` fallback (heavy).
- All native methods declare a `none` return type and leave the callback unresolved to keep this input-feedback path free of promise completion work.

## Native Back Navigation

- `OpenChamberNavigation` is a progress-only native input driver for the shared UI navigation coordinator; native code never owns the React page stack.
- iOS installs a `UIScreenEdgePanGestureRecognizer` on the bridge view and recognizes back only from the physical left edge. It commits by distance or horizontal velocity. Touch samples are reduced to the newest progress once per `CADisplayLink` tick at the screen's maximum refresh rate, including ProMotion; completion events include horizontal release velocity.
- Android 14+ uses `OnBackAnimationCallback` for system Predictive Back progress. Android 13 receives the invoke callback without progress, and older Android versions retain Capacitor App's existing commit-only back-button fallback.
- The web hot path coalesces native progress to one compositor transform update per animation frame and performs no per-frame React state writes. Static transition and layer-promotion styles are applied once when the gesture begins. Settlement duration follows remaining distance and release velocity; commit and cancel preserve their rendered endpoints, cancel `fill: forwards`, and clear every transform/animation hint after the route transition.
- The phone tab shell owns an arbitrary-depth metadata-only chat route stack and renders a two-page DOM window containing the top route plus its immediate predecessor. Secondary enter is instant (no push WAAPI): the top page mounts at rest to avoid the chat-page left settle flash. Interactive back still reveals the real parent, commits session selection after the outgoing page reaches 100%, and supports grandchild-to-root traversal one level at a time. A deep-linked child gains its immediate predecessor when the authoritative parent entity resolves.
- Only the top page is interactive. Its predecessor, root tab, and dock remain mounted and inert with `aria-hidden`; focus enters a pushed page and returns to the original root trigger after the stack closes. Each phone chat page binds one explicit transcript selection, and predecessor pages render read-only without an additional retained transcript cache.
- Flow-mobile Settings keeps viewport-bounded root, split collection, and detail surfaces as sibling layers, retaining the immediate predecessor at each depth. Scheduled Tasks keeps one persistent root layer behind its independently scrolling detail surface. Root routes register their bounded layers explicitly; gesture code never discovers an underlay by querying the outgoing page's ancestors. Only those bounded layers move, long tab documents never become compositor layers, and horizontal overflow remains clipped throughout the interaction.
- Hosted H5 registers no page-back touch gesture. Push-style mobile detail pages mirror their depth into browser history, and `popstate` invokes the same route callback; root history remains owned by the browser.
- Sheets and dialogs are modal surfaces rather than push pages. Their existing vertical dismissal and explicit close behavior remain separate; a file or Changes detail nested inside an overlay can pop before the overlay closes.

## Native Share Inbox

- `OpenChamberShare` is the Capacitor bridge for catalog updates, durable inbox consumption, and Android draft handoff. Inbox commits emit `shareReceived`; Android native draft arrivals emit `shareDraftReceived` as a delivery hint while `listPending` and `listDrafts` remain the authoritative recovery reads.
- The catalog stores assistant routing metadata only: `serverInstanceID`, `assistantID`, display fields, `connectionKey`, enabled state, and the default share target. Native code never stores server tokens or performs server requests.
- Each `NativeShareEnvelope` v1 is committed as an operation directory with `envelope.json` and app-private image files. Envelopes persist relative attachment names and `listPending` resolves them to ready-directory paths for the WebView. `ack` records a durable consumed marker; `releaseFiles` deletes the complete operation directory after upload cleanup.
- iOS Share Extension collects composer text, `NSExtensionItem.attributedContentText`, URLs, and plain-text providers into `ShareEnvelope.text`; it accepts up to 10 images. Android `ShareReceiverActivity` accepts text, URLs as text, and up to 10 images, and copies them into a one-hour app-private draft. Generic shares open an in-app Assistant recipient picker; after selection, the WebView switches to that instance and merges the content into the selected Assistant's durable Composer draft with a crash-recoverable handoff journal. Native cancellation happens only after the Composer snapshot is durable. The iOS share extension limits each base64-decoded image to 8 MiB and each operation to 16 MiB; Android native drafts allow one image or all images together up to 20 MiB. Native stores enforce these limits from copied binary byte counts. Inbox records expire after 24 hours; startup and every bridge read remove expired, malformed, interrupted, and acknowledged writes after expiry.
- iOS declares `INSendMessageIntent` support in the app and Share Extension. Successful Assistant composer sends and Share Extension submissions donate an outgoing conversation interaction with the Assistant's generated avatar; a suggested-recipient launch resolves the exact Assistant from `conversationIdentifier`. iOS owns suggestion eligibility and ranking, while disabled or removed Assistant catalog entries delete their donated conversation groups.
- The iOS Share Extension presents its native confirmation screen. Android shows a short native opening state and uses the existing Assistant Composer for preview, editing, attachment changes, and manual sending.
- Android uses a hybrid share path: native durable ingress stages the draft, generic shares wait on a full-screen in-app Assistant recipient page (never a bottom sheet), the WebView durably hands the assigned draft to the existing Assistant Composer, native draft cancellation follows that handoff, and the user edits attachments or text then sends through the standard Assistant Composer flow.
- Android Direct Share and Assistant launcher shortcuts keep their exact `serverInstanceID`, `connectionKey`, and `assistantID` target. The WebView switches to that saved instance, validates a fresh Assistant snapshot, opens the phone conversation page, and acknowledges or cancels native state only after the corresponding navigation or durable handoff succeeds. Generic Android shares never silently choose the configured default or first enabled Assistant.
- iOS resolves every shared image to `image/jpeg`, `image/png`, `image/gif`, `image/webp`, or `image/heic` from the copied file extension and matching file signature. Android preserves the content resolver's concrete image MIME, including `image/heic`. Shares with an unrecognized iOS image format return an attachment error and clean up copied temporary files.
- Native Assistant shortcuts and iOS share suggestions use the Assistant display name and avatar. A leading emoji becomes the avatar; other Assistants use their generated identicon.
- The share extension requires the existing `group.com.yee94.openchamber` App Group entitlement for the app and `OpenChamberShareExtension` target. The release signing profile must enable that App Group for `com.yee94.openchamber.OpenChamberShareExtension`.

## Install (beta)

- **iOS TestFlight (public link):** https://testflight.apple.com/join/ZCENBHtm  
  External group: `OpenChamber Beta`. New CI uploads are attached to this group after processing; first-time external builds require Apple Beta App Review.
- **Android:** signed APK/AAB assets on [GitHub Releases](https://github.com/yee94/openchamber/releases).

## Commands

Run these from `packages/mobile`, or use the root `mobile:*` aliases.

- `bun run build`: builds `packages/web` and prepares mobile web assets.
- `bun run sync`: prepares assets and runs `cap sync`.
- `bun run add:ios`: creates the native iOS project.
- `bun run add:android`: creates the native Android project.
- `bun run build:android:debug`: builds a debug Android APK (`com.openchamber.app.debug`) without launching an emulator. Safe to install beside a release build of `com.openchamber.app`.
- `bun run build:ios:simulator`: builds an iOS Simulator app without launching Xcode or Simulator.
- `bun run sim:run`: boots a simulator if needed, installs the built iOS app, and launches it.
- `bun run sim:serve`: starts `serve-sim` in detached JSON mode and prints the browser preview URL.
- `bun run sim:list`: lists running `serve-sim` streams.
- `bun run sim:kill`: stops running `serve-sim` streams.
- `bun run open:ios`: opens the iOS project.
- `bun run open:android`: opens the Android project.

## Headless Quickstart

```sh
bun run build
bun run sync
bun run build:ios:simulator
bun run build:android:debug
```

These commands build and sync the native projects without launching Xcode, Android Studio, Simulator, or an emulator.

## Local Tooling

The default scripts assume the local Homebrew/Xcode paths prepared for this workspace:

- Xcode: `/Applications/Xcode.app/Contents/Developer`
- JDK 21: `/opt/homebrew/opt/openjdk@21`
- Android SDK: `/opt/homebrew/share/android-commandlinetools`

Override `DEVELOPER_DIR`, `JAVA_HOME`, `ANDROID_HOME`, or `ANDROID_SDK_ROOT` when using a different local setup.

Required local tools:

- Xcode with iOS Simulator support.
- CocoaPods for iOS dependency installation.
- JDK 21 for Android Gradle builds.
- Android SDK command-line tools with platform/build-tools 35.

## Troubleshooting

- If `xcodebuild` reports that the active developer directory is Command Line Tools, keep using the provided scripts or set `DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer`.
- If Android builds fail with `Unable to locate a Java Runtime` or `source release: 21`, install/use JDK 21 and set `JAVA_HOME` accordingly.
- If Android SDK packages are missing, install `platform-tools`, `platforms;android-35`, and `build-tools;35.0.0`, then accept SDK licenses.
- If CocoaPods cannot find Capacitor pods after reinstalling dependencies, run `bun install` from the workspace root, then rerun `bun run sync`.
- If connecting to a remote OpenChamber server fails from the app while `/health` works in curl, check that the server build includes the packaged-client CORS allowlist for `capacitor://localhost` and local dev origins.
- If `serve-sim` preview says the stream is not producing frames, check the raw MJPEG stream before assuming the simulator stopped. In prior testing the raw stream worked while the browser preview UI stayed stale.

## Generated Assets

Launcher icons and splash screens use the dark OpenChamber mark (`packages/electron/resources/icons/app-icon.png` / `app-icon.svg`). Source inputs live in `packages/mobile/assets/` (`icon-only.png`, `icon-foreground.png`, `icon-background.png`); iOS `AppIcon` / Splash and Android mipmaps + splash drawables are kept in sync with that dark mark. Android 8+ uses a full-bleed `#1A1A1A` adaptive-icon background and the transparent `ic_launcher_openchamber_foreground.xml` mark; the Launcher owns masking and icon shape.
