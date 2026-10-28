# Yuri Mobile

Capacitor shell for the dedicated Yuri mobile web surface.

The mobile package reuses the web build, then rewrites `mobile.html` to `index.html` in `packages/mobile/dist` so native iOS/Android always launch `MobileApp` instead of the hosted surface selector. Workspace `bun run --filter '*' build` can run this package in parallel with `@yuriai/web`; `scripts/prepare-web-assets.mjs` retries the copy until `mobile.html` is readable so a sibling Vite `emptyOutDir` cannot fail the mobile job.

## Runtime Model

The Assistant dock icon accepts the UI-owned optional `avatar` SVG data URI.
It follows the newest enabled contact and uses the same working animation as
desktop/Android/hosted mobile. iOS renders the local image in a noninteractive
28.75pt transparent WebKit surface centered on the unchanged 23pt system icon slot
to compensate for the artwork's transparent margins; clearing restores the symbol.
This native dock addition requires a native rebuild; older shells ignore it.

### Yuri native identity migration (shell API 2)

This is a new installation, not an OTA-only rename. `YuriOTA.shellApiVersion`
and `YURI_SHELL_API_VERSION` are now **3**. The update publisher must use
`minShellApiVersion: 3` and application identity `com.yee94.yuri` for every new Yuri
bundle. Old shells must receive `install_native_required`, never a Yuri UI bundle.
The UI and Host owners must update all plugin imports, `Yuri*` registration names,
`yuri://` deep links, `yuri-asset://` resources and `yuri:ime-state` together.
The native relay HKDF label is `yuri-relay-v1` and must match both transport peers.

Shell API 3 adds `YuriUpdateConfig.getConfiguration` on Android and iOS. It reads
only `YuriOTA.channel` and `YuriOTA.shellApiVersion` from the installed APK/IPA's
`capacitor.config.json`, never the replaceable Capgo web directory. The shared
update coordinator and About channel control use this bridge; Capacitor's JS
object does not expose `getConfig()` or `config`. Missing/invalid metadata fails
the check instead of inventing epoch 1. Installing the new native shell is required;
the broken 0.1.3 updater cannot fetch this repair itself. Hosted mobile keeps its
existing public-feed path. Capgo automatic checks remain disabled and their legacy
identity-only epoch inference stays conservative; interactive checks send epoch 3.

Identity inventory (old strings here are migration documentation only):

| Previous identity | New identity |
| --- | --- |
| `com.yee94.openchamber` | `com.yee94.yuri` |
| `com.yee94.openchamber.debug` | `com.yee94.yuri.debug` |
| `group.com.yee94.openchamber` | `group.com.yee94.yuri` |
| `com.yee94.openchamber.OpenChamberWidget` | `com.yee94.yuri.YuriWidget` |
| `com.yee94.openchamber.OpenChamberShareExtension` | `com.yee94.yuri.YuriShareExtension` |
| `com.yee94.openchamber.OpenChamberNotificationService` | `com.yee94.yuri.YuriNotificationService` |
| Java namespace `com.openchamber.app` | `com.yuri.app` |

The native app cannot read the previous application's sandbox, Keychain or App
Group. Keep that application installed. Before moving, copy unsent text to a
user-controlled document and save local attachments through the existing preview
save action. Install Yuri alongside it, pair again using a fresh Host QR/link,
then paste drafts and attach the saved files. Host-owned conversations, assistants
and tasks remain on the same Host and are recovered by reconnecting; do not reset
the Host identity. Reconfigure local preferences and enable notifications again.
Queued native shares must be completed or manually recovered in the old app.
Do not uninstall it until those local items are verified. No automatic export of
inaccessible local databases or old authentication tokens is claimed.

Signing and distribution remain blocked: verify all four Apple bundle IDs, App
Group, profiles, APNs topic and Store records, Android application IDs/keystore,
and the new TestFlight invitation. A previous Firebase application configuration
is not valid for the new ID; provide a newly registered `google-services.json`
only if FCM is used. Android's notification stream does not depend on FCM.
Set `YURI_OTA_UPDATE_URL` to a verified deployment before distribution; its default
is empty. No remote identity, signing or production OTA validation was performed.

The previous-identity table and receive-only legacy deep-link scheme registrations
are intentional old-brand exceptions. The mobile maintainer owns them; remove
scheme aliases only after legacy external links are no longer supported, and the
identity table after retained installations have recovered their data.

- Native high refresh rate: Android votes for the highest supported refresh rate
  at the current resolution on resume/window focus, leaving power/thermal policy
  to the OS. iOS keeps the ProMotion plist opt-in and disables WebKit's exact
  `PreferPageRenderingUpdatesNear60FPSEnabled` preference when its SPI exists.
  Missing SPI leaves defaults intact; this uses private API and has App Store
  review implications. No perpetual display link or forced WebView layout is used.
  These are native-build changes, not OTA changes. Neither a refresh-rate request
  nor CADisplayLink cadence proves WebView presentation FPS; verify on high-refresh
  physical devices. Hosted browsers retain their own refresh-rate policy.

- Chat overflow → Auto-read replies is local to the current open conversation.
  `YuriScreenAwake` keeps the foreground screen on while enabled: iOS
  uses `UIApplication.isIdleTimerDisabled`; Android uses `FLAG_KEEP_SCREEN_ON`.
  Pause/disable releases the screen, and resume reapplies only while enabled.
  Hosted mobile uses browser Screen Wake Lock. The native plugin requires a
  native build, not just an OTA web update; older shells try browser Wake Lock
  and report unsupported environments. Voice/Relay requests keep their existing
  runtime transport and configured provider.

