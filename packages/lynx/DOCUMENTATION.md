# Lynx connect / session client

Owning package for the Lynx rewrite’s **connection, pairing v2, deep links, and session-index** data path. Product behavior is copied from Capacitor + shared UI on `work/lynx-native` (`packages/ui/src/apps/mobileConnections.ts`, `mobileQrScan.ts`, `deepLinks.ts`, `packages/ui/src/lib/connectionPayload.ts`, `packages/ui/src/lib/session-index-api.ts`).

## Runtime boundaries

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
| Official OpenCode session CRUD | `@opencode-ai/sdk/v2` | **not this package** — chat track |

Do not invent `/api/nearby/redeem` or Bonjour browse.

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

## Remaining for 三关

| Gate | This slice |
|---|---|
| 代码接上 | Client calls the real routes above. Host must still inject HTTP + Keychain + (later) relay tunnel. |
| CI绿 | Missing — track CI (Android debug APK + iOS sim) is a later slice. Unit tests here are local only. |
| 真机过 | Not executed (Linux cloud VM; no Xcode / physical device). |
