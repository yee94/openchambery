# Relay Module Documentation

## Purpose

The private relay lets an OpenChamber client (mobile app, browser, or another desktop) reach a user's OpenChamber instance through OpenChamber-hosted infrastructure when the instance is not directly reachable (behind NAT or without a public URL). The instance dials **outbound** to the relay; nothing needs to be exposed inbound.

Traffic is **end-to-end encrypted between the two endpoints** (client and host instance). The relay infrastructure forwards opaque ciphertext and cannot read application traffic — it is an untrusted transport, not a trusted middlebox.

This module (`packages/web/server/lib/relay/`) is the **Host side** of the private relay. **Only the Electron desktop runtime or an SSH-managed remote server may act as a relay host** (`OPENCHAMBER_RUNTIME=desktop` or `ssh-remote`). Electron sets `desktop` before it starts the in-process web server; SSH manager sets `ssh-remote` when launching a managed remote `openchamber serve` (optionally with `--relay-host`). Plain `node` / `dev:web:hmr` / ordinary CLI / VS Code web servers must not open the host-control socket, claim `relay-host.lock`, or advertise a host pairing candidate — even when they share the same data dir as desktop. Those processes may still run the API that *clients* use; mobile and other desktops remain **relay clients**. The **Client side** lives in `packages/ui/src/lib/relay/`. Hosted Relay instances may run in a Worker. The self-hosted **Relay server** belongs to `packages/relay-server/` and brokers Layer 1 connections.

## The three layers

Traffic is modeled as three stacked layers. The relay understands only Layer 1; Layers 2–3 exist solely between the client and the host.

1. **Relay routing (Layer 1)** — outbound WebSocket connections to the relay, connection brokering, and host authentication to the relay. The relay routes each client to the correct host and forwards frames verbatim.
2. **End-to-end encryption (Layer 2)** — an authenticated encrypted channel established directly between client and host, keyed so the relay cannot participate. Built on standard WebCrypto primitives (ECDH key agreement + AEAD framing). The host's encryption public key is distributed to the client out-of-band via the pairing payload and is the client's trust anchor.
3. **Tunnel multiplexing (Layer 3)** — because an OpenChamber client speaks many concurrent HTTP requests, an event stream (SSE), and WebSockets to one origin, the encrypted channel carries a small multiplexing protocol. It frames HTTP request/response (including streamed bodies) and WebSocket sub-streams so the whole app works over one encrypted connection.

## Entrypoints and structure