- The native app bundles the mobile UI only; it does not embed the Yuri web server or OpenCode server.
- OTA checks are isolated by running release major and beta/stable channel: 1.x stays on 1.x and 2.x stays on 2.x, including channel rollback. New shared-UI clients send `releaseMajor` and reject cross-major responses, downloads and cached-bundle reuse. Legacy clients are routed by their existing bundle/native version fields on the update service. See `deploy/update-service/README.md` for the catalog and rollout-order contract.
- On first launch in Capacitor, the app shows a connection screen for an existing Yuri server.
- `apps/MobileConnectionWelcome.tsx` owns the disconnected welcome flow. With no history, QR scanning is primary (pairing-link entry when scanning is unavailable). With history, the most recently used device and Continue take priority; its row opens connection history. History never implies live online status.
- More options uses the shared `MobileResizableSheet`, `MobilePairingLinkForm`, and `Input`. Clipboard reads are user-triggered with manual paste guidance on denial; a pasted link never redeems before explicit submission. Drafts survive closing the sheet. Password challenges, rename, and local removal confirmation use the same sheet; history uses `MobileWindowMotion` page presentation, `MobileDetailNavigation`, `ScrollableOverlay`, and shared dropdown menus. Android back dismisses menu, sheet, then history before minimizing. Manual address/token editing remains in Settings instance management.
- Connections sort by `lastUsedAt`. Successful connect/unlock/re-pair/auto-connect advances it; edits, renames, and password challenges preserve it (new unconnected saves use zero). Existing timestamps remain compatible; legacy values are retained rather than inventing past successful-connect times. Rename changes only the label, preserving identities, candidates and secure credentials. Metadata writes commit before list replacement; failed writes preserve the list and expose an error. Local deletion uses the existing secure-token/cache cleanup path, and post-commit auxiliary catalog cleanup cannot resurrect deleted rows.
- The welcome places the sculpted-serif `YuriWordmark` in a safe-area-aware top-left header and the shared Yuri portrait in the hero, which decoratively reuses `yuri-image-loading` dots (without loading/status semantics). `apps/mobile-welcome.css` owns the bounded fade, 4.2s drift, stronger 2.4s breathing cycle, and monochrome action. Animation pauses during native inactivity, scanning, history or any sheet and is disabled by reduced-motion preferences; it adds no JavaScript animation loop or per-dot DOM nodes.
- Connections are saved locally in the app and can be managed from Settings under `Switch instance`.
- About reports the installed native client version separately from the connected instance's Yuri and OpenCode versions. Mobile update checks send the native client version to the instance.
- Capacitor About export of the prerelease diagnostics log calls `YuriMedia.saveFile`, which presents the system save picker (iOS `UIDocumentPickerViewController`, Android `ACTION_CREATE_DOCUMENT`). It does not copy to the clipboard or rely on `navigator.share`. Android stages the bytes in an app-private cache file and strips `dataBase64` from the Capacitor plugin call before opening the picker, so activity-pause persistence cannot hit Binder's `TransactionTooLargeException`. The picker uses `application/octet-stream` plus `EXTRA_TITLE` because OEM DocumentsUI can crash on confirm when the type is `application/json`.
- Android update actions pass the APK URL to the configured system default browser, which owns the download and installation handoff.
- Mobile chat HTTP(S) links open the browser rather than the desktop context panel. Android shares the update-download `YuriExternalBrowser` bridge through `packages/ui/src/lib/native-external-browser.ts`; iOS and hosted H5 use the window browser handoff.
- The connection screen and `Switch instance` Settings page are Capacitor-only. Hosted `mobile.html` in a normal browser keeps the regular web behavior.
- Password-protected Yuri servers can be unlocked from the mobile app. The app stores the issued client token with the saved connection.
- Chat `edit` and `multiedit` rows open their exact single-file tool patch in a resizable phone sheet or the iPad Changes panel. An `apply_patch` row opens every renderable file patch from that invocation. The initial target focuses its first changed line, and apply-patch turn-snapshot records open the owning turn diff.
- iOS and Android register the `yuri://` URL scheme. Opening a validated `yuri://connect?v=2&p=...` link invokes the same one-time pairing redemption used by the QR scanner, including on cold launch; pairing secrets remain transient and are never logged or persisted.
- They also register `openchamber://` and `openchambery://` as receive-only aliases. Old links use the same route and pairing validation; all newly generated links remain `yuri://`. Scheme compatibility does not revive expired pairing secrets or the retired v1 credential-in-URL format. Installing the updated native shell is required; OTA cannot register OS schemes. If both applications remain installed, the OS/default-app selection determines which application opens an old-scheme link.
- Pairing v2 Relay candidates carry their own `relayUrl`. Native and hosted mobile persist that endpoint with the connection metadata and use it for later reconnects, so official and self-hosted Relay connections can coexist on one client.

## Native Virtual Image Asset Bridge

- Session inline images, file-sheet and fullscreen previews use the shared image-resource path. Requests pass through `runtimeFetch` for both LAN and Relay, then the existing native bridge supplies `yuri-asset://`. Native stream support is sufficient for inline loading; desktop disk caching is not required. Each reader gets a separate one-use stream, and unmounting aborts/releases its resources. Browser-only inline images remain placeholders; explicit previews retain an on-demand Blob fallback. This uses the already-installed mobile plugin and does not add mobile disk caching.
- `YuriVirtualAsset` is a Capacitor 8 plugin that turns renderer-owned progressive image bytes into a browser-consumable virtual URL. Web / hosted H5 keeps object-URL behavior and does not register this plugin.
- **UI bridge API** (`packages/mobile/src/yuri-virtual-asset.ts`):
  - `create({ assetId, mime }) → { assetId, url }` — opaque one-use id (`[A-Za-z0-9_-]{8,80}`) and MIME; returns `yuri-asset://v/{assetId}` (no host path, credentials, or filesystem location).
  - `append({ assetId, chunk })` — Base64 raw bytes (standard or URL-safe); may wait under queue backpressure.
  - `finish({ assetId })` — end of body; scheme handlers complete after draining the queue.
  - `cancel({ assetId })` — abort and cleanup; readers stop and queues are dropped.
  - `normalizeVirtualAssetMime(mime)` — optional TS pre-check aligned with native create (image-only).
