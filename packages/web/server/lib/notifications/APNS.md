# APNs remote push — signed relay mode

Native iOS background push (notifications even when the app is **suspended or killed**) is
delivered via APNs through a **central relay**, so no user configures an Apple key. Each server
signs its relay requests with an auto-generated keypair, and tokens are bound to the server that
registered them — so a leaked device token alone can't be used to push.

## How it works

1. The app registers its APNs device token with **its own server** (`POST /api/push/apns-token`,
   `useNativePushRegistration`). PWA/desktop never register — only the native Capacitor app.
2. The server **binds the token on the relay**: it POSTs `{ token, publicKeyJwk, ts, sig }` to
   `POST /v1/push/register-token`, signed with its auto-generated ECDSA P-256 key
   (`getOrCreateRelayKeypair`, persisted in settings like the VAPID keys). The relay records
   `token → serverId` where `serverId = SHA-256(publicKey)`.
 3. On a trigger (ready/error/question/permission/goal_*), the server composes **generic,
    content-free** text — a **locale-specific** scenario title (from `apns-titles.js`, keyed off
    the locale stored with each device token at `POST /api/push/apns-token`) + the **session name**
    as the body, no model/project/message content — plus a **`badge`** count (see below). Tokens
    are grouped by locale (relay signatures cover `title`, so mixed locales cannot share one
    batch) and each group POSTs `{ tokens, title, body, badge, env, data:{sessionId},
    publicKeyJwk, ts, sig }` to `POST /v1/push/send` (`apns-runtime.js` → `sendViaRelay`). It does
    **not** gate on UI visibility (see below). Legacy tokens without a locale fall back to English.
4. The **Push Relay** (`packages/relay-server/src/push/`, process `openchamber-push-relay`)
   verifies the signature + `ts` freshness, derives `serverId`, and only delivers to tokens bound
   to that server. It holds the project APNs `.p8` key, signs an ES256 JWT with Node crypto, and
   sends each token to APNs over HTTP/2, returning per-token results; the server drops tokens
   flagged `drop` (410 / BadDeviceToken). The Push database stores `token → serverId` bindings,
   not application plaintext. Layer 1 (`openchamber-relay`) never sees these secrets.
5. Tapping a push deep-links to its session via the forwarded `sessionId`.

## Live Activity (update / end)

ActivityKit has issued **update/end push tokens** for an Activity that is
**already started on-device** since **iOS 16.1**. **Push-to-start** (creating an
Activity from APNs while the app is not running) is **iOS 17.2+** and is not
part of this Host path.

The native app registers a Live Activity token with **its own server**
(`POST /api/push/live-activity-token`: `token`, `activityId`, `sessionId`).
Those tokens are stored separately from alert APNs device tokens (same
`apns-tokens.json` file, `version` 2 `liveActivityTokensBySession`; v1 alert
data remains readable) and are never used for banner push. The Host binds them
on the relay at `POST /v1/push/register-live-activity-token` with
`{ token, platform: "ios", kind: "liveactivity", publicKeyJwk, ts, sig }` signed
over `${ts}.${token}.${platform}.${kind}`. Unregister uses
`/v1/push/unregister-live-activity-token` with the same signature, and only the
owning UI session may delete a local token.

On top-level session **completion** or **error** (child sessions and small-model
system sessions suppressed; independent of ordinary notification settings and UI
visibility) the Host calls `sendLiveActivityEnd`. Relay send is
`POST /v1/push/live-activity` with `{ tokens, event, contentState,
dismissalDate?, staleDate?, publicKeyJwk, ts, sig }` signed over
`${ts}.${sortedTokens}.${event}.${status}.${eventVersion}.${updatedAt}.${endedAt}.${dismissalDate}.${staleDate}`.
Direct mode uses HTTP/2 token auth, `apns-topic: ${bundleId}.push-type.liveactivity`,
`apns-push-type: liveactivity`, and no alert.