Host side (`packages/web/server/lib/relay/`):
- `service.js` — thin entrypoint: relay config (enabled flag + endpoints), the management routes (`GET/POST /api/openchamber/relay/{status,enable,disable}`, `POST /api/openchamber/relay/endpoints`), a `getPairingCandidate()` accessor (the relay transport candidate folded into pairing-v2 links when enabled, consumed by the pairing-session route in `core-routes.js`), and lifecycle wiring. **Multi-relay:** `settings.privateRelay = { enabled, relayUrl, extraRelayUrls }` — the host dials EVERY configured endpoint simultaneously with one identity (same serverId); clients treat `serverId + relayUrl` as the instance identity, so the same machine exposed via two domains appears as two separately named instances. The primary (`relayUrl`) owns push registration and stays the default pairing candidate. A pairing link created for an endpoint the host does not have yet APPENDS it as an extra endpoint (owner request only) instead of replacing the primary, so devices paired over the old domain keep working. `POST /relay/endpoints` (owner session / `desktop-local` only) replaces the extra-endpoint list wholesale and starts/stops host connections incrementally. Paired desktops may pair over any CONFIGURED endpoint but can never add one. Host lifecycle is gated by `isRelayHostRuntime()` (`desktop` or `ssh-remote`): other runtimes (`bun run dev`, `dev:web:hmr`, ordinary CLI `serve`, VS Code, plain `node server`) report `state: 'unavailable'`, refuse `/relay/enable`, `/relay/disable`, `/relay/endpoints`, and relay pairing with 403, never mint a relay identity, never advertise `relayAvailable`, and never call `startRelayHost`. Direct `node server/index.js` forces `OPENCHAMBER_RUNTIME=web` unless it is already `ssh-remote`, so a leftover desktop env cannot open the host-control socket. On host runtimes, started from `packages/web/server/index.js` when demand/opt-in enables the relay. Desktop auto-clears `privateRelay.enabled` when demand drops; `ssh-remote` keeps an explicit opt-in (e.g. `openchamber serve --relay-host`) sticky until disabled. The relay endpoint defaults to the OpenChamber-hosted relay but can be pinned to a self-hosted relay via the `OPENCHAMBER_RELAY_URL` env var; when set it overrides the stored setting for the host connection, the pairing candidate, and status, so paired clients inherit the endpoint automatically. Endpoint identity is scheme/host/path only: accepted schemes are `ws://` and `wss://`; URLs with userinfo are rejected (no silent default fallback); query and fragment are stripped before persistence and pairing candidates. Custom endpoint persistence and Host control-connection switching are explicit authenticated management actions. Pairing creation with `relayUrl` requires an owner UI session or the local `desktop-local` shell client; `/relay/enable` follows its API auth gate. `derivePushSendUrlFromRelayUrl` maps a canonical Relay `wss://`/`ws://` URL to the same host's `https://`/`http://` `/v1/push/send` path (register is `/v1/push/register-token`); `OPENCHAMBER_PUSH_RELAY_URL` on the Host overrides that derivation. The isolated Push process lives in `packages/relay-server/src/push/` and does not share Layer 1 credentials or tunnel state.
- `identity.js` — the host's stable identity: the long-lived signing keypair (shared with the push relay, defines the routing id) plus a long-lived encryption keypair (the E2EE trust anchor). Reused across restarts; never rotated implicitly.
- `signing-key.js` — storage/derivation of the signing keypair and the routing id, shared with the notifications runtime. Canonical public JWK hashing matches `packages/relay-server/src/push/crypto.js`.
- `host-client.js` — the long-lived connection manager: one outbound control connection to the relay, a per-client data connection for each connected device, reconnect/backoff, and the E2EE responder handshake per connection.
- `host-lock.js` — the per-machine host claim. Every local instance sharing the data dir shares the relay identity (same serverId), so concurrent relay hosts evict each other at the relay worker (`4001: Control replaced`) and paired devices land on whichever local process won last. The claim file (`<data-dir>/relay-host.lock`, `{ pid }`) makes this deterministic: `service.js` only starts the host when no LIVE process holds the claim (stale claims from dead pids are ignored), goes to `standby` otherwise, and a 30s watcher both takes over when the claimant dies and stands down when another process claims. Explicit user intent — creating a pairing link or hitting `/relay/enable` — force-claims; the previous holder's watcher sees the takeover and backs off instead of fighting. The claim is cooperative (the relay worker still enforces the single host slot); it only decides which process keeps retrying.
- `tunnel-host.js` — the per-connection dispatcher: decrypts tunnel frames and forwards HTTP/SSE/WS to the local server over loopback, then streams responses back. Enforces a path allowlist and never injects credentials.
- `e2ee.js`, `tunnel-codec.js` — host-side (JS) mirrors of the shared crypto and framing (see "Two implementations" below).

Client side (`packages/ui/src/lib/relay/`):
- `protocol.ts` — the shared contract: constants, frame types, message shapes. The normative source both implementations follow.
- `crypto.ts`, `handshake.ts` — the E2EE primitives and handshake state machines (initiator + responder).
- `tunnel-codec.ts` — Layer 3 frame codec, fragmentation, and outbound frame batching.
- `tunnel-client.ts` — the client tunnel: exposes a `fetch()`-compatible and a WebSocket-compatible surface backed by the encrypted tunnel.
- `tunnel-payloads.ts`, `runtime-tunnel.ts`, `runtime-socket.ts` — payload helpers, the active-tunnel singleton, and the shared "open a runtime WebSocket the right way" helper.

Relay is not a separate link format: it is one transport candidate inside the unified **pairing v2** payload (`packages/ui/src/lib/connectionPayload.ts`). A relay candidate is `{ type: 'relay', relayUrl, serverId, hostEncPubJwk }` — no embedded token; the client redeems the one-time pairing secret over the tunnel like any other candidate.

## What travels the tunnel

Everything a client normally sends to the single OpenChamber origin:
- **HTTP** — REST endpoints and proxied OpenCode SDK calls under `/api/*`, plus `/auth/*` and `/health`.
- **SSE** — streamed responses opened through `runtimeFetch`, including `/api/openchamber/events` and SDK global SSE. Relay carries these HTTP response body frames through the tunnel.
- **WebSocket** — the endpoints that use a real socket (the global event stream on platforms that support WS, terminal I/O, dictation).