- **MIME (aligned with Electron):** `image/*` only — lowercase strict subtype form (type/subtype, optional `+suffix`, no parameters), max 128 chars, rejects CR/LF/NUL. Non-image types are rejected at create.
- **iOS:** `YuriBridgeViewController` registers a `WKURLSchemeHandler` for `yuri-asset` and the plugin instance. The handler sends response headers immediately (including `X-Content-Type-Options: nosniff`), then incrementally `didReceive` queued chunks. One reader per asset; a second `beginRead` is rejected.
- **Android:** `MainActivity` registers the plugin; on load it installs a `BridgeWebViewClient` subclass that intercepts `yuri-asset://` and returns a streaming `WebResourceResponse` backed by a thread-safe blocking `InputStream` (responses include `X-Content-Type-Options: nosniff`). One reader per asset; a second `openStream` is rejected.
- **Limits (both platforms):** 120s idle TTL, 16 concurrent assets, 32 MiB per asset, 4 MiB unread queue backpressure (append waits up to 15s), cancel/finish/close and expiry free all queues. Native code never receives host paths, relay credentials, or tunnel keys — only opaque ids and bytes.

## Native GUI View Export

The native method/event surface is registered in `contracts/yuri-view-export.mjs`
and validated by `mobile-release-plan` before release.

`YuriViewExport` exposes two independent client-container methods, `exportPDF`
and `exportLongImage`, plus `capabilities`, `cancel` and task-scoped `progress`
events. Shared UI discovers the installed native implementation through
`RuntimeAPIs.viewExport`; the GUI host provides the ordinary SDK Contracts
`yuri.exportPDF` and `yuri.exportLongImage`. Their capabilities are independent
of the connected OpenCode Host and LAN/Relay transport. A new native build is
required; hosted browsers and old shells without the plugin hide both actions.

The caller supplies a static HTML snapshot with embedded assets and CSS-pixel
dimensions. Native code independently validates the payload and renders in a
separate script/network-disabled WebView, then opens the system document picker.
Generated files stay in native temporary storage rather than crossing the bridge
as base64. PDF defaults to paginated A4, optionally Letter, with 24-point margins
and 96 CSS pixels per inch (shrinking to fit, never enlarging); PNG uses one output
pixel per CSS pixel. Android advertises 16 MiB HTML, width 8192, height 32768 and
16,777,216 pixels. iOS advertises lower bounds: 4 MiB HTML, width 2048, height
32768 and 8,388,608 pixels. Consumers use the returned limits; exceeding a limit
fails rather than truncating output.

iOS attaches a task-owned WKWebView beneath the app content. PNG captures and
composes viewport-sized tiles; PDF uses `WKWebView.createPDF` and CoreGraphics
pagination to retain native text/vector output. Temporary views, files and
listeners are released on completion or cancellation. An in-flight ImageIO
encode drains before the owner becomes available for another export. The
system export-as-copy picker owns file placement and reports completion.
WebKit can map some Chinese PDF glyphs to radical code points; visual output
remains intact, but exact text search for those characters is not guaranteed.

Android uses a dedicated attached full-size WebView and does not enable global
`enableSlowWholeDocumentDraw`. PNG is encoded off the main thread; PDF draws each
page directly to a PDF Canvas, yielding between pages. The HTML is removed from
the Capacitor call before opening `ACTION_CREATE_DOCUMENT`, preventing it from
entering activity-state Binder serialization. Cancelled/failed writes attempt to
remove their incomplete destination and always release private staging files;
the task cannot report saved before the output stream closes. A pending native
picker retains its reservation until its result arrives, so a late result cannot
be assigned to another export.

See `packages/ui/src/lib/view-export/DOCUMENTATION.md` for the full public
contract. `test/view-export-android.test.mjs` runs production Java validation;
its opt-in `YURI_ANDROID_TEST_DEVICE` instrumentation exercises complete PNG,
PDF text/page structure, save, failure and cancellation on an installed device.
Android APK compilation alone does not establish rendering or picker correctness.

`test/view-export-ios.test.mjs` is opt-in with `YURI_IOS_TEST_DEVICE` (a booted
simulator UDID). Its bridge test also needs `YURI_IOS_TEST_PRODUCTS`, the existing
simulator build-products directory containing Capacitor and Cordova frameworks.
It compiles the production Swift into isolated probe apps, installs/runs them,
and removes them afterward; it does not change signing or install the product app.

## Native Image Save Compatibility

`YuriMedia.saveImage` detects WebP from its ImageIO type and normalizes it
to PNG before handing its UIImage to Photos. UIKit can display WebP but Photos
rejects the retained WebP encoding with `PHPhotosErrorDomain 3302`, even with
add-only permission granted. Other decoded formats keep their existing path.
This fix requires a native iOS build. The opt-in
`test/media-save-ios.test.mjs` compiles the production plugin and writes a neutral
WebP fixture to a simulator's Photos library. Run it with `YURI_IOS_TEST_DEVICE`
(a booted simulator UDID) and `YURI_IOS_TEST_PRODUCTS` (the simulator build's
`Debug-iphonesimulator` products directory); without both it is skipped.

## Native Video Range Bridge

- iOS registers `YuriVideo` (`create`, `respond`, `release`, `request` events).
  `YuriVideoServer` binds an ephemeral **IPv4 loopback-only** HTTP listener
  for each opaque video lease. WebKit/AVFoundation use ordinary HTTP byte ranges;
  the image-only, one-reader `yuri-asset` scheme is not reused for video.
