# Notifications Module Documentation

## Purpose
This module provides notification message preparation utilities for the web server runtime, including text truncation and plain-text normalization for system notifications.

## Entrypoints and structure
- `packages/web/server/lib/notifications/index.js`: public entrypoint imported by `packages/web/server/index.js`.
- `packages/web/server/lib/notifications/routes.js`: route registration for push, visibility, and session status/attention endpoints.
- `packages/web/server/lib/notifications/push-runtime.js`: push subscription persistence, VAPID initialization, and UI visibility runtime.
- `packages/web/server/lib/notifications/apns-runtime.js`: native iOS APNs device-token persistence + delivery, plus a separate Live Activity token store and `end` send path. Two modes: **relay** (default — sign + POST tokens + generic text to the isolated Push Relay in `packages/relay-server/src/push/`, which holds the project APNs key) and **direct** (fallback — sign ES256 JWT with Node crypto + HTTP/2, when `OPENCHAMBER_PUSH_RELAY_DISABLED=true`). Unless `OPENCHAMBER_PUSH_RELAY_URL` is set, the Host maps the effective Relay `wss`/`ws` URL to the same host as `https`/`http` `/v1/push/send`. Before each relay send, the runtime checks an in-memory registration success cache (keyed by current register URL + token + platform) and only POSTs `/v1/push/register-token` for cache misses; only successfully bound tokens are sent. Switching Relay/Push URL clears that cache so persisted tokens re-bind to the new origin on the next send or `reRegisterAllTokens()`. Each server has an auto-generated ECDSA P-256 keypair (`getOrCreateRelayKeypair`, persisted in settings); it binds tokens on the relay (`/v1/push/register-token`) and signs every relay request, so the relay only delivers to tokens bound to that server. APNs is the native app's sole notification channel (no local notifications) and is NOT gated on UI visibility — iOS suppresses the foreground banner instead. Mobile push carries only generic text (scenario title + session name) — see `APNS.md`. Live Activity tokens are persisted beside alert tokens in the same file (`version` 2, `liveActivityTokensBySession`) without mixing the two token types; v1 files remain readable. Live Activity relay bind/send uses `/v1/push/register-live-activity-token`, `/v1/push/unregister-live-activity-token`, and `/v1/push/live-activity`.
- `packages/web/server/lib/notifications/emitter-runtime.js`: desktop/stdout + UI SSE notification emission runtime.
- `packages/web/server/lib/notifications/runtime.js`: trigger runtime for OpenCode event-driven notification fanout.
- `packages/web/server/lib/notifications/template-runtime.js`: notification template variables and session text/title enrichment runtime. Zen-model helpers are retained as compatibility stubs only.
- `packages/web/server/lib/notifications/message.js`: helper implementation module.
- `packages/web/server/lib/notifications/message.test.js`: unit tests for notification message helpers.

## Public exports

### Notifications API (re-exported from message.js)
- `truncateNotificationText(text, maxLength)`: Truncates text to specified max length, appending `...` if truncated.
- `prepareNotificationLastMessage({ message, settings })`: Prepares the last message for notification display by normalizing and truncating text.

### Route registration API (routes.js)
- `registerNotificationRoutes(app, dependencies)`: Registers notification-owned endpoints:
  - `GET /api/push/vapid-public-key`
  - `POST /api/push/subscribe`
  - `DELETE /api/push/subscribe`
  - `POST /api/push/apns-token` (native iOS APNs device-token registration)
  - `DELETE /api/push/apns-token`
  - `POST /api/push/live-activity-token` (native iOS Live Activity token registration; UI-auth, length-limited `token` / `activityId` / `sessionId`)
  - `DELETE /api/push/live-activity-token` (owning UI session only)
  - `POST /api/push/visibility`
  - `GET /api/push/visibility`
  - `GET /api/notifications/stream`
  - `GET /api/session-activity`
  - `GET /api/sessions/snapshot`
  - `GET /api/sessions/status`
  - `GET /api/sessions/:id/status`
  - `GET /api/sessions/attention`
  - `GET /api/sessions/:id/attention`
  - `POST /api/sessions/:id/view`
  - `POST /api/sessions/:id/unview`
  - `POST /api/sessions/:id/message-sent`

