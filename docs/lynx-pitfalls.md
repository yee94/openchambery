# Lynx mobile rewrite — pitfalls

Independent track: **`work/lynx-native`**. These are hard gates, not style notes. A feature that “works in the simulator” but violates one of these is not done.

Sources: Capacitor/shared-UI code on `main`, `packages/mobile/README.md` / `HANDOFF.md`, pairing/voice/release docs, the Flutter sibling track’s failures (`work/flutter-native`, `cursor/remove-flutter-voice-*`), and official Lynx 3.8 element docs.

---

## 1. 附近 ≠ Bonjour

**Nearby / 附近 / 家庭网络 is not Bonjour, mDNS, or a device browser.**

This repo has **no** `NSBonjourServices`, no mDNS browse, and no Nearby UI.

What “local / home network” actually means:

- Pairing v2 issues an ordered set of **transport candidates**: a direct HTTP URL first, Private Relay fallback (`packages/ui/src/apps/mobileConnections.ts`).
- Product copy: the app shows whether a saved server is reachable via **本地网络** or **中继** (`packages/docs/content/docs/zh-cn/mobile.mdx`).
- Settings remote-instance transport `lan` is labeled **仅家庭网络** — Wi-Fi **direct connect to a URL the user already has**, not discovery (`zh-CN.settings.ts`).
- iOS `NSLocalNetworkUsageDescription` is “connects to OpenChamber servers on your local network” — connect, not browse (`packages/mobile/ios/App/App/Info.plist`).
- Pairing v2 backend plan **explicitly excluded LAN discovery** (`docs/pairing-v2-implementation-plan.md`).

Do not add:

- Bonjour / `_http._tcp` browse as “附近的服务器”
- UDP beacon / LAN scan
- A Nearby tab, map, or AirDrop-like picker

If a user wants another server, they scan a QR, paste a pairing link, or type a URL. That is the entire discovery story.

---

## 2. 禁语音脑补

**Do not invent voice / ASR features.**

Cap/web already has a bounded voice surface. Inventing a second one is how the Flutter track grew a fake STT/TTS stack that later had to be ripped out (`cursor/remove-flutter-voice-*` on this remote).

What exists (`packages/docs/content/docs/voice.mdx`, Settings slug `voice`):

- Composer dictation through **WebView `getUserMedia`** + `/api/dictation/ws` (`useDictation.ts`)
- STT backends already named: browser / server OpenAI-compatible / on-device **in the web runtime**
- TTS: browser / OpenAI / OpenAI-compatible / macOS `say`
- Phone note: mobile-browser built-in voices are weak; OpenAI-compatible TTS is the reliable path
- Mic permission strings exist for that WebView dictation only

What does **not** exist:

- A Capacitor native ASR plugin
- Siri / `SFSpeechRecognizer` / Android SpeechRecognizer as the product
- Always-on listen, wake word, call-style voice mode
- A Lynx-only voice brand

Lynx rules:

1. Port Settings `voice` and the existing HTTP/WS dictation/TTS routes, or omit the page until those routes are wired.
2. If omitted, **delete the row** (Flutter did this). Do not ship a dead “Voice” page with pretend meters.
3. Never add a native recognizer “to make mobile better” without a Cap/web counterpart already in tree.

---

## 3. 禁 WebView 键盘 hack

**Do not port Capacitor WebView keyboard FLIP / IME hacks into Lynx.**

Capacitor’s keyboard path exists because **WKWebView / Android WebView lie about the visual viewport**. That is a WebView problem. Lynx is not a WebView.

Capacitor’s owned path (do not copy blindly):

- Keyboard `resize: 'none'`; Android `adjustNothing` + cached-height composer CSS FLIP + `ImeSyncBridge` (`packages/mobile/HANDOFF.md`)
- `packages/ui/src/apps/androidKeyboardTransition.ts` + tests
- iOS native composer pins to keyboard overlap, then rest on the home-indicator inset (`packages/mobile/README.md` § Native iOS Composer)

Lynx must use:

- Native Lynx / host IME insets (`keyboard` status, safe-area, `onKeyboardStatusChanged` or the host `resizeToAvoidBottomInset` analogue)
- A real native text control (Lynx `<x-textarea>` / host `UITextView` / Android `EditText`) that owns composition

Forbidden:

- CSS FLIP from a guessed `39dvh` keyboard
- Writing `--oc-kb-layout` / `oc-keyboard-open` shims “like Capacitor”
- `window.visualViewport` polling inside Lynx
- Padding the Lynx page to fake a WebView resize
- Rebuilding the Flutter “manual keyboard pad” that the Flutter track already rejected in favor of `Scaffold.resizeToAvoidBottomInset`

Chinese IME marked text is a first-class constraint: do not rewrite the field during composition. Cap iOS already learned this the hard way (`native-ios-composer.ts`).

---

## 4. 三关验收: 代码接上 / CI绿 / 真机过

A Lynx change is **not done** until all three pass. Only **真机过** counts as shipped.

| Gate | Meaning | Not sufficient |
|---|---|---|
| **代码接上** | The feature is wired to the real OpenChamber / OpenCode API, with the same identity/auth/directory rules as Cap/web | Demo rows, fixtures, “looks like the screenshot” |
| **CI绿** | Track CI is green for the platforms the change claims (analyze/typecheck + Android debug APK + iOS simulator as applicable) | Local `tsc` only; Linux-only analyze; a red iOS job ignored |
| **真机过** | Exercised on a physical iPhone and/or Android with a real server (LAN and, if claimed, relay) | Simulator, emulator, WidgetTester PNG, CDP screenshot |

Repo precedents (compose, do not weaken):

- Performance gates in `docs/performance/session-switch-2026-07-11.md` are measured, not vibes
- OTA “发布了 = 客户端检测得到” (`docs/RELEASING.md` detectability probe)
- Mobile validation commands in `packages/mobile/HANDOFF.md` still do not replace a device
- Transcript reconnect ticket explicitly left Capacitor suspend as **unproven** (`.scratch/session-transcript-query/issues/10-runtime-reconnect-performance-validation.md`)

Agent / cloud VM rules:

- This environment often **cannot** run Xcode or a physical device. Say so. Do not mark 真机过.
- Do not dump “please try this on your phone” as the acceptance plan. Own a harness (`docs/lynx-acceptance.md`).

---

## 5. prerelease 直链

**Prerelease builds may be downloaded by a direct GitHub Release URL. They must never enter the stable auto-update feed.**

Hard rules (`docs/RELEASING.md`, `.opencode/commands/release.md`):

- Semver with `-` (`X.Y.Z-beta.N`) publishes as a **GitHub prerelease**
- Never `gh release edit … --latest` on a beta
- Never write a beta into `release-manifest.json` or Vercel `latest*.yml`
- GitHub `/releases/latest` and the desktop feed key off the **prerelease bit**, not the word “beta”
- Users **may** install a beta from the Release page. That is the 直链. Isolation applies to **auto-update**, not manual download

Mobile install links that exist today:

- iOS TestFlight public: `https://testflight.apple.com/join/ZCENBHtm` (`packages/mobile/README.md`)
- Android APK: GitHub Releases (stable latest vs a specific prerelease asset)

Lynx must not:

- Point a “Check for updates” button at `/releases/latest` for a beta build
- Reuse the Capacitor Capgo **stable** channel for a Lynx prerelease binary
- Invent a second public TestFlight link

Pairing 直链: `openchamber://connect?v=2&p=…` is the only connect deep link. Legacy v1 token URLs stay rejected.

---

## 6. FCM 与包名

Android push is FCM. The token is useless if the binary’s `applicationId` is not in `google-services.json`.

Facts (`packages/mobile/HANDOFF.md`, `useNativePushRegistration.ts`):

| Install id | Role |
|---|---|
| `com.yee94.openchamber` | Cap / Flutter / Expo release / Play / CI APK |
| `com.yee94.openchamber.debug` | Cap / Flutter / Expo local/sideload debug — sits beside release |
| `com.yee94.openchamber.lynx` | Lynx host base id (not shipped without suffix today) |
| `com.yee94.openchamber.lynx.debug` | **Lynx sideload APK** — intentional unique id for side-by-side install beside Cap/Flutter/Expo |
| `com.openchamber.app` | **Java/R namespace only** (Cap) — old upstream id. Same icon ≠ same app |