- The renderer alone keeps the canonical remote path and credentials. It handles
  events through `runtimeFetch`, so the same authenticated requests travel over
  LAN or encrypted Relay. Native receives only opaque IDs, MIME, range metadata
  and base64 bytes. The Host must include the `/api/fs/raw` Range implementation.
- At most two leases and eight pending requests per lease; headers are limited
  to 16 KiB, range bodies to 1 MiB, pending requests to 30 seconds. Seek/disconnect
  aborts the corresponding Relay request. Closing the preview or changing runtime
  releases listeners, native sockets and pending controllers. HEAD size is derived
  from Content-Range because Relay deliberately strips Content-Length.
- This requires a **new iOS native build and updated Host**. Android, browsers,
  desktop and older iOS shells retain the full-blob fallback. No third-party
  player, transcoder or relay protocol change is introduced.
- `test/video-server.test.mjs` compiles the production Swift server on macOS,
  exercises real HTTP Range/HEAD/cancellation, and decodes/seeks a generated H.264
  movie with AVFoundation. Device-specific WebKit/Photos permission behavior still
  requires iOS device validation.

## Native HEIC Transcode

- `YuriMedia.transcode({ data, mime, quality? })` converts HEIC/HEIF image bytes to JPEG on a background queue. Shared UI discovers the method through `convertHeicToJpegViaNative` (`packages/ui/src/lib/native-image-transcode.ts`) and falls back to JS when native is absent or rejects.
- Input and output travel as Base64 JSON strings (Capacitor IPC). Default quality is `0.9` to match the existing JS converter. Non-image, non-HEIC, and decode failures reject with a readable message instead of crashing.
- **iOS:** ImageIO (`CGImageSourceCreateWithData` → `CGImageDestinationAddImage` with `kCGImageDestinationLossyCompressionQuality`) on `com.yuri.media.transcode`.
- **Android:** `BitmapFactory.decodeByteArray` → `Bitmap.compress(JPEG)` on the existing media executor. Devices without a HEIF decoder reject so the JS fallback can run.

## Native Android Keyboard

`ImeSyncBridge` emits `yuri:ime-state` visibility and height through the asynchronous Capacitor WebView bridge. Shared UI's `useNativeMobileChrome` in `packages/ui/src/apps/MobileApp.tsx` owns the Android response. On native close, both its open and already-closed paths restrict `blur()` to a focused text field inside `.yuri-mobile-composer`. Settings, model-picker search, and other fields retain DOM focus across late or repeated close events. Keyboard insets, classes, and composer lift still follow the existing close lifecycle. Native Back dismissal continues to blur the focused composer so a subsequent tap can start a fresh keyboard session.

The shared UI focus regression tests exercise the production hook and real picker sheet with simulated native events; actual device event ordering and keyboard presentation require Android validation.

## Native iOS Composer

