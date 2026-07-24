# OpenChamber Mobile

Capacitor shell for the dedicated OpenChamber mobile web surface.

The mobile package reuses the web build, then rewrites `mobile.html` to `index.html` in `packages/mobile/dist` so native iOS/Android always launch `MobileApp` instead of the hosted surface selector.

## Runtime Model

- The native app bundles the mobile UI only; it does not embed the OpenChamber web server or OpenCode server.
- On first launch in Capacitor, the app shows a connection screen for an existing OpenChamber server.
- Connections are saved locally in the app and can be managed from the mobile overflow menu under `Instances`.
- The connection screen and `Instances` menu item are Capacitor-only. Hosted `mobile.html` in a normal browser keeps the regular web behavior.
- Password-protected OpenChamber servers can be unlocked from the mobile app. The app stores the issued client token with the saved connection.
- Chat `edit` and `multiedit` rows open their exact single-file tool patch in a resizable phone sheet or the iPad Changes panel. An `apply_patch` row opens every renderable file patch from that invocation. The initial target focuses its first changed line, and apply-patch turn-snapshot records open the owning turn diff.

## Native Haptics Hot Path

- The `OpenChamberHaptics.impactLight` Capacitor 8 plugin provides a fire-and-forget light impact for mobile interaction feedback.
- iOS registers the plugin from `OpenChamberBridgeViewController`, reuses one main-thread `UIImpactFeedbackGenerator(.light)`, prepares it on creation, and prepares it after every impact.
- Android registers the plugin before `BridgeActivity.onCreate`, then runs `WebView.performHapticFeedback(HapticFeedbackConstants.KEYBOARD_TAP)` on the UI thread.
- Both native methods declare a `none` return type and leave the callback unresolved to keep this input-feedback path free of promise completion work.

## Native Back Navigation

- `OpenChamberNavigation` is a progress-only native input driver for the shared UI navigation coordinator; native code never owns the React page stack.
- iOS installs a `UIScreenEdgePanGestureRecognizer` on the bridge view and recognizes back only from the physical left edge. It commits by distance or horizontal velocity. Touch samples are reduced to the newest progress once per 60 Hz `CADisplayLink` tick before crossing the Capacitor bridge, while start/cancel/invoke remain immediate.
- Android 14+ uses `OnBackAnimationCallback` for system Predictive Back progress. Android 13 receives the invoke callback without progress, and older Android versions retain Capacitor App's existing commit-only back-button fallback.
- The web hot path coalesces native progress to one compositor transform update per animation frame and performs no per-frame React state writes. Static transition, shadow, and layer-promotion styles are applied once when the gesture begins. Settlement preserves its rendered endpoint inline before cancelling `fill: forwards`, synchronously commits a successful route pop while the outgoing page remains off-screen, then clears presentation styles so WebKit cannot flash the outgoing page at x=0.
- The phone tab shell keeps the active root tab and dock mounted beneath its opaque secondary surface and marks both retained layers inert. The dock stays viewport-fixed outside the transformed content underlay so WebKit never switches its containing block by the native bottom safe-area height; interactive back reveals a complete previous page without late mounting, layout flash, or completion bounce.
- Flow-mobile Settings keeps the original directory header and navigation DOM mounted in normal flow as the underlay and presents detail content in a viewport-bounded, independently scrolling push surface. It never swaps in a fixed duplicate at detail boundaries. Only the detail surface moves; the long Settings document never becomes the interactive compositor layer, and tab panels clip horizontal overflow defensively.
- Hosted H5 registers no page-back touch gesture. Push-style mobile detail pages mirror their depth into browser history, and `popstate` invokes the same route callback; root history remains owned by the browser.
- Sheets and dialogs are modal surfaces rather than push pages. Their existing vertical dismissal and explicit close behavior remain separate; a file or Changes detail nested inside an overlay can pop before the overlay closes.

## Native Share Inbox

- `OpenChamberShare` is the Capacitor bridge for catalog updates, durable inbox consumption, and Android draft handoff. Inbox commits emit `shareReceived`; Android native draft arrivals emit `shareDraftReceived` as a delivery hint while `listPending` and `listDrafts` remain the authoritative recovery reads.
- The catalog stores assistant routing metadata only: `serverInstanceID`, `assistantID`, display fields, `connectionKey`, enabled state, and the default share target. Native code never stores server tokens or performs server requests.
- Each `NativeShareEnvelope` v1 is committed as an operation directory with `envelope.json` and app-private image files. Envelopes persist relative attachment names and `listPending` resolves them to ready-directory paths for the WebView. `ack` records a durable consumed marker; `releaseFiles` deletes the complete operation directory after upload cleanup.
- iOS Share Extension collects composer text, `NSExtensionItem.attributedContentText`, URLs, and plain-text providers into `ShareEnvelope.text`; it accepts up to 10 images. Android `ShareReceiverActivity` accepts text, URLs as text, and up to 10 images, copies them into a one-hour app-private draft, then opens the matching Assistant in the existing WebView. The WebView merges the content into that Assistant's durable Composer draft with a crash-recoverable handoff journal. Native cancellation happens only after the Composer snapshot is durable. The share contract limits each base64-decoded image to 8 MiB and each operation to 16 MiB; native stores enforce these limits from copied binary byte counts. Inbox records expire after 24 hours; startup and every bridge read remove expired, malformed, interrupted, and acknowledged writes after expiry.
- iOS declares `INSendMessageIntent` support in the app and Share Extension. Successful Assistant composer sends and Share Extension submissions donate an outgoing conversation interaction with the Assistant's generated avatar; a suggested-recipient launch resolves the exact Assistant from `conversationIdentifier`. iOS owns suggestion eligibility and ranking, while disabled or removed Assistant catalog entries delete their donated conversation groups.
- The iOS Share Extension presents its native confirmation screen. Android shows a short native opening state and uses the existing Assistant Composer for preview, editing, attachment changes, and manual sending.
- Android uses a hybrid share path: native durable ingress stages the draft, the WebView durably hands it to the existing Assistant Composer, native draft cancellation follows that handoff, and the user edits attachments or text then sends through the standard Assistant Composer flow.
- iOS resolves every shared image to `image/jpeg`, `image/png`, `image/gif`, `image/webp`, or `image/heic` from the copied file extension and matching file signature. Android preserves the content resolver's concrete image MIME, including `image/heic`. Shares with an unrecognized iOS image format return an attachment error and clean up copied temporary files.
- The share extension requires the existing `group.com.openchamber.app` App Group entitlement for the app and `OpenChamberShareExtension` target. The release signing profile must enable that App Group for `com.openchamber.app.OpenChamberShareExtension`.

## Commands

Run these from `packages/mobile`, or use the root `mobile:*` aliases.

- `bun run build`: builds `packages/web` and prepares mobile web assets.
- `bun run sync`: prepares assets and runs `cap sync`.
- `bun run add:ios`: creates the native iOS project.
- `bun run add:android`: creates the native Android project.
- `bun run build:android:debug`: builds a debug Android APK without launching an emulator.
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

The native projects currently use Capacitor-generated launcher and splash assets. Replace them before release branding work.
