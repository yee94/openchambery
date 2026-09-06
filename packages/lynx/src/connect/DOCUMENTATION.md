# Lynx connect kernel

Host-agnostic TypeScript for the Lynx track. The Lynx iOS/Android app package is **not** in tree yet. A future shell imports this module and injects host adapters.

```ts
import { createLynxConnectionController } from '@openchamber/lynx/connect';

const controller = createLynxConnectionController({
  request,          // native GET/POST to a LAN or tunnel URL
  openRelay,        // official E2EE tunnel; then the same HTTP paths
  secureStore,      // Keychain / Keystore
  metadataStore,    // instance list without tokens
  bindRuntime,      // switch the shell's active origin + bearer
  scanQr,           // optional camera; kernel only parses
});

await controller.resolveLaunch(); // splash while auto-connect runs
```

There is **no Nearby / Bonjour / mDNS**. Discovery is QR, paste of `openchamber://connect?v=2&p=…`, or a typed URL.

## Official API map

| Action | Route | Notes |
|---|---|---|
| Reachability | `GET /health` | No bearer. Optional `serverId` must match a paired relay identity. |
| Session probe | `GET /auth/session` | Bearer when we have a token. `401` / `authenticated:false` → password unlock. |
| Password unlock | `POST /auth/session` | `{ password, trustDevice, issueClientToken, clientKind: 'mobile', dedupeKey }` |
| Pairing redeem v2 | `POST /api/client-auth/pairing/redeem` | `{ pairingId, secret, clientKind: 'mobile', dedupeKey }`. One-shot; do not retry other candidates. |
| Refresh LAN set | `GET /api/client-auth/connection/candidates` | After bind. Echoed `serverId` required. |

Do **not** invent `/api/nearby/redeem` or any other redeem URL. Relay redeem uses the same path over the host tunnel.

## Persistence

- Metadata (`id`, `label`, ordered `candidates`, `hasToken`, `lastUsedAt`) — JSON store. Cap key: `openchamber.mobile.connections.v1`.
- Token — secure store only, key `openchamber.mobile.token.<urlencoded runtime key>`.
- Runtime key is `relay:<serverId>@<relayUrl>` when a relay candidate exists, else the normalized LAN URL.
- A pairing payload persists **every** LAN + relay candidate, including `relayUrl` + `hostEncPubJwk`. Grant is never stored.

## Connect race

LAN candidates start immediately. Relay starts after 1.5s **or** as soon as every LAN candidate is unreachable. A **relay-only** payload does not sleep.

## Deep links

Same intent union as `packages/ui/src/apps/deepLinks.ts`. Pairing can run on the welcome screen. Other intents stash until `setReady(true)`.

## Host stubs (labeled)

| Adapter | Status |
|---|---|
| `request` / probe / redeem / password | Kernel landed. Host supplies native HTTP. |
| `openRelay` | Kernel treats relay as a transport. Host must bind the official tunnel client. |
| `secureStore` | Contract landed. Keychain/Keystore plugin is host work. |
| `scanQr` | Parse + redeem landed. Camera is host work. |
| Splash / welcome Lynx page | Kernel exposes `phase` / `autoConnectLabel`. No Lynx view yet. |