- On supported primary chat surfaces, enabled native iOS UI takes precedence over hold-to-talk. The dictation preference is preserved, but hold-to-talk is inactive while the native composer owns input; disabling native UI restores it.
- `YuriComposer` is an iOS-only Capacitor overlay. It is not registered on Android; hosted H5 and the web Composer stay unchanged. Appearance Settings on Capacitor iOS exposes `yuri.iosNativeUi` (default off). Turning it on makes `canUseNativeIosComposer` and the native tab bar available; off keeps the same WebView path as Android. Live Activities are not gated by this setting.
- Collapsed state is a full-width floating glass pill (`+` inside, placeholder, Send/Stop). Focus expands a glass card whose footer matches the web Composer: `+`, spacer, Agent (identicon + brief name flash), model (icon + name), Send/Stop. A circular liquid-glass `arrow.down` sits above Send after the transcript has travelled ~80px from the live edge; the WebView scroll-to-bottom control is hidden. That button is not part of published occupancy, so Changes / TODO / queue do not jump when it appears. Plus, model, agent, and scroll stay ghost glyphs on the glass. Ready Send and Stop match the web inverted 24pt disc (`SendCircleIcon` / `StopIcon`): chrome-foreground circle, up-arrow or rounded stop square in the inverse. Idle Send stays a ghost arrow. The overlay uses one `host.bottom` pin: show follows keyboard overlap, while `willHide`/`didHide` close that session and rest on the window home-indicator inset even if a later `changeFrame` still reports an on-screen keyboard. Tapping the transcript resigns the native field.
- iOS 26 uses interactive `UIGlassEffect` (chrome lives in the effect `contentView`) plus hover lift/highlight; older iOS uses `UIBlurEffect` material. Native code never logs composer text or picked file bodies.
- The overlay is process-owned: `present` installs once, `hide` only sets `isHidden`, and `dismiss` hides then tears down keyboard/blur without `removeFromSuperview`. Native tab-bar adoption `warm`s a suppressed overlay on the homepage so the first chat enter does not create glass during navigation. ChatInput toggles `:root.yuri-native-ios-composer` before paint so the web composer chrome is `display:none` on the first chat frame. Leaving chat (interactive back start on the last page, or `closeSecondary`) conceals immediately so the pill is gone before Projects is fully on screen; `dismiss` still waits one macrotask so a same-flush ChatInput remount can retain, but listeners stay attached like the tab bar. Sibling session swipe already keeps ChatInput mounted (`chat-primary` key). Session switches therefore update the same glass view: JS republishes model name + thinking with the icon, and native paints those strings as bitmaps (`rasterModelChrome`) because `UILabel` inside `UIGlassEffect` keeps the previous glyphs.
- Shared UI (`packages/ui/src/lib/native-ios-composer.ts`, `useNativeIosComposer`) presents the overlay on Capacitor iOS primary chat only. Send, abort, model, and agent stay in `ChatInput`. Native never submits a prompt itself: Return and Send emit `send` and return immediately; Web owns wait / queue / errors on the next macrotask. The send listener must not mark that draft as an echo — after Web clears the document, JS `forceText`s empty so the `UITextView` does not keep the sent text. Echoed typing does not push text, JPEG thumbs, or the model icon back across the bridge. Cancelled interactive back `show()`s the hidden overlay without rewriting the UITextView. The native `UITextView` owns text while it is first responder / composing so Chinese IME marked text is not rewritten; JS only force-writes on external changes (attach, send clear, session, sent-message edit). A leftover keystroke/blur echo must not omit or revert that preset. The keyboard Return key sends (or queues while a turn is running) and does not insert a newline; IME marked text still confirms composition. Local non-empty text enables Send even if the last JS `canSend` is stale after an app resume. While `canAbort` is true, Stop stays on the card; a queue Send control appears above it only while the card is expanded. Collapsed abort shows Stop alone. `+` opens a `UIMenu` above the button (photos first, then files) without resigning first responder. Hiding the keyboard dismisses that menu. Photos open `PHPickerViewController`; files open `UIDocumentPickerViewController`. Those system pickers may hide the keyboard once; the card stays expanded and focus returns when the picker closes. Both emit `filesPicked` so ChatInput can attach `File` objects. The expanded card then shows a 40pt preview strip (image thumbs and file chips) with a remove control per item (`removeAttachment`). JS also publishes citation UTF-16 ranges so deleting inside `[filename]` removes the whole token and the linked attachment. Highlight parts with a trigger-icon visual are published as paint-only `chipRanges` (UTF-16 start/end, trigger well, `--primary`, rasterized sprite PNG): native colors the label, hides the trigger glyphs, overlays the icon, and unions those ranges with citations for whole-token delete. Slim chrome updates omit `chipRanges` and skip chip paint and model-bitmap raster so streaming / scroll ticks do not stall the WebView. Source text stays `/`+em-space+name — never NSTextAttachment — and chip attributes are not applied while IME marked text is active. Model and the agent picker open the existing WebView panels after the overlay suppresses itself so the sheet is tappable. Tapping the Agent identicon or the revealed name cycles the primary agent; a long-press on either opens the agent picker. The model chip is a static icon plus bitmap name and muted thinking suffix (not UILabels, so session switches refresh on the singleton overlay). Expand/collapse does not animate footer chrome (the keyboard-pin animation must not slide those labels); Agent stays in the footer stack instead of being inserted on focus. The Agent identicon matches the 16pt model icon.
- Typing `/` or `@` opens a liquid-glass autocomplete list above the card (card width, 8pt gap, internal scroll). Height uses the same clamp as the web popup (`computeMobileAutocompleteMaxHeight`): space below the mobile header, and 40% of the keyboard-aware visible column (`card.maxY`), so the first row stays on screen. The table sits above the glass (not in `UIGlassEffect.contentView`) and paints titles as bitmaps like the icons — UILabel inside the glass vibrancy layer was invisible. Glass chrome does not receive taps. Rows accept via table selection so a pan can scroll the clamped list. `overrideUserInterfaceStyle` follows the Web theme. Search, ranking, and accept stay on the JS channel (`packages/ui/src/lib/composer-autocomplete` + ChatInput insert handlers): a tap replaces the open trigger token the same way as web and `forceText`s the native field plus caret. The popup is not part of published occupancy.
- Overlay height is published as `--yuri-native-composer-height` for the **collapsed** pill occupancy only. Expanding / keyboard open / showing the native scroll button does not change that value, so Changes, TODO, and the queue stay docked above the pill. JS measures those accessory rows into `--yuri-native-composer-accessory` and never writes `--yuri-chat-foot-inset`. `:root.yuri-native-ios-composer` hides the web textarea/pill and web scroll-to-bottom controls. Queue and status rows stay absolutely docked to the overlay (8px settle toward the pill) and fade with `--yuri-native-composer-dock` (visible only after arriving at the true bottom; a short downward approach stays hidden; no background veil). Queue-card rules that hide the composer-overlap tail apply only under that class — Android Capacitor and hosted/web keep the tuck-behind-input spacer. Composer-swap rest can be expanded far from the live edge and is not the fade source. Keyboard hide re-reports that collapsed height so the pill recovers.
- Capacitor Keyboard choreography skips composer FLIP while that class is set; the native `UITextView` owns IME. Hide still clears leftover `--yuri-kb-layout` / `yuri-keyboard-open`, snaps WKWebView scroll, and calls `YuriComposer.blur()` so the web shell cannot stay raised.

## Native iOS Homepage Tab Bar

- `YuriTabBar` is an iOS-only Capacitor overlay for the phone homepage dock (`projects` / `assistant` / `scheduled` / `settings`). It is not registered on Android; hosted H5 and older iOS keep the Web `MobileTabBar`.
- The overlay is adopted only when liquid glass is available (iOS 26). `present` resolves `{ adopted: false }` without installing a view so Web remains the fallback. Native code never owns the React tab stack — taps emit `tabSelected` and `MobileTabsRoot` still calls `setActiveTab`.
- The overlay is a full-screen pass-through host; only the system tab bar receives touches. Secondary pages, the scheduled-task editor, and active `#mobile-overlay-root` sheets (`data-mobile-overlay-active`, same suppress rule as the web composer) hide the overlay (`hide`) so it cannot cover those surfaces. The process-owned view stays installed and lastState is kept; returning from chat `present`s the same dock instead of rebuilding tab items. `hide` / `dismiss` only set `isHidden`. The hide is requested from `useLayoutEffect` so it is queued before the chat page paints.
- Shared UI (`packages/ui/src/lib/native-ios-tab-bar.ts`, `useNativeIosTabBar`) presents the overlay from `MobileTabsRoot` on Capacitor iOS when `yuri.iosNativeUi` is on. Labels come from existing `mobile.tabs.*` keys. Each tab may carry an optional `badge` display string (`string | null`); UI owns formatting (including the `99+` cap), and native only maps non-empty strings onto `UITabBarItem.badgeValue` (null/empty clears). A tab may also set `activity` with `activityLabel`. UI sends activity only when that tab's unread count is zero and work is in progress; native paints an 18pt spinner badge in the count-badge corner and does not combine it with `badgeValue`. Badge-only and activity-only updates reuse the installed items instead of rebuilding chrome. The overlay hosts a chrome-only `UITabBarController` (clear placeholder pages, pass-through hit testing) so iOS 26 owns the floating liquid-glass capsule, the selected liquid-lens indicator, and light/dark materials (`overrideUserInterfaceStyle` follows the Web theme). The selected glyph uses the theme `--primary` tint; unselected items use `secondaryLabel`. Custom nested glass pills and hover lift/highlight are not used. `:root.yuri-native-ios-tab-bar` marks adoption; the Web dock unmounts once adopted.