The host dispatcher restricts tunneled traffic to explicit path allowlists (one for HTTP, one for WS).

### Catalog and new HTTP API pitfalls over Relay

Private Relay is transparent for allowlisted HTTP paths, so most “works on LAN / Desktop, empty on mobile Relay” bugs are Host routing or client transport-identity mistakes rather than Relay framing bugs:

- **Same path, real Host route required.** Clients call the ordinary `/api/...` path through the tunnel. If that route is missing on the Host process currently holding the relay claim (wrong git worktree, stale packaged Desktop build, or a backend that never registered the OpenChamber route before the OpenCode proxy/SPA fallback), the tunnel still returns HTTP 200 with SPA HTML or proxied OpenCode content. Symptom: chat and status work, Provider/model catalog does not.
- **HTTP allowlist is prefix-based for `/api/`.** New REST/SSE APIs under `/api/` do not need a tunnel-host allowlist edit. New **WebSocket** paths still need both `ALLOWED_WS_PATHS` and `isUrlAuthWebSocketPath` (see the `relay-transport` skill). Config sync (`/api/openchamber/config-sync/*`, ticket 05/06) therefore works over Relay without a tunnel-host allowlist change; identity and credential grants remain endpoint concerns (`relay:<serverId>`, pairing-settings / inbound host grant).
- **Transport identity ≠ runtime key.** After LAN⇄relay swaps, UI catalog loaders commit only when `useConfigStore.catalogTransportIdentity` matches `getRuntimeTransportIdentity()`. `runtimeEndpointReset.ts` must write that transport fingerprint on both full endpoint reset and in-place transport reconnect. Writing `runtimeKey` instead leaves Providers empty because the stable device/instance id is shared across LAN and relay.
- **Safe catalog projection stays Host-owned.** Provider credentials never cross the browser; Relay only carries the already-allowlisted `GET /api/config/catalog/providers` JSON. Keep Host projection, client parser bounds, and `partial` rules in sync (empty `release_date` is absent, not partial).

See also `packages/web/server/lib/opencode/DOCUMENTATION.md` (“Catalog / OpenChamber-owned API change checklist”) and `packages/ui/src/stores/DOCUMENTATION.md` (Provider catalog / `catalogTransportIdentity`).

## Authentication model

- The tunnel is **transport only**. The OpenChamber server still authenticates every tunneled request exactly as it authenticates a direct remote client. The relay path grants reachability, not authorization.
- A paired **desktop** client is a device-fleet operator: through the tunnel it can create pairing links, list every paired device, and revoke other devices (parity with the SSH attach flow, where the connecting desktop authenticates as the operator). Mobile (and any other) paired clients stay scoped to their own record. Re-pointing the Host relay endpoint set from a remote bearer remains forbidden — a paired desktop may name any endpoint the host already has, but adding/removing endpoints (including `relayUrl` in pairing requests for a new domain) is an owner-UI / local-desktop-shell action.
- Clients carry their normal credential. HTTP and SSE requests authenticate with the client's bearer token (a header). **WebSocket upgrades cannot send headers**, so they authenticate with a short-lived URL-scoped token minted beforehand and passed as a query parameter. This asymmetry is important when adding new WebSocket features (see the skill).
- The host authenticates itself to the relay with a signed handshake using its long-lived signing key.
- Enabling the relay is explicit opt-in and disabled by default; disabling it severs all relay reachability immediately.

## End-to-end flow (overview)

1. **Pairing.** The host issues a pairing-v2 link (QR / deep link) carrying a one-time secret and a list of transport candidates. When the relay is enabled, one candidate is the relay transport (its endpoint, routing id, and encryption public key — the E2EE trust anchor). The client redeems the secret over the first reachable candidate; over the relay candidate it opens the E2EE tunnel first, then redeems through it, and stores the connection.
2. **Presence.** When the relay is enabled, the host opens one outbound control connection and waits.
3. **Connect.** The client connects for a given routing id; the relay notifies the host over the control connection; the host opens a matching per-client data connection.
4. **Handshake.** Over that connection pair, client and host run the E2EE handshake and derive a shared encrypted channel the relay cannot read.
5. **Traffic.** All normal app traffic is multiplexed and encrypted through that channel. On the host, decrypted requests are dispatched to the local server over loopback; responses stream back encrypted. Reconnects re-establish a fresh channel and the app's existing retry machinery recovers.

