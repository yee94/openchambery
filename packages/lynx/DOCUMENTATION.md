# `@openchamber/lynx` module ownership

Lynx native phone shell + connect client for the `work/lynx-native` track.

## Owns

### Shell / host / glass

- Four-root dock IA and secondary-page stack (`src/shell/`)
- Host embedding decision and host ↔ page bridge (`src/host/`)
- Lynx 3.8 `<blur-view>` glass mapping and Android blur downgrade (`src/glass/`)
- Lynx-local catalog for dock / stub copy (`src/i18n/`)
- Mobile settings **search + 21 slug rows + push stubs** (`src/settings/`)
- Chat LegendList-semantics timeline + send/stop/queue hooks (`src/chat/`)
- Native host embedding sources (`host/ios/`, `host/android/`)

### Connect / pairing / session-index

Product behavior copied from Capacitor + shared UI (`packages/ui/src/apps/mobileConnections.ts`, `mobileQrScan.ts`, `deepLinks.ts`, `packages/ui/src/lib/connectionPayload.ts`, `packages/ui/src/lib/session-index-api.ts`).

| Need | Route / owner | Lynx path |
|---|---|---|
| Pairing redeem | `POST /api/client-auth/pairing/redeem` | `redeemPairingConnection` — one shot on the first live transport |
| Password + device token | `POST /auth/session` with `issueClientToken: true` | `submitPassword` |
| Reachability | `GET /health` (no bearer until serverId matches) | `probeConnectionCandidates` |
| Session auth | `GET /auth/session` | same probe / `validateMobileConnectionSession` |
| LAN refresh | `GET /api/client-auth/connection/candidates` | `refreshActiveConnectionCandidates` |
| Session list | `GET /api/openchamber/session-index` | `loadSessionIndexSnapshot` |
| Session by id | `GET /api/openchamber/session-index/session/:id` | `lookupSessionIndexById` |
| Pin / unpin | `POST` / `DELETE` `…/session/:id/pin` | `pinSession` / `unpinSession` |
| Official OpenCode session prompt/abort/messages | `@opencode-ai/sdk/v2` `/session/:id/{prompt_async,abort,message}` | `src/chat/sessionApi.ts` |
| Session create / archive / delete | `POST/PATCH/DELETE /session` | `src/projects/sessionActions.ts` |
| Question / permission pending | `GET/POST /question`, `/permission` | `src/chat/pendingCards.ts` |

Do not invent `/api/nearby/redeem` or Bonjour browse.

## Does not own

- SSE live tail / native IME / HTML iframe Files preview / PierreDiff polish
- Push token mint (host) / Live Activity / Capgo / QR camera / Keychain wiring
- Capacitor `packages/mobile` and shared React `packages/ui` runtimes
- Nearby / Bonjour browse
- Native ASR / voice product
- E2EE relay tunnel implementation — inject `openRelayTunnel` when the host has one
- Pixel connect/welcome UI and camera QR plugin (host-owned)

## Shell invariants

- Chat is never a tab. Secondary pages hide dock / host tab chrome.
- Mode B forbids a second Lynx dock and forbids full-page auto glass skin.
- Android glass is `blur-radius`, never cloned `UIGlassEffect` attributes.
- Native hosts never own the Lynx route stack.

## Connect race

Copied from Cap:

- Direct (LAN/tunnel) candidates keep priority.
- When a relay candidate exists **and** at least one direct candidate exists, the relay probe starts after `RELAY_RACE_HEADSTART_MS` (1500).
- Relay-only payloads **must not** sleep that headstart.
- If every direct candidate is unreachable, start relay immediately (cancel remaining headstart).
- Auth rejection (401 / `authenticated: false`) applies to every transport (same token) and short-circuits to `needs-login`.
- When the saved set includes a relay `serverId`, a direct `/health` that reports a **different** `serverId` is skipped (do not send the bearer there).

Harness: `src/connection/probe.test.ts` (`relay-only does not sleep 1.5s`).

## Persistence

- Metadata key: `openchamber.mobile.connections.v1` (same as Cap so a later host can migrate).
- Token key: `openchamber.mobile.token.<urlencoded runtime key>` in the injected secure store.
- Runtime key: `relay:<serverId>@<relayUrl>` when a relay candidate exists, else the normalized direct URL.
- Metadata never stores the bearer on the native path. Token writes are awaited before a runtime switch.
- Limit 12 saved instances. Dedupe by shared relay identity or shared normalized direct URL — never by hostname alone.

## Session index

- Authoritative GET. `available !== true` or HTTP failure is **not** an empty success.
- 501 → `unsupported` (external OpenCode without the index).
- Cache is keyed by **runtime key** (LAN↔relay share the same device identity).
- Failed refresh keeps the previous snapshot and surfaces `failed`.
- Instance switch (`clearRuntime`) drops in-memory index state.

Projects home consumes `projectSessionIndexHome(snapshot)` — cards + pinned / in-progress rows from the index. Live busy overlays and worktree git probes stay with later UI/sync slices.

## Deep links

`parseDeepLink` / `buildDeepLink` match `packages/ui/src/apps/deepLinks.ts`. Connect requires a valid v2 payload. v1 `?v=1&token=` is `null`.

QR / paste: `parseConnectionPayload` accepts v2 pairing links or a bare `http(s)` URL. Camera scanning is a host plugin, not this package.

## Tests

Vitest project `@openchamber/lynx` (`src/**/*.test.ts`). Navigation harness: `src/harness/navigationScenario.ts`.

## Remaining for 三关

| Gate | This slice |
|---|---|
| 代码接上 | Shell / embedding / glass contracts + client calls to the real routes above. Host must still inject HTTP + Keychain + (later) relay tunnel. |
| CI绿 | Package typecheck + Vitest. Track CI (Android debug APK + iOS sim) is a later slice. |
| 真机过 | Not executed (Linux cloud VM; no Xcode / physical device). |