### Trigger runtime API (runtime.js)
- `createNotificationTriggerRuntime(dependencies)`: creates runtime-owned debounced trigger handling for OpenCode events.
- Returned API:
  - `maybeSendPushForTrigger(payload)`
- Owns:
  - top-level completion/question/permission trigger routing; completion is the sole task-status notification and child sessions plus small-model system sessions (`metadata.openchamber.smallModel.purpose`) are suppressed
  - top-level completion/error Live Activity `end` (`sendLiveActivityEnd`), independent of ordinary push settings and UI visibility, with the same child/small-model suppression; duplicate terminal events are idempotent at the token store
  - session meta cache for child-session and small-model suppression
  - template resolution and fallback behavior
  - native notification fanout and web push payload fanout
  - push always fans out to every subscribed surface; another client's visibility never suppresses delivery

### Push runtime API (push-runtime.js)
- `createPushRuntime(dependencies)`: creates runtime for web push and UI visibility state.
- Returned API:
  - `getOrCreateVapidKeys()`
  - `ensurePushInitialized()`
  - `setPushInitialized(value)`
  - `addOrUpdatePushSubscription(uiSessionToken, subscription, userAgent)`
  - `removePushSubscription(uiSessionToken, endpoint)`
  - `sendPushToAllUiSessions(payload)`
  - `updateUiVisibility(token, visible)`
  - `isAnyUiVisible()`
  - `isUiVisible(token)`

### APNs runtime API (apns-runtime.js)
- `createApnsRuntime(dependencies)`: creates runtime for native iOS APNs push and device-token state. Dependencies: `fsPromises`, `path`, `crypto`, `http2`, `APNS_TOKENS_FILE_PATH`, `readSettingsFromDiskMigrated`, `writeSettingsToDisk` (persists the auto-generated relay signing keypair).
- Returned API:
  - `addOrUpdateApnsToken(uiSessionToken, deviceToken, userAgent, platform?, locale?)` — also binds a newly-seen token on the relay (signed `/v1/push/register-token`). Persists app UI `locale` for localized push titles.
  - `removeApnsToken(uiSessionToken, deviceToken)`
  - `removeApnsTokenFromAllSessions(deviceToken)`
  - `addOrUpdateLiveActivityToken(uiSessionToken, token, activityId, sessionId)` — idempotent upsert bound to the UI session + OpenCode `sessionId` + ActivityKit `activityId`. Token refresh replaces that activity's previous token. Caps per UI session and lazily expires stale entries. Binds on the relay (`/v1/push/register-live-activity-token`, `kind: "liveactivity"`). Does not log tokens or session ids.
  - `removeLiveActivityToken(uiSessionToken, token)` — owning UI session only; unregisters from the relay when no local copies remain.
  - `sendLiveActivityEnd({ sessionId, status, eventVersion?, endedAt? })` — looks up Live Activity tokens for that OpenCode session and sends `event: "end"` with `contentState` `{ status, eventVersion, updatedAt, endedAt }` only. `complete` dismisses after 15 minutes, `error` after 60 minutes (same as native). `staleDate` (`updatedAt + 20min`) is update-only and omitted on end. `eventVersion` is monotonic per session using current milliseconds. Relay body follows the signed live-activity contract; direct mode uses token auth, topic `${bundleId}.push-type.liveactivity`, `apns-push-type: liveactivity`, and no alert. APNs payloads must not carry `sessionId` or user content. Successfully accepted tokens are cleared locally; failures do not drop alert tokens or block ordinary push.
  - `sendApnsToAllUiSessions(payload)` — localizes scenario titles per stored token locale (`apns-titles.js`), groups tokens by locale, then signs + sends (no UI-visibility gate; iOS suppresses the foreground banner). Before a relay send, each token is checked against the in-memory registration success cache for the current register URL; cache hits skip `/v1/push/register-token`, misses are registered with bounded concurrency, and only successfully bound tokens are sent. Switching Relay/Push URL clears that cache so the next send re-binds persisted tokens to the new origin. No-ops with a single warning when APNs is unconfigured. Drops tokens on `410` / `BadDeviceToken` / `Unregistered`. Never sends Live Activity tokens.
  - `reRegisterAllTokens()` — binds every persisted device token to the current Push origin (same success cache and URL-switch invalidation as send).
  - `resolveApnsConfig()`