`google-services.json` lists Cap/Flutter/Expo `com.yee94.openchamber` and `.debug` only. The Lynx sideload APK intentionally uses `com.yee94.openchamber.lynx(.debug)` so it installs beside Cap/Flutter/Expo without package conflict. **FCM will NOT work on Lynx until a matching Firebase Android app is added** to `google-services.json`. Cap/Flutter/Expo keep sharing `com.yee94.openchamber(.debug)`.

Lynx deep-link scheme is `openchamber-lynx://` (not `openchamber://`) so it does not fight Cap.

Other package-name landmines:

- Older builds used `com.openchamber.app`. Users must uninstall that copy; Android will not overwrite across id/signing changes (`packages/mobile/README.md`)
- Missing `google-services.json` used to crash `register()` (“Default FirebaseApp is not initialized”)
- iOS is APNs, not FCM. Tag the token with platform so the server relay routes correctly
- Debug vs release signing keys are different; do not tell users to “just install over”

---

## 7. 误用跨层 API

Shared UI and any Lynx client that talks to OpenChamber must keep the same boundaries (`.agents/skills/ui-api-decoupling/SKILL.md`):

| Need | Correct path |
|---|---|
| Official OpenCode API | `@opencode-ai/sdk/v2` / `opencodeClient` — do not hand-roll the REST shape |
| OpenChamber HTTP | `runtimeFetch('/api/...')` or the Lynx equivalent that still hits the **real** route |
| Runtime-owned capability | `RuntimeAPIs` with an explicit Lynx implementation |
| Browser-authenticated asset | runtime URL resolver — never put long-lived tokens in URLs |
| SSE / WS | owning realtime transport, not a random `WebSocket` to localhost |

Concrete Cap failures Lynx must not repeat:

- HTML preview via iframe `src` on a relay (must `runtimeFetch` the FS serve route — `MobileFilesSurface.test.ts`)
- Treating fetch failure as authoritative empty (erases other entities)
- Caching runtime base URL / client token across instance switch
- Calling Electron or Capacitor globals from a “shared” module
- Inventing a redeem HTTP API that pairing v2 does not have (Flutter second-slice note: parse v2 `p=` and redeem on a **reachable transport**, do not invent `/api/nearby/redeem`)

Lynx embedding does not grant permission to bypass auth. Privileges stay at the native/runtime boundary.

---

## 8. 不要发明 Flexoki / Finder / Capgo 等不存在于本仓的东西

The rule is: **do not invent brands, subsystems, or product names that are not in Cap/web.** Some of these names **do** exist — use them only as they exist.

| Name | Exists? | Allowed use | Forbidden invention |
|---|---|---|---|
| **Flexoki** | Yes — default themes | Theme ids `flexoki-light` / `flexoki-dark` | A “Flexoki app”, extra palettes, a theme store |
| **Capgo** | Yes — Capacitor OTA | Self-hosted `@capgo/capacitor-updater` for **web-bundle** updates | Capgo-as-Lynx-app-store, invented channels, uploading a Lynx IPA to Capgo as if it were `mobile.html` |
| **Finder** | Desktop reveal only | N/A on Lynx | A macOS-style Finder browser, “Files.app clone”, desktop `openInApps` on Android |
| Expo | No (this track) | — | Expo Router, EAS, Expo Go |
| Flutter | Sibling track only | Cite as a cautionary tale | Merging `apps/mobile_flutter` into Lynx |
| Nearby / AirDrop / Bonjour | No | — | See §1 |

If a name is not in `packages/ui` or `packages/mobile` on `main`, it is not a Lynx feature.

Also do not rebuild things Cap **removed**:

- Project notes / Todo panel / “加入笔记” (CHANGELOG 1.19.2)
- Plan-mode as a root tab (plan is a **session tool** under `/session/$id/plan`)
- Appearance `openchamber.iosNativeUi` as a Lynx user-facing toggle if Lynx **is** the native shell (that flag exists to swap WebView chrome). Native-always-on is the Flutter track’s choice; Lynx should decide embedding in `docs/lynx-ia-ui.md`, not hide a second WebView.

---

## 9. 1.19 LegendList — do not bring back 1.18 TanStack Virtual

This is a **Lynx-track hard constraint**, even though current Cap `main` defaulted the WebView list back to TanStack.

1.19 LegendList contract (`TimelineList.tsx`):

- One list, history + live tail
- `initialScrollAtEnd` / `maintainScrollAtEnd` / `maintainVisibleContentPosition`
- No row recycling
- Mobile load-older is a button

1.18 TanStack path (`MessageList.tsx`) that Lynx must not reintroduce:

- Split `StaticHistoryList` + `StreamingTailContent` (tail remount blink)
- `anchorTo: 'end'` + `followOnAppend` + `scrollEndThreshold`
- Auto-follow pin + force-bottom watchdog + entry-stick quiet window
- Manual `scrollTop` writers racing measure

Evidence the default flip is Cap-only A/B, not a product revert of the 1.19 semantics:

- `useFeatureFlagsStore.ts` — TanStack default, LegendList via `oc:legend-timeline=1`
- CHANGELOG 1.19.0-beta.1 enabled LegendList; 1.19.5-beta.7 set Cap default back to TanStack
- Flutter track already forbids the 1.18 TanStack line (`docs/flutter-native-gap.md` on `work/flutter-native`)

Lynx implements the **LegendList semantics**, using Lynx `<list>` / a Lynx LegendList binding / a custom virtualizer that preserves those four bullets — not `@tanstack/react-virtual`.

---

## 10. Other pitfalls found in repo history

### Keyboard and composer

- Do not mark a send as an “echo” that blocks the next `forceText` clear (iOS composer).
- Occupancy is the **collapsed** composer height. Expanding / keyboard / scroll-to-bottom must not shove Changes / queue.
- Do not animate footer chrome with the keyboard pin (labels slide).

### Navigation

- Native code never owns the React / Lynx page stack. Gestures emit progress; JS/Lynx commits the route (`OpenChamberNavigation`).
- Sheets are not push pages. Vertical dismiss ≠ edge back.
- Hosted H5 must not grow a fake iOS edge-swipe.

### Sync and lists

- Never convert a failed fetch into an empty success (correctness invariant in `AGENTS.md`).
- One failed settings entity must not blank the rest (`usage` quota rows).
- Session index is SQLite-backed; sidebar / Projects home stay index-driven.

### Share

- Generic Android shares never silently pick the default Assistant.
- Native share catalog stores routing metadata only — never server tokens.

### Push / Live Activity

- One Live Activity for **all** busy sessions, not only the open one.
- If the user dismisses it, do not recreate that task (process-scoped).
- Never log session IDs or push tokens.

### Release / OTA

- Capgo detectability must pass on **both** Vercel and EdgeOne for Capacitor OTA. Lynx binaries are a different artifact — do not pretend an IPA is an OTA bundle.
- `mobile-beta/v*` is web-only OTA with **no** installers. Do not use it for a Lynx first-time install.

### Cross-track

- Do not modify `../opencode`.
- Do not merge `work/lynx-native` into `main`.
- Do not “share a rewrite” with Flutter by copying Dart into Lynx.

---

## Quick checklist (paste into PR bodies)

- [ ] No Bonjour / Nearby browse
- [ ] No invented ASR / voice product
- [ ] No WebView keyboard FLIP
- [ ] 代码接上 + CI绿 + **真机过** (or explicitly not-done)
- [ ] Prerelease is not `/releases/latest`
- [ ] FCM `applicationId` ∈ `google-services.json`
- [ ] Official OpenCode APIs via SDK; OpenChamber via real routes
- [ ] No invented Flexoki/Finder/Capgo/Expo product
- [ ] LegendList 1.19 list semantics; no TanStack Virtual 1.18 split