- Native iOS tabs always use their default SF Symbols, including the Assistant tab. Custom assistant avatars are not sent to or rendered by the native tab bar.

## Native Photo Picker

- `YuriMedia.pickMedia({ limit? })` is Android-only. It opens the system Photo Picker (`ACTION_PICK_IMAGES`, falling back to `ACTION_GET_CONTENT` `image/*` on older devices) and returns absolute cache file paths. UI calls this only on Android Capacitor; iOS uses the WKWebView file picker. No extra permission declaration is required.

## Native Haptics Hot Path

- The `YuriHaptics` Capacitor 8 plugin provides fire-and-forget impact feedback at three strengths: `impactLight`, `impactMedium`, and `impactHeavy`.
- Shared UI maps `triggerMobileHaptic('light' | 'medium' | 'heavy')` to the matching native method. Button taps use light; swipe threshold commits use medium.
- iOS registers the plugin from `YuriBridgeViewController` and reuses one main-thread `UIImpactFeedbackGenerator` per style (`.light` / `.medium` / `.heavy`) via `YuriHapticFeedback`, preparing on creation and after every impact. The native composer fires the same light impact on send / queue-send / stop, model picker, agent cycle / long-press open, attach `+` press, and photo/file menu actions so it matches web button taps.
- Android registers the plugin before `BridgeActivity.onCreate`, then runs `WebView.performHapticFeedback` on the UI thread: `CLOCK_TICK` (light), `KEYBOARD_TAP` (medium), and `CONFIRM` / `LONG_PRESS` fallback (heavy).
- All native methods declare a `none` return type and leave the callback unresolved to keep this input-feedback path free of promise completion work.

## Native Back Navigation

- `YuriNavigation` is a progress-only native input driver for the shared UI navigation coordinator; native code never owns the React page stack.
- iOS installs a `UIScreenEdgePanGestureRecognizer` on the bridge view and recognizes back only from the physical left edge. It commits by distance or horizontal velocity. Touch samples are reduced to the newest progress once per `CADisplayLink` tick at the screen's maximum refresh rate, including ProMotion; completion events include horizontal release velocity.
- Android 14+ uses `OnBackAnimationCallback` for system Predictive Back progress. Android 13 receives the invoke callback without progress, and older Android versions retain Capacitor App's existing commit-only back-button fallback.
- The web hot path coalesces native progress to one compositor transform update per animation frame and performs no per-frame React state writes. Static transition and layer-promotion styles are applied once when the gesture begins. Settlement duration follows remaining distance and release velocity; commit and cancel preserve their rendered endpoints, cancel `fill: forwards`, and clear every transform/animation hint after the route transition.
- The phone tab shell owns an arbitrary-depth metadata-only chat route stack and renders a two-page DOM window containing the top route plus its immediate predecessor. Secondary enter is instant (no push WAAPI): the top page mounts at rest to avoid the chat-page left settle flash. Interactive back still reveals the real parent, commits session selection after the outgoing page reaches 100%, and supports grandchild-to-root traversal one level at a time. A deep-linked child gains its immediate predecessor when the authoritative parent entity resolves.
- Only the top page is interactive. Its predecessor, root tab, and dock remain mounted and inert with `aria-hidden`; focus enters a pushed page and returns to the original root trigger after the stack closes. Each phone chat page binds one explicit transcript selection, and predecessor pages render read-only without an additional retained transcript cache.
- Flow-mobile Settings keeps viewport-bounded root, split collection, and detail surfaces as sibling layers, retaining the immediate predecessor at each depth. Scheduled Tasks keeps one persistent root layer behind its independently scrolling detail surface. Root routes register their bounded layers explicitly; gesture code never discovers an underlay by querying the outgoing page's ancestors. Only those bounded layers move, long tab documents never become compositor layers, and horizontal overflow remains clipped throughout the interaction.
- Hosted H5 registers no page-back touch gesture. Push-style mobile detail pages mirror their depth into browser history, and `popstate` invokes the same route callback; root history remains owned by the browser.
- Sheets and dialogs are modal surfaces rather than push pages. Their existing vertical dismissal and explicit close behavior remain separate; a file or Changes detail nested inside an overlay can pop before the overlay closes.

## Native Share Inbox