- Configuration (env first, then `settings.apnsConfig`): `OPENCHAMBER_PUSH_RELAY_URL` (optional send-URL override), `OPENCHAMBER_PUSH_RELAY_DISABLED`, `OPENCHAMBER_APNS_KEY_ID`, `OPENCHAMBER_APNS_TEAM_ID`, `OPENCHAMBER_APNS_P8` (PEM contents; literal `\n` accepted) or `OPENCHAMBER_APNS_P8_PATH`, `OPENCHAMBER_APNS_BUNDLE_ID` (default `com.yee94.openchamber`), `OPENCHAMBER_APNS_ENVIRONMENT` (`sandbox` default, or `production` for TestFlight and App Store).

### Emitter runtime API (emitter-runtime.js)
- `createNotificationEmitterRuntime(dependencies)`: creates runtime for unified notification emission channels.
- Returned API:
  - `writeSseEvent(res, payload)` — best-effort SSE write with backpressure: when `res.write` returns `false`, the client is marked paused and further writes are skipped until `drain`; buffered bytes above `SSE_CLIENT_MAX_BUFFERED_BYTES` (2 MiB, aligned with relay-server) destroy the response. Authoritative data remains HTTP pull.
  - `emitDesktopNotification(payload)`
  - `broadcastUiNotification(payload)`
- Exported constant: `SSE_CLIENT_MAX_BUFFERED_BYTES`

### Template runtime API (template-runtime.js)
- `createNotificationTemplateRuntime(dependencies)`: creates shared notification/template runtime. Model-backed summarization was retired after the Zen provider became unavailable.
- Returned API:
  - `resolveNotificationTemplate(template, variables)`
  - `shouldApplyResolvedTemplateMessage(template, resolved, variables)`
  - `fetchFreeZenModels()` compatibility stub returning `[]`
  - `resolveZenModel(override)` compatibility stub preserving stored values without validation
  - `validateZenModelAtStartup()` compatibility no-op
  - `summarizeText(text, targetLength, zenModel)` compatibility stub returning local fallback text
  - `extractLastMessageText(payload, maxLength?)`
  - `fetchLastAssistantMessageText(sessionId, messageId, maxLength?)`
  - `maybeCacheSessionInfoFromEvent(payload)`
  - `buildTemplateVariables(payload, sessionId)`
  - `getCachedZenModels()`

## Constants

### Default values
- `DEFAULT_NOTIFICATION_MESSAGE_MAX_LENGTH`: 250 (default max length for notification text).
- `NOTIFICATION_SSE_HEARTBEAT_INTERVAL_MS`: 20000 (notification SSE comment heartbeat interval).

## Settings object format

The `settings` parameter for `prepareNotificationLastMessage` supports `maxLastMessageLength` (number), the maximum length for the final notification text (default: 250). Legacy summarization settings may still exist in persisted settings but are ignored.

## Response contracts

### `truncateNotificationText`
- Returns empty string for non-string input.
- Returns original text if under max length.
- Returns `${text.slice(0, maxLength)}...` for truncated text.

### `prepareNotificationLastMessage`
- Returns empty string for empty/null message.
- Returns truncated original message. Model-backed notification summarization is retired.
- Normalizes markdown-like formatting to plain text before truncation.
- Always applies `maxLastMessageLength` truncation to final result.

## Notes for contributors

### Adding new notification helpers
1. Add new helper functions to `packages/web/server/lib/notifications/message.js`.
2. Export functions that are intended for public use.
3. Follow existing patterns for input validation (e.g., type checking for strings).
4. Use `resolvePositiveNumber` for numeric parameters with fallbacks to maintain safe defaults.
5. Add corresponding unit tests in `packages/web/server/lib/notifications/message.test.js`.

### Error handling
- `prepareNotificationLastMessage` does not call model summarization.
- Invalid numeric parameters default to safe fallback values.
- Non-string inputs are handled gracefully (return empty string).

### Testing
- Run `bun run type-check`, `bun run lint`, and `bun run build` before finalizing changes.
- Unit tests should cover truncation behavior and edge cases (empty strings, invalid inputs).