## Candidate refresh (staying off the relay when direct works)

Pairing-payload transport candidates are a snapshot: when DHCP hands the host
machine a new LAN address, a device's saved direct candidate goes stale and the
device silently degrades to relay-only. To recover, an already-paired client can
call `GET /api/client-auth/connection/candidates` (UI session or client bearer;
registered with the auth/access routes) over any live transport — including
through the tunnel — to learn the server's **current** LAN URLs plus the relay
candidate, and update its saved candidate set (mobile: `mobileConnections.ts`;
desktop: `desktopRelayRestore.ts`).

Identity gating: the response carries the stable `serverId` (base64url SHA-256 of
the public signing JWK — the same identity the relay routes by, exposed by the
relay service's `getServerId()` and echoed unauthenticated on `/health` and
`/api/version`). Clients ignore a refresh whose `serverId` does not match their
pinned relay identity, and verify `/health`'s `serverId` on a learned address
**before** sending their bearer token to it — a re-assigned LAN address may now
belong to a different machine.

## Two implementations, kept in sync

The E2EE and framing logic exists twice: TypeScript in `packages/ui/src/lib/relay/` (shared by the client and the normative reference) and a JavaScript mirror in this module (the host, which is plain JS ESM). They **must stay byte-compatible** — a client encrypted by one must decrypt on the other. A cross-compatibility test (`cross-compat.test.js`) imports the TS modules directly and exercises a full TS-client ↔ JS-host exchange. Any change to the wire format, frame codec, handshake, or batching must update both sides and keep that test green (`bunx vitest run --project @openchamber/web packages/web/server/lib/relay/cross-compat.test.js`). Compiled Host/Client e2e: `bunx vitest run --project @openchamber/web packages/web/server/lib/relay/relay-server.e2e.test.ts`.

## Runtime integration (client)

Relay mode plugs into the existing client transport layer rather than a parallel path: `runtime-switch` activates the tunnel singleton, `runtime-fetch` routes runtime requests and product SSE streamed responses through it, `runtime-url` builds browser-consumed URLs, `runtime-socket` opens tunneled WebSockets, and `runtime-auth` mints the URL-scoped token through the tunnel. Direct-URL connections and the Electron realtime-proxy path are unaffected.

### Transport identity vs runtime key (do not mix)

`runtimeKey` is the stable device/instance id. It stays the same across LAN⇄relay for one paired device. `getRuntimeTransportIdentity()` is the active transport fingerprint (`direct:…` / `relay:…`) and changes when the client switches transports.

Catalog loaders (`loadProviders` / `loadAgents`) and assistant Query keys gate writes/caches on the **transport fingerprint**, not `runtimeKey`. On endpoint reset and same-device transport switch, `runtimeEndpointReset.ts` must set `useConfigStore.catalogTransportIdentity` to `getRuntimeTransportIdentity()`. Writing `detail.runtimeKey` there silently discards provider/agent catalog refreshes under Relay, which then hides capability-gated surfaces such as Assistants.

## Design invariants (do not regress)

- The relay never sees plaintext application traffic; it sees only routing metadata (routing id, connection identifiers, timestamps, coarse counts).
- Pairing secrets travel in URL fragments only, never in query strings, never logged.
- Relay endpoint URLs accept only `ws://`/`wss://`, reject userinfo, and drop query/fragment so settings and candidates never store credentials or non-identity URL parts.
- The host dispatcher never injects credentials; the server authenticates each tunneled request.
- The tunnel is transparent to the app: adding relay support to a feature should not require the feature to know the relay exists — it goes through the shared runtime transport helpers.
- The two implementations stay byte-compatible and the wire format is versioned/negotiated so mixed client/host app versions degrade gracefully rather than break.
- Tunneled HTTP/WS always dial `getLocalPort()` on loopback; there is no client-selected target-port override on the host dispatcher.

For the operational rules that keep future changes (new WebSocket endpoints, transport refactors, terminal/voice porting) from breaking this, load the `relay-transport` skill.