- `YuriShare` is the Capacitor bridge for catalog updates, durable inbox consumption, and Android draft handoff. Inbox commits emit `shareReceived`; Android native draft arrivals emit `shareDraftReceived` as a delivery hint while `listPending` and `listDrafts` remain the authoritative recovery reads.
- The catalog stores assistant routing metadata only: `serverInstanceID`, `assistantID`, display fields, `connectionKey`, enabled state, and the default share target. Native code never stores server tokens or performs server requests.
- Each `NativeShareEnvelope` v1 is committed as an operation directory with `envelope.json` and app-private image files. Envelopes persist relative attachment names and `listPending` resolves them to ready-directory paths for the WebView. `ack` records a durable consumed marker; `releaseFiles` deletes the complete operation directory after upload cleanup.
- iOS Share Extension collects composer text, `NSExtensionItem.attributedContentText`, URLs, and plain-text providers into `ShareEnvelope.text`; it accepts up to 10 images. Android `ShareReceiverActivity` accepts text, URLs as text, and up to 10 images, and copies them into a one-hour app-private draft. Generic shares open an in-app Assistant recipient picker; after selection, the WebView switches to that instance and merges the content into the selected Assistant's durable Composer draft with a crash-recoverable handoff journal. Native cancellation happens only after the Composer snapshot is durable. The iOS share extension limits each base64-decoded image to 8 MiB and each operation to 16 MiB; Android native drafts allow one image or all images together up to 20 MiB. Native stores enforce these limits from copied binary byte counts. Inbox records expire after 24 hours; startup and every bridge read remove expired, malformed, interrupted, and acknowledged writes after expiry.
- iOS declares `INSendMessageIntent` support in the app and Share Extension. Successful Assistant composer sends and Share Extension submissions donate an outgoing conversation interaction with the Assistant's generated avatar; a suggested-recipient launch resolves the exact Assistant from `conversationIdentifier`. iOS owns suggestion eligibility and ranking, while disabled or removed Assistant catalog entries delete their donated conversation groups.
- The iOS Share Extension presents its native confirmation screen. Android shows a short native opening state and uses the existing Assistant Composer for preview, editing, attachment changes, and manual sending.
- Android uses a hybrid share path: native durable ingress stages the draft, generic shares wait on a full-screen in-app Assistant recipient page (never a bottom sheet), the WebView durably hands the assigned draft to the existing Assistant Composer, native draft cancellation follows that handoff, and the user edits attachments or text then sends through the standard Assistant Composer flow.
- Android Direct Share and Assistant launcher shortcuts keep their exact `serverInstanceID`, `connectionKey`, and `assistantID` target. The WebView switches to that saved instance, validates a fresh Assistant snapshot, opens the phone conversation page, and acknowledges or cancels native state only after the corresponding navigation or durable handoff succeeds. Generic Android shares never silently choose the configured default or first enabled Assistant.
- iOS resolves every shared image to `image/jpeg`, `image/png`, `image/gif`, `image/webp`, or `image/heic` from the copied file extension and matching file signature. Android preserves the content resolver's concrete image MIME, including `image/heic`. Shares with an unrecognized iOS image format return an attachment error and clean up copied temporary files.
- Native Assistant shortcuts and iOS share suggestions use the complete Assistant name and a locally generated Gaze PNG in `avatarPng`, including for names containing emoji. Android shortcuts, the iOS share extension and iOS donations decode this optional catalog field; old persisted catalogs retain their legacy avatar until refreshed. Native iOS composer similarly accepts optional Bottts Neutral `agentIcon` PNG data, using the Agent's badge color and a 22pt display size, while retaining its legacy identicon payload for older clients. Neither native surface fetches avatars from the network. These changes require a native rebuild.
- The share extension requires the newly registered `group.com.yee94.yuri` App Group entitlement for the app and `YuriShareExtension` target. The release signing profile must enable that App Group for `com.yee94.yuri.YuriShareExtension`; registration and ownership remain unverified.

## Native Android Background Notifications

The native stream carries the App locale in `Accept-Language` for direct and relay requests. The Host localizes built-in scenario titles per subscriber using the shared native-push title dictionary, including replay; session names, notification bodies, custom titles and Assistant names remain original content. Changing the App language reconfigures the subscription. This requires both updated UI assets and Host backend; no new Android shell API is needed.

- `YuriNotifications` and `YuriNotificationService` own an Android-only, notification-only foreground connection. The existing **Enable Notifications** setting starts/stops it; Android notification permission is requested on first enable. iOS continues to use APNs. Web, hosted mobile, VS Code and Electron do not start this service. Older Android shells without this plugin need an APK upgrade.
- After opening the app and connecting once, the service remains active independently of the WebView and task lifetimes. It receives the **currently selected server's** task completions, failures, questions, permission requests, Assistant messages, goals and scheduled-task results regardless of which device initiated them. It does not monitor all saved servers simultaneously. Switching server stops the old connection and clears its notifications; disabling notifications or revoking the active auth stops the service. Notification taps use the existing `yuri://session/...` / `assistant/...` navigation path.
- Direct transport uses the authenticated `GET /api/notifications/native-stream`. A saved paired relay is the fallback when LAN connectivity fails. Before resending credentials to a direct address with a pinned relay identity, native verifies `/health`'s `serverId`. Relay uses a separate native WebSocket, the existing v1 ECDH P-256 → HKDF-SHA-256 → AES-GCM protocol (batching off), and that same authenticated SSE request inside the encrypted tunnel. The relay infrastructure needs no change; the **Host server must be upgraded** to provide the new route. HTTP redirects are rejected. Credentials and relay grants remain in memory only.
- Only notification payloads cross this connection; no transcript stream, periodic task polling, WebView keepalive, wake lock, exact alarm, or FCM registration is used by the new Android shell. Idle SSE heartbeat is 60 seconds, read/idle expiry is 90 seconds. Failed connections back off from 2 seconds to 5 minutes plus up to 20% jitter; permanent errors use the long delay. Network restoration can interrupt the wait. Backoff resets only after at least 30 seconds of healthy streaming. An established relay fallback remains selected until UI reconfiguration rather than periodically probing LAN.
- The Host keeps at most 128 notifications for 15 minutes in process memory. Reconnect sends `Last-Event-ID`; the native cursor advances after processing. Expired/unknown cursors produce an explicit missed-notification warning. Host restart, process death and prolonged disconnection are not durable-delivery guarantees. Foreground banners are suppressed using native Activity lifecycle, not WebView focus. The quiet, low-importance connection notification shows connected/reconnecting/unavailable state; event alerts use a separate high-importance channel.
- Android 14+ declares `specialUse` with the user-enabled persistent remote-task notification use case, rather than misusing the time-limited `dataSync` type. Store distribution may require the corresponding foreground-service declaration/review. This feature requires no manufacturer push account or cloud push service. System/user process termination and power/network restrictions can still interrupt delivery. `START_NOT_STICKY` intentionally does not restore credentials from disk or restart after force-stop; open the app to reconnect.
- Validation: `test/native-notifications.test.mjs` compiles and executes the production Java SSE parser, reconnect policy and crypto against the production JS relay responder (JDK required). Server tests cover real auth, bounded replay, gaps, heartbeat and backpressure; UI tests cover runtime/auth fencing. Actual lock-screen delivery, notification taps, vendor power management and battery consumption still require Android device validation.

