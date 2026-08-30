# OpenChamber Mobile

Capacitor shell for the dedicated OpenChamber mobile web surface.

The mobile package reuses the web build, then rewrites `mobile.html` to `index.html` in `packages/mobile/dist` so native iOS/Android always launch `MobileApp` instead of the hosted surface selector.

## Runtime Model

- The native app bundles the mobile UI only; it does not embed the OpenChamber web server or OpenCode server.
- On first launch in Capacitor, the app shows a connection screen for an existing OpenChamber server.
- Connections are saved locally in the app and can be managed from Settings under `Switch instance`.
- About reports the installed native client version separately from the connected instance's OpenChamber and OpenCode versions. Mobile update checks send the native client version to the instance.
- Capacitor About export of the prerelease diagnostics log calls `OpenChamberMedia.saveFile`, which presents the system save picker (iOS `UIDocumentPickerViewController`, Android `ACTION_CREATE_DOCUMENT`). It does not copy to the clipboard or rely on `navigator.share`. Android stages the bytes in an app-private cache file and strips `dataBase64` from the Capacitor plugin call before opening the picker, so activity-pause persistence cannot hit Binder's `TransactionTooLargeException`. The picker uses `application/octet-stream` plus `EXTRA_TITLE` because OEM DocumentsUI can crash on confirm when the type is `application/json`.
- Android update actions pass the APK URL to the configured system default browser, which owns the download and installation handoff.
- The connection screen and `Switch instance` Settings page are Capacitor-only. Hosted `mobile.html` in a normal browser keeps the regular web behavior.
- Password-protected OpenChamber servers can be unlocked from the mobile app. The app stores the issued client token with the saved connection.
- Chat `edit` and `multiedit` rows open their exact single-file tool patch in a resizable phone sheet or the iPad Changes panel. An `apply_patch` row opens every renderable file patch from that invocation. The initial target focuses its first changed line, and apply-patch turn-snapshot records open the owning turn diff.
- iOS and Android register the `openchamber://` URL scheme. Opening a validated `openchamber://connect?v=2&p=...` link invokes the same one-time pairing redemption used by the QR scanner, including on cold launch; pairing secrets remain transient and are never logged or persisted.
- Pairing v2 Relay candidates carry their own `relayUrl`. Native and hosted mobile persist that endpoint with the connection metadata and use it for later reconnects, so official and self-hosted Relay connections can coexist on one client.

## Native Virtual Image Asset Bridge

- `OpenChamberVirtualAsset` is a Capacitor 8 plugin that turns renderer-owned progressive image bytes into a browser-consumable virtual URL. Web / hosted H5 keeps object-URL behavior and does not register this plugin.
- **UI bridge API** (`packages/mobile/src/openchamber-virtual-asset.ts`):
  - `create({ assetId, mime }) → { assetId, url }` — opaque one-use id (`[A-Za-z0-9_-]{8,80}`) and MIME; returns `openchamber-asset://v/{assetId}` (no host path, credentials, or filesystem location).
  - `append({ assetId, chunk })` — Base64 raw bytes (standard or URL-safe); may wait under queue backpressure.
  - `finish({ assetId })` — end of body; scheme handlers complete after draining the queue.
  - `cancel({ assetId })` — abort and cleanup; readers stop and queues are dropped.
  - `normalizeVirtualAssetMime(mime)` — optional TS pre-check aligned with native create (image-only).
- **MIME (aligned with Electron):** `image/*` only — lowercase strict subtype form (type/subtype, optional `+suffix`, no parameters), max 128 chars, rejects CR/LF/NUL. Non-image types are rejected at create.
- **iOS:** `OpenChamberBridgeViewController` registers a `WKURLSchemeHandler` for `openchamber-asset` and the plugin instance. The handler sends response headers immediately (including `X-Content-Type-Options: nosniff`), then incrementally `didReceive` queued chunks. One reader per asset; a second `beginRead` is rejected.
- **Android:** `MainActivity` registers the plugin; on load it installs a `BridgeWebViewClient` subclass that intercepts `openchamber-asset://` and returns a streaming `WebResourceResponse` backed by a thread-safe blocking `InputStream` (responses include `X-Content-Type-Options: nosniff`). One reader per asset; a second `openStream` is rejected.
- **Limits (both platforms):** 120s idle TTL, 16 concurrent assets, 32 MiB per asset, 4 MiB unread queue backpressure (append waits up to 15s), cancel/finish/close and expiry free all queues. Native code never receives host paths, relay credentials, or tunnel keys — only opaque ids and bytes.