The APNs / relay payload **must not** carry `sessionId` or user/session content.
`contentState` is only `{ status, eventVersion, updatedAt, endedAt }`.
`complete` uses a 15-minute dismissal and `error` a 60-minute dismissal (same as
native). `staleDate = updatedAt + 20min` is for **update** events only. After a
successfully accepted `end`, the Host clears the local Activity tokens for those
devices. A Live Activity failure does not drop alert tokens or block ordinary
push. Do not log Live Activity tokens or session ids.

## Foreground suppression

APNs is **not** gated on UI visibility. A backgrounded WKWebView can't reliably report "hidden"
before iOS suspends it, so a server-side visibility gate dropped background push for short
responses. Instead the server always sends, and **iOS** suppresses the foreground banner
(`PushNotifications.presentationOptions: []` in `capacitor.config`) — so there is no notification
while the app is active, with no race. APNs is the native app's **only** channel; local
notifications were removed (a WKWebView can't tell foreground from background — `document.hasFocus()`
is unreliable — so they leaked while the app was open). The Push Relay is contacted only when a
native app with notifications on has a registered token and a trigger fires.

## App-icon badge

Each push carries an **absolute** `aps.badge` = the number of **distinct collapse-ids (`tag`)
pushed since the app was last foregrounded**. It mirrors the lock-screen banner stack.

The count is a `Set<tag>` (`pendingPushTags`) in the trigger runtime (`runtime.js`):
`toApnsGenericPayload` adds the push `tag` and returns the set size as the badge. We key by **`tag`,
not sessionId**, because the tag *is* the banner identity — iOS uses it as `apns-collapse-id`, so
same-tag pushes replace one banner while different tags are distinct banners. One session can raise
several banners (`ready-<id>`, `question-<id>`, `permission-<requestKey>` are different tags), so
counting sessionIds both over- and under-counts the stack; counting tags matches it.

It is deliberately **not** derived from the live attention snapshot (`needsAttention`/`isViewed`):
that machinery drives in-app indicators on *connected* clients, where a backgrounded client stays
"viewing" and `needsAttention` is set by a separate `session.status` event that races the push
trigger. The set self-clears via `clearPendingPushBadge` on any signal that the user is engaging
with the app: the visibility beacon (`updateUiVisibility` wrapper, `visible:true`), **plus** opening
a session (`POST /api/sessions/:id/view`) and sending a message (`POST /api/sessions/:id/
message-sent`). The latter two need no auth and fire reliably on the native app when it foregrounds,
so they are the dependable reset — the visibility beacon alone proved unreliable in WKWebView. This
mirrors the device zeroing its icon badge on `sceneDidBecomeActive` (`AppDelegate.swift`), keeping
server and device in sync.

The value flows `runtime.js` (`toApnsGenericPayload`) → `apns-runtime.js` (`sendViaRelay` body /
direct-mode `aps.badge`) → Push Relay (`packages/relay-server/src/push/schema.js` → `aps.badge`).
It is **not** signed (like `body`/`data`); the relay still only delivers to bound tokens. The set
is server-global, so every device token of a server sees the same badge.

## Modes

- **Relay (default):** Host has no Apple key. Unless `OPENCHAMBER_PUSH_RELAY_URL` is set, the
  Host maps the effective Relay `wss://`/`ws://` URL to the same host as `https://`/`http://`
  `/v1/push/send` (register URL is `/v1/push/register-token`). A Relay switch re-registers
  persisted tokens and binds them again before the first send.
- **Direct (fallback):** set `OPENCHAMBER_PUSH_RELAY_DISABLED=true` + `OPENCHAMBER_APNS_KEY_ID/
  TEAM_ID/P8` to sign+send from the server itself (HTTP/2 + ES256 JWT); no relay binding needed.

## Config

Host (`apns-runtime.js`):
- `OPENCHAMBER_PUSH_RELAY_URL` (explicit send-URL override), `OPENCHAMBER_APNS_ENVIRONMENT`
  (`sandbox` default / `production` for TestFlight and App Store). The signing keypair is
  auto-generated — nothing to set.
