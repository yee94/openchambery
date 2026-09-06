# @openchamber/lynx

Lynx-side **connect / pairing / session-index** client for the `work/lynx-native` rewrite.

This package is a TypeScript client layer, not a pixel UI and not a host app. It maps to the same OpenChamber / OpenCode routes Capacitor mobile uses (`packages/ui` + `packages/mobile`).

## What this owns

- Pairing v2 parse (`openchamber://connect?v=2&p=…`). Legacy v1 links are rejected.
- `openchamber://` intent parse/build (same union as `packages/ui/src/apps/deepLinks.ts`).
- Saved-instance persistence: ordered LAN + relay **candidates**, token in an injected secure store.
- Connect / auto-connect / password unlock / pairing redeem on a **reachable** candidate (`GET /health`, `GET|POST /auth/session`, `POST /api/client-auth/pairing/redeem`).
- Session-index GET / pin / lookup keyed by runtime identity, with failure ≠ empty.
- Projects-home projection (API/types, not UI polish).

## What this does not own

- Host LynxView / four-tab dock / pixel chrome (`docs/lynx-ia-ui.md`).
- Nearby / Bonjour browse (does not exist in Cap; pairing v2 excluded it).
- Native ASR / voice product.
- FCM / APNs registration (leave to the push track; keep `com.yee94.openchamber[.debug]`).
- E2EE relay tunnel implementation — inject `openRelayTunnel` when the host has one.
- Chat LegendList, Settings editors, CI.

## Adapters the host must inject

| Adapter | Cap counterpart |
|---|---|
| `http.request` | CapacitorHttp then fetch |
| `secureStore` | Keychain / Keystore (`@aparajita/capacitor-secure-storage`) |
| `metadataStore` | localStorage `openchamber.mobile.connections.v1` |
| `openRelayTunnel` | `createRelayTunnelClient` (optional until relay lands) |
| `getDevicePlatform` | Capacitor `ios` / `android` |

Do not log tokens, pairing secrets, or bearer headers.

See `DOCUMENTATION.md`.