## Native HEIC Transcode

- `OpenChamberMedia.transcode({ data, mime, quality? })` converts HEIC/HEIF image bytes to JPEG on a background queue. Shared UI discovers the method through `convertHeicToJpegViaNative` (`packages/ui/src/lib/native-image-transcode.ts`) and falls back to JS when native is absent or rejects.
- Input and output travel as Base64 JSON strings (Capacitor IPC). Default quality is `0.9` to match the existing JS converter. Non-image, non-HEIC, and decode failures reject with a readable message instead of crashing.
- **iOS:** ImageIO (`CGImageSourceCreateWithData` → `CGImageDestinationAddImage` with `kCGImageDestinationLossyCompressionQuality`) on `com.openchamber.media.transcode`.
- **Android:** `BitmapFactory.decodeByteArray` → `Bitmap.compress(JPEG)` on the existing media executor. Devices without a HEIF decoder reject so the JS fallback can run.

## Native iOS Composer

- `OpenChamberComposer` is an iOS-only Capacitor overlay. It is not registered on Android; hosted H5 and the web Composer stay unchanged.
- Collapsed state is a full-width floating glass pill (`+` inside, placeholder, Send/Stop). Focus expands a glass card whose footer matches the web Composer: `+`, spacer, Agent (identicon + brief name flash), model (icon + name), Send/Stop. A circular liquid-glass `arrow.down` sits above Send after the transcript has travelled ~80px from the live edge; the WebView scroll-to-bottom control is hidden. That button is not part of published occupancy, so Changes / TODO / queue do not jump when it appears. Plus, model, agent, and scroll stay ghost glyphs on the glass. Ready Send and Stop match the web inverted 24pt disc (`SendCircleIcon` / `StopIcon`): chrome-foreground circle, up-arrow or rounded stop square in the inverse. Idle Send stays a ghost arrow. The overlay uses one `host.bottom` pin: show follows keyboard overlap, while `willHide`/`didHide` close that session and rest on the window home-indicator inset even if a later `changeFrame` still reports an on-screen keyboard. Tapping the transcript resigns the native field.
- iOS 26 uses interactive `UIGlassEffect` (chrome lives in the effect `contentView`) plus hover lift/highlight; older iOS uses `UIBlurEffect` material. Native code never logs composer text or picked file bodies.
- The overlay is process-owned: `present` installs once, `hide` only sets `isHidden`, and `dismiss` hides then tears down keyboard/blur without `removeFromSuperview`. Native tab-bar adoption `warm`s a suppressed overlay on the homepage so the first chat enter does not create glass during navigation. ChatInput toggles `:root.oc-native-ios-composer` before paint so the web composer chrome is `display:none` on the first chat frame. Leaving chat (interactive back start on the last page, or `closeSecondary`) conceals immediately so the pill is gone before Projects is fully on screen; `dismiss` still waits one macrotask so a same-flush ChatInput remount can retain, but listeners stay attached like the tab bar. Sibling session swipe already keeps ChatInput mounted (`chat-primary` key). Session switches therefore update the same glass view: JS republishes model name + thinking with the icon, and native paints those strings as bitmaps (`rasterModelChrome`) because `UILabel` inside `UIGlassEffect` keeps the previous glyphs.
- Shared UI (`packages/ui/src/lib/native-ios-composer.ts`, `useNativeIosComposer`) presents the overlay on Capacitor iOS primary chat only. Send, abort, model, and agent stay in `ChatInput`. Native never submits a prompt itself: Return and Send emit `send` and return immediately; Web owns wait / queue / errors on the next macrotask. The send listener must not mark that draft as an echo — after Web clears the document, JS `forceText`s empty so the `UITextView` does not keep the sent text. Echoed typing does not push text, JPEG thumbs, or the model icon back across the bridge. Cancelled interactive back `show()`s the hidden overlay without rewriting the UITextView. The native `UITextView` owns text while it is first responder / composing so Chinese IME marked text is not rewritten; JS only force-writes on external changes (attach, send clear, session). The keyboard Return key sends (or queues while a turn is running) and does not insert a newline; IME marked text still confirms composition. Local non-empty text enables Send even if the last JS `canSend` is stale after an app resume. While `canAbort` is true, Stop stays on the card; a queue Send control appears above it only while the card is expanded. Collapsed abort shows Stop alone. `+` opens a `UIMenu` above the button (photos first, then files) without resigning first responder. Hiding the keyboard dismisses that menu. Photos open `PHPickerViewController`; files open `UIDocumentPickerViewController`. Those system pickers may hide the keyboard once; the card stays expanded and focus returns when the picker closes. Both emit `filesPicked` so ChatInput can attach `File` objects. The expanded card then shows a 40pt preview strip (image thumbs and file chips) with a remove control per item (`removeAttachment`). JS also publishes citation UTF-16 ranges so deleting inside `[filename]` removes the whole token and the linked attachment. Highlight parts with a trigger-icon visual are published as paint-only `chipRanges` (UTF-16 start/end, trigger well, `--primary`, rasterized sprite PNG): native colors the label, hides the trigger glyphs, overlays the icon, and unions those ranges with citations for whole-token delete. Slim chrome updates omit `chipRanges` and skip chip paint and model-bitmap raster so streaming / scroll ticks do not stall the WebView. Source text stays `/`+em-space+name — never NSTextAttachment — and chip attributes are not applied while IME marked text is active. Model and the agent picker open the existing WebView panels after the overlay suppresses itself so the sheet is tappable. Tapping the Agent identicon or the revealed name cycles the primary agent; a long-press on either opens the agent picker. The model chip is a static icon plus bitmap name and muted thinking suffix (not UILabels, so session switches refresh on the singleton overlay). Expand/collapse does not animate footer chrome (the keyboard-pin animation must not slide those labels); Agent stays in the footer stack instead of being inserted on focus. The Agent identicon matches the 16pt model icon.
- Typing `/` or `@` opens a liquid-glass autocomplete list above the card (card width, 8pt gap, internal scroll). Height uses the same clamp as the web popup (`computeMobileAutocompleteMaxHeight`): space below the mobile header, and 40% of the keyboard-aware visible column (`card.maxY`), so the first row stays on screen. The table sits above the glass (not in `UIGlassEffect.contentView`) and paints titles as bitmaps like the icons — UILabel inside the glass vibrancy layer was invisible. Glass chrome does not receive taps. Rows accept via table selection so a pan can scroll the clamped list. `overrideUserInterfaceStyle` follows the Web theme. Search, ranking, and accept stay on the JS channel (`packages/ui/src/lib/composer-autocomplete` + ChatInput insert handlers): a tap replaces the open trigger token the same way as web and `forceText`s the native field plus caret. The popup is not part of published occupancy.
- Overlay height is published as `--oc-native-composer-height` for the **collapsed** pill occupancy only. Expanding / keyboard open / showing the native scroll button does not change that value, so Changes, TODO, and the queue stay docked above the pill. JS measures those accessory rows into `--oc-native-composer-accessory` and never writes `--oc-chat-foot-inset`. `:root.oc-native-ios-composer` hides the web textarea/pill and web scroll-to-bottom controls. Queue and status rows stay absolutely docked to the overlay (8px settle toward the pill) and fade with `--oc-native-composer-dock` (visible only after arriving at the true bottom; a short downward approach stays hidden; no background veil). Queue-card rules that hide the composer-overlap tail apply only under that class — Android Capacitor and hosted/web keep the tuck-behind-input spacer. Composer-swap rest can be expanded far from the live edge and is not the fade source. Keyboard hide re-reports that collapsed height so the pill recovers.
- Capacitor Keyboard choreography skips composer FLIP while that class is set; the native `UITextView` owns IME. Hide still clears leftover `--oc-kb-layout` / `oc-keyboard-open`, snaps WKWebView scroll, and calls `OpenChamberComposer.blur()` so the web shell cannot stay raised.