- Direct fallback: `OPENCHAMBER_APNS_KEY_ID`, `OPENCHAMBER_APNS_TEAM_ID`, `OPENCHAMBER_APNS_P8`
  (or `_P8_PATH`), `OPENCHAMBER_APNS_BUNDLE_ID`, `OPENCHAMBER_PUSH_RELAY_DISABLED=true`.

Push process (`packages/relay-server/src/push/`, env prefix `OPENCHAMBER_PUSH_RELAY_`):
`HOST` (default `127.0.0.1`), `PORT` (default `8788`), `TRUST_PROXY`, `DATABASE_PATH`,
timestamp/replay/rate-limit/token/`MAX_IN_FLIGHT` limits, plus APNs `APNS_KEY_ID`,
`APNS_TEAM_ID`, `APNS_BUNDLE_ID`, and `APNS_P8` or `APNS_P8_PATH`. See
`packages/relay-server/README.md`. SQLite is single-instance. Do not log `.p8` material,
device tokens, or signatures.

## Apple setup (one-time)

1. Apple **Keys** (not Certificates) → create an **APNs Auth Key** (`.p8`) → Key ID + Team ID;
   enable **Push Notifications** on the App ID. TestFlight / App Store builds of this product
   use bundle ID `com.yee94.openchamber`.
2. Give those values only to the Push process (environment or Docker secret). Do not put the
   `.p8` on Layer 1 or on each OpenChamber Host when using Relay mode.
3. Xcode: confirm the Push Notifications capability; Clean Build Folder; run on device.
   Development builds use APNs `sandbox`. TestFlight and App Store Hosts set
   `OPENCHAMBER_APNS_ENVIRONMENT=production`.

## Security posture

- The device token is a per-install secret, but no longer the *only* defence: every relay request
  is signed by the server's private key, and the relay only delivers to a token from its bound
  `serverId`. A leaked token alone is useless — an attacker has neither the private key nor a
  matching binding.
- `serverId` self-certifies (`SHA-256(publicKey)`). A SQLite leak exposes `token → serverId`
  bindings, not Host private keys or application plaintext. The signed `ts` (±5 min window)
  blocks replay. Signature verification lives in `packages/relay-server/src/push/crypto.js`
  and must stay aligned with `packages/web/server/lib/relay/signing-key.js`.
- Residual: trust-on-first-bind (whoever registers a token first owns it) — acceptable, since
  registering already requires possessing the token. Process rate limits are defence-in-depth.

## Data confidentiality (what the relay / Apple can see)

The push payload is **not** application-encrypted, so there is no decryption step. The text is
sent in plaintext, protected only by **TLS in transit** (HTTPS to the relay, TLS from the relay
to APNs). The request **signature is authentication, not encryption** — the relay *verifies* it
(valid / invalid), it does not hide anything.

Who can read the alert text:

- **Network hops:** nothing (TLS).
- **The Push Relay process:** the generic title + body (session name), the device token, and
  `sessionId`. It stores `token → serverId` bindings (no alert text, no payload).
- **Apple APNs:** the alert text too — APNs always reads the alert payload of an `alert` push.
- **The device:** displays it.

This is acceptable **because the text is deliberately content-free**: a fixed scenario title
(localized per device) + the session name only — no model, project, or message content
(`runtime.js` → `toApnsGenericPayload` → `localizeApnsPayload`). The session name is the single
semi-personal field that crosses the relay/Apple. To hide even that from Apple would require an
end-to-end **encrypted payload** (`mutable-content` + a Notification Service Extension that
decrypts on-device with a key never sent to the relay) — not implemented, and unnecessary for
generic text.

## Android (FCM) note

The Android equivalent is **FCM** (not implemented): the same relay would forward to FCM with a
server key, and the client would register an FCM token (same store/routes + signing).