## Native iOS Live Activity

- `YuriLiveActivity` is an iOS-only Capacitor plugin. `canUseNativeIosLiveActivity` is Capacitor iOS + plugin registration only — not gated by `yuri.iosNativeUi`. Runtime support is **iOS 17.0+** (the `YuriWidget` deployment target) and `ActivityAuthorizationInfo.areActivitiesEnabled`. The App target stays at **15.5** and compiles behind `canImport(ActivityKit)` + `@available(iOS 17.0, *)`. `isSupported` / `start` / `update` / `end` all use that same floor; `update` and `end` below it reject as unsupported instead of succeeding silently.
- One Live Activity for all live working sessions, not just the currently selected top-level session. JS starts it after work stays busy for 5 seconds. The lock screen and expanded Dynamic Island show `{n} working` plus a row per session (title, checkmark or spinner, elapsed `{n}m`). Each row is a `Link` to that session. `Activity.request` uses `pushType: .token` so APNs can update that existing Live Activity (token available since iOS 16.1; this is not 17.2 push-to-start). The push token belongs to that Activity instance, not the app-wide device token; native code forwards `{activityId, sessionId, token}` on `pushToken`, including rotations.
- While the App is active, semantic updates apply immediately through the local ActivityKit bridge. When it is not, APNs remote updates the existing Live Activity, and the server compensates terminal complete/error states if the process never resumes.
- Timing is ActivityKit's: `staleDate` is `updatedAt + 20 minutes`. In-progress elapsed time uses the system auto-updating timer and freezes at `endedAt` on complete/error. `end` must pass final content; dismissal defaults to 15 minutes on success and 60 minutes on error (`dismissalSeconds` may override).
- App restart recovers `Activity.activities` for the same session. A millisecond `eventVersion` immediately replaces a recovered small counter from an older client.
- If the user dismisses the Live Activity, native code does not recreate it for that same task (process-scoped). JS `end` (task finished) clears suppression so a later busy period can start a new Activity.
- Native code never logs session IDs or tokens.

## Install (beta)

Shipping a beta: default to a `v*` tag so macOS and APK installers exist for first-time downloaders (`docs/RELEASING.md` § 先选产物). TestFlight follows the mobile plan mode, not the tag: betas with native-shell changes (`mode: native`) upload iOS to internal TestFlight; web-only (`mode: ota`) betas skip iOS. Stable always uploads iOS (external group). Use `mobile-beta/v*` only when the user wants mobile-web-only OTA and no installers.

- **iOS TestFlight:** a new, ownership-verified application record and invitation link are required before distribution.
  Stable uploads queue a `testflight-review-request` artifact. The independent `TestFlight External Review` workflow handles Apple processing, external-group association, and review submission after the publishing workflow finishes. Review failures remain visible there and do not block GitHub Release, Relay, or OTA. Retry that workflow with the existing marketing version and build number instead of uploading the IPA again; see `docs/RELEASING.md`.
  Native and OTA builds inject the verified EdgeOne/Vercel check endpoints into the UI. Native sync also sets `YURI_OTA_UPDATE_URL` to the mirror's `/v1/ota/check`; missing or inconsistent release endpoints fail preflight. A new installer is required when the native endpoint changes.
- **Android:** signed APK/AAB assets on [GitHub Releases](https://github.com/yee94/yuri/releases).
  Package id is `com.yee94.yuri`. Keep the previous application installed until local drafts and attachments are recovered; this application cannot read its sandbox.

## Commands

Run these from `packages/mobile`, or use the root `mobile:*` aliases.

- `bun run build`: builds `packages/web` and prepares mobile web assets.
- `bun run sync`: prepares assets and runs `cap sync`.
- `bun run add:ios`: creates the native iOS project.
- `bun run add:android`: creates the native Android project.
- `bun run build:android:debug`: builds a debug Android APK (`com.yee94.yuri.debug`) without launching an emulator. Safe to install beside a release build of `com.yee94.yuri`.
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
- If connecting to a remote Yuri server fails from the app while `/health` works in curl, check that the server build includes the packaged-client CORS allowlist for `capacitor://localhost` and local dev origins.
- If `serve-sim` preview says the stream is not producing frames, check the raw MJPEG stream before assuming the simulator stopped. In prior testing the raw stream worked while the browser preview UI stayed stale.

## Generated Assets

Launcher icons, splash screens, notification glyphs and Widget symbols derive from the final supplied Yuri B vector in `assets/yuri-mark-white.svg`. Run `bun run --cwd packages/mobile generate:icons` (Python + Pillow) to regenerate the platform assets from the checked-in approved SVG/PNG inputs. These final B assets supersede the earlier concept reference. The mark remains monochrome; the container is separate.

iOS uses the approved opaque 1024px icon card and an Icon Composer document at `ios/App/App/AppIcon.icon` with the same white mark. The system owns the outer mask.

Android adaptive icons use separate backgrounds and transparent foregrounds, with a 56dp mark inside the 66dp safe zone on a 108dp canvas. Android 13 monochrome icons and notification small icons use the same vector silhouette; legacy square/round mipmaps use the full approved card. Splash assets are generated at their existing platform sizes.