## Native iOS Homepage Tab Bar

- `OpenChamberTabBar` is an iOS-only Capacitor overlay for the phone homepage dock (`projects` / `assistant` / `scheduled` / `settings`). It is not registered on Android; hosted H5 and older iOS keep the Web `MobileTabBar`.
- The overlay is adopted only when liquid glass is available (iOS 26). `present` resolves `{ adopted: false }` without installing a view so Web remains the fallback. Native code never owns the React tab stack — taps emit `tabSelected` and `MobileTabsRoot` still calls `setActiveTab`.
- The overlay is a full-screen pass-through host; only the system tab bar receives touches. Secondary pages, the scheduled-task editor, and active `#mobile-overlay-root` sheets (`data-mobile-overlay-active`, same suppress rule as the web composer) hide the overlay (`hide`) so it cannot cover those surfaces. The process-owned view stays installed and lastState is kept; returning from chat `present`s the same dock instead of rebuilding tab items. `hide` / `dismiss` only set `isHidden`. The hide is requested from `useLayoutEffect` so it is queued before the chat page paints.
- Shared UI (`packages/ui/src/lib/native-ios-tab-bar.ts`, `useNativeIosTabBar`) presents the overlay from `MobileTabsRoot` on Capacitor iOS. Labels come from existing `mobile.tabs.*` keys. The overlay hosts a chrome-only `UITabBarController` (clear placeholder pages, pass-through hit testing) so iOS 26 owns the floating liquid-glass capsule, the selected liquid-lens indicator, and light/dark materials (`overrideUserInterfaceStyle` follows the Web theme). The selected glyph uses the theme `--primary` tint; unselected items use `secondaryLabel`. Custom nested glass pills and hover lift/highlight are not used. `:root.oc-native-ios-tab-bar` marks adoption; the Web dock unmounts once adopted.

## Native Photo Picker

- `OpenChamberMedia.pickMedia({ limit? })` is Android-only. It opens the system Photo Picker (`ACTION_PICK_IMAGES`, falling back to `ACTION_GET_CONTENT` `image/*` on older devices) and returns absolute cache file paths. UI calls this only on Android Capacitor; iOS uses the WKWebView file picker. No extra permission declaration is required.

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

Shipping a beta: default to a `v*` tag so macOS and APK installers exist for first-time downloaders (`docs/RELEASING.md` § 先选产物). TestFlight follows the mobile plan mode, not the tag: betas with native-shell changes (`mode: native`) upload iOS to internal TestFlight; web-only (`mode: ota`) betas skip iOS. Stable always uploads iOS (external group). Use `mobile-beta/v*` only when the user wants mobile-web-only OTA and no installers.

- **iOS TestFlight (public link):** https://testflight.apple.com/join/ZCENBHtm  
  External group: `OpenChamber Beta`. New CI uploads are attached to this group after processing; first-time external builds require Apple Beta App Review.
- **Android:** signed APK/AAB assets on [GitHub Releases](https://github.com/yee94/openchamber/releases).
  Package id is `com.yee94.openchamber`. If an older build used upstream `com.openchamber.app`,
  uninstall that app first — same icon/name does not mean Android will overwrite it when the
  signing key differs.

## Commands

Run these from `packages/mobile`, or use the root `mobile:*` aliases.

- `bun run build`: builds `packages/web` and prepares mobile web assets.
- `bun run sync`: prepares assets and runs `cap sync`.
- `bun run add:ios`: creates the native iOS project.
- `bun run add:android`: creates the native Android project.
- `bun run build:android:debug`: builds a debug Android APK (`com.yee94.openchamber.debug`) without launching an emulator. Safe to install beside a release build of `com.yee94.openchamber`.
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

Launcher icons and splash screens use the dark OpenChamber mark (`packages/electron/resources/icons/app-icon.png` / `app-icon.svg`). Source inputs live in `packages/mobile/assets/` (`icon-only.png`, `icon-foreground.png`, `icon-background.png`); iOS `AppIcon` / Splash and Android mipmaps + splash drawables are kept in sync with that dark mark. The shared macOS/iOS Icon Composer source `packages/electron/resources/icons/AppIcon.icon` is forced to the dark mark for light, dark, and tinted appearances (regenerate desktop `Assets.car` with `bun run --cwd packages/electron generate:macos-icon`). Android 8+ uses a full-bleed dark gradient adaptive-icon background (`ic_launcher_openchamber_background.xml`) plus transparent cube-only foregrounds in `mipmap-*/ic_launcher_foreground.png`; the launcher owns masking and icon shape. Regenerate those foregrounds with `python3 scripts/gen-android-adaptive-icon.py` after changing `icon-only.png` — they must stay 108dp canvases with the mark inside the 66dp safe zone, otherwise launchers stack the finished icon card over the adaptive background.