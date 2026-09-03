# OpenChamber Relay Server

`openchamber-relay` is the self-hosted Layer 1 relay for OpenChamber remote access. It gives OpenChamber Hosts an outbound Relay connection and carries encrypted client traffic through that connection.

The same `@openchambery/relay-server` package also ships `openchamber-push-relay`, an isolated APNs push process. Layer 1 never receives Apple credentials. Push never terminates E2EE tunnels.

The Relay routes opaque Layer 2/3 frames verbatim. E2EE terminates at the OpenChamber Host and Client, so the Relay has routing metadata and transport state while the endpoints hold application plaintext, pairing secrets, and client bearer credentials. Host Relay connections authenticate with the Host's long-lived P-256 signing key. Relay reachability grants transport access; endpoint validation continues to enforce pairing and client credentials.

## Architecture and transport

The components have the following responsibilities:

- **Host** maintains an authenticated control WebSocket to the Relay, receives client connection requests, and opens matching Host data WebSockets.
- **Control channel** associates a Host identity with its active route and communicates connection lifecycle events.
- **Data channel** pairs one Host data WebSocket with one Client WebSocket and forwards opaque encrypted frames in both directions.
- **Client** requests a route to a Host and multiplexes application traffic through its encrypted Relay tunnel.

The tunneled application transport supports HTTP, streaming SSE, and WebSocket traffic. HTTP and SSE use the Client bearer credential through the encrypted tunnel. WebSockets use a short-lived URL-scoped credential (`oc_url_token`) minted by the Host endpoint.

Relay state lives in process memory. Hosts reconnect after a Relay restart. A disconnected Host control connection retains its route during the configurable 30-second grace period.

Relay v1 accepts anonymous Client route requests. Admission, connection, frame, queue, and socket limits bound this public entry point.

## Dual-process security boundary

Layer 1 (`openchamber-relay`) and Push (`openchamber-push-relay`) are separate processes in one package:

- Layer 1 authenticates Hosts, brokers WebSocket routes, and forwards opaque frames. It has no APNs key, no device-token database, and no `/v1/push/*` handlers.
- Push verifies Host signatures, binds `token → serverId` in a local SQLite database, and holds the project APNs `.p8` key. It has no access to Relay tunnels, pairing secrets, or client bearer credentials.
- Deploy them as two containers from the same immutable image. Give APNs Key ID / Team ID / Bundle ID and the `.p8` secret only to the Push container. Keep Layer 1 free of those secrets.
- SQLite is a single-writer store. Run one Push instance per database file. Do not share that volume across replicas.

## Requirements

- `@openchambery/relay-server` installation: Node.js 22.13 or later and a supported package manager such as npm, pnpm, yarn, or Bun. Push uses Node's built-in `node:sqlite`.
- Single-file Layer 1 bundle build: Bun. This repository uses Bun 1.3.14. Do not Bun-compile the Push entry; Docker runs it with Node 24.
- Public deployment: a DNS name, TLS certificate, reverse proxy, and firewall policy appropriate for the deployment.

## Install and quick start

`openchamber-relay` ships as an executable in the public `@openchambery/relay-server` package.

```sh
npm install -g @openchambery/relay-server
openchamber-relay --public-url wss://relay.example.com/ws
```

The default listener is `127.0.0.1:8787` and the default WebSocket upgrade path is `/ws`. Keep this loopback listener behind a TLS reverse proxy and set `--public-url` to the public `ws://` or `wss://` URL with the same path.

Start the isolated Push process from the same package. The default listener is `127.0.0.1:8788`. APNs Key ID, Team ID, and a `.p8` value or file path are required:

```sh
export OPENCHAMBER_PUSH_RELAY_APNS_KEY_ID='<apns-key-id>'
export OPENCHAMBER_PUSH_RELAY_APNS_TEAM_ID='<apns-team-id>'
export OPENCHAMBER_PUSH_RELAY_APNS_BUNDLE_ID=com.yee94.openchamber
export OPENCHAMBER_PUSH_RELAY_APNS_P8_PATH=/etc/openchamber/AuthKey.p8
openchamber-push-relay --host 127.0.0.1 --port 8788
```

Keep Push on loopback behind the same TLS reverse proxy. Route only `/v1/push/*` to port 8788.

### Combined mode (single port)

`openchamber-relay` can mount Push on the same listener. If any `OPENCHAMBER_PUSH_RELAY_APNS_*` variable is non-empty, Layer 1 loads Push and serves `/v1/push/*` on the Relay port. Partial APNs configuration fails startup; it does not silently disable Push. With no APNs variables set, Layer 1 behavior is unchanged and Push is not loaded.

In combined mode:

- Push routes share the Relay port at `/v1/push/*`.
- `/healthz` and `/readyz` remain Layer 1 endpoints.
- `OPENCHAMBER_PUSH_RELAY_HOST` and `OPENCHAMBER_PUSH_RELAY_PORT` are ignored.
- `openchamber-push-relay` is unchanged and remains the isolated two-process option.

```sh
export OPENCHAMBER_PUSH_RELAY_APNS_KEY_ID='<apns-key-id>'
export OPENCHAMBER_PUSH_RELAY_APNS_TEAM_ID='<apns-team-id>'
export OPENCHAMBER_PUSH_RELAY_APNS_BUNDLE_ID=com.yee94.openchamber
export OPENCHAMBER_PUSH_RELAY_APNS_P8_PATH=/etc/openchamber/AuthKey.p8
export OPENCHAMBER_PUSH_RELAY_DATABASE_PATH=/var/lib/openchamber/push-relay.sqlite
openchamber-relay --public-url wss://relay.example.com/ws
```

Minimal Compose environment for combined mode:

```yaml
services:
  relay:
    image: openchamber-relay:<version>
    environment:
      OPENCHAMBER_RELAY_SERVER_PUBLIC_URL: wss://relay.example.com/ws
      OPENCHAMBER_PUSH_RELAY_APNS_KEY_ID: ${OPENCHAMBER_PUSH_RELAY_APNS_KEY_ID}
      OPENCHAMBER_PUSH_RELAY_APNS_TEAM_ID: ${OPENCHAMBER_PUSH_RELAY_APNS_TEAM_ID}
      OPENCHAMBER_PUSH_RELAY_APNS_BUNDLE_ID: com.yee94.openchamber
      OPENCHAMBER_PUSH_RELAY_APNS_P8_PATH: /run/secrets/apns_p8
      OPENCHAMBER_PUSH_RELAY_DATABASE_PATH: /data/push-relay.sqlite
    ports:
      - "127.0.0.1:8787:8787"
```

OpenChamber Hosts do not need a separate Push URL when they already have a Relay URL. The effective `wss://` or `ws://` Relay URL maps to the same host as `https://` or `http://` `/v1/push/send` (register is `/v1/push/register-token`). Set `OPENCHAMBER_PUSH_RELAY_URL` on the Host to override that mapping. After a Relay switch, the Host re-registers persisted device tokens and binds them again before the first send.

### Build a standalone executable

Run these commands from the repository root. `bun build --compile` creates a single executable for the current platform and architecture.

```sh
bun build --compile --outfile ./openchamber-relay ./packages/relay-server/bin/openchamber-relay.js
sudo install -m 0755 ./openchamber-relay /usr/local/bin/openchamber-relay
```

Smoke-test the installed executable, process health, and readiness:

```sh
openchamber-relay --version
openchamber-relay --host 127.0.0.1 --port 8787 --json > /tmp/openchamber-relay-startup.json 2> /tmp/openchamber-relay.stderr &
relay_pid=$!
curl -fsS http://127.0.0.1:8787/healthz
curl -fsS http://127.0.0.1:8787/readyz
kill -TERM "$relay_pid"
wait "$relay_pid"
```

The executable remains independently deployable after compilation. `@openchambery/relay-server` owns its distribution and publishes the `openchamber-relay` executable.

## Configure the listener and public URL

Command flags take precedence over `OPENCHAMBER_RELAY_SERVER_*` environment variables, which take precedence over defaults.

```sh
openchamber-relay \
  --host 127.0.0.1 \
  --port 8787 \
  --path /relay \
  --public-url wss://relay.example.com/relay
```

The public URL path and the configured Relay path must match. An IPv6 public URL uses brackets around the literal:

```sh
openchamber-relay --public-url wss://[2001:db8::1]/ws
```

Available CLI options:

```text
--host HOST
--port PORT
--path PATH
--public-url WS_URL
--trust-proxy | --no-trust-proxy
--json
--quiet, -q
--help, -h
--version, -v
```

Push CLI options:

```text
--host HOST
--port PORT
--trust-proxy | --no-trust-proxy
--json
--quiet, -q
--help, -h
--version, -v
```

## Connect OpenChamber Hosts

Set the public Relay URL in every OpenChamber Host environment, then start the Host and create a Relay pairing link or enable Relay pairing in the application.

```sh
export OPENCHAMBER_RELAY_URL=wss://relay.example.com/ws
openchamber
```

The **Add a device** dialog can override the Relay endpoint for a pairing. The Host persists and switches to the selected endpoint before it emits the QR code, unless `OPENCHAMBER_RELAY_URL` pins the deployment endpoint. The effective `relayUrl` is part of the pairing-v2 candidate and is saved by Mobile and Desktop clients for later reconnects.

Existing Clients use a new pairing flow to receive a changed Relay endpoint. Create a fresh pairing link when endpoint replacement is required.

## TLS reverse proxies

The Relay serves loopback HTTP health endpoints and WebSocket upgrades. The public proxy terminates TLS and forwards HTTP, SSE, and WebSocket upgrade traffic to the Relay.

### Caddy

```caddyfile
relay.example.com {
    reverse_proxy 127.0.0.1:8787 {
        header_up X-Forwarded-For {remote_host}
    }
}
```

Run the Relay with `--public-url wss://relay.example.com/ws`. Caddy forwards WebSocket upgrades and serves `/healthz` and `/readyz` from the same upstream. The `X-Forwarded-For` rule writes one canonical Client source IP.

When Push shares the hostname, send `/v1/push/*` to the Push listener and replace `X-Forwarded-For` once on each upstream:

```caddyfile
relay.example.com {
    handle /v1/push/* {
        reverse_proxy 127.0.0.1:8788 {
            header_up X-Forwarded-For {remote_host}
        }
    }

    handle {
        reverse_proxy 127.0.0.1:8787 {
            header_up X-Forwarded-For {remote_host}
        }
    }
}
```

### Nginx

```nginx
server {
    listen 443 ssl;
    server_name relay.example.com;

    ssl_certificate /etc/letsencrypt/live/relay.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/relay.example.com/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:8787;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
    }
}
```

Run the Relay with `--public-url wss://relay.example.com/ws`. Nginx writes one canonical Client source IP with `$remote_addr` and forwards WebSocket upgrades over HTTP/1.1.

To share the hostname with Push, proxy `/v1/push/` to `127.0.0.1:8788` and keep `/` (including `/ws`) on `127.0.0.1:8787`. Replace `X-Forwarded-For` with `$remote_addr` on both locations.

## Trusted proxies and capacity

Enable `OPENCHAMBER_RELAY_SERVER_TRUST_PROXY=true` or `--trust-proxy` when a trusted reverse proxy fully isolates Relay ingress and replaces each inbound `X-Forwarded-For` value with one canonical Client IP.

```sh
OPENCHAMBER_RELAY_SERVER_TRUST_PROXY=true \
openchamber-relay --public-url wss://relay.example.com/ws
```

Trusted-proxy mode accepts exactly one valid IP address in `X-Forwarded-For`. Client admission and per-Client-IP limits then use that address. Configure the proxy to replace the header, and restrict direct access to the Relay listener so proxy peer identity remains authoritative.

`OPENCHAMBER_RELAY_SERVER_MAX_RAW_SOCKETS_PER_IP` always counts the TCP peer connected to the Relay. A reverse proxy is that peer, so set this limit for the proxy's aggregate concurrent traffic rather than an individual public Client.

## Environment variables

| Variable | Default | Unit / purpose |
| --- | --- | --- |
| `OPENCHAMBER_RELAY_SERVER_HOST` | `127.0.0.1` | Listener address |
| `OPENCHAMBER_RELAY_SERVER_PORT` | `8787` | TCP port |
| `OPENCHAMBER_RELAY_SERVER_PATH` | `/ws` | WebSocket upgrade path |
| `OPENCHAMBER_RELAY_SERVER_PUBLIC_URL` | unset | Startup output URL; `ws://` or `wss://`, same path as `PATH` |
| `OPENCHAMBER_RELAY_SERVER_TRUST_PROXY` | `false` | Read one canonical Client IP from proxy-replaced `X-Forwarded-For` |
| `OPENCHAMBER_RELAY_SERVER_MAX_URL_BYTES` | `4096` | bytes |
| `OPENCHAMBER_RELAY_SERVER_MAX_FIELD_BYTES` | `512` | bytes per routing field |
| `OPENCHAMBER_RELAY_SERVER_MAX_HOSTS` | `256` | active Host routes |
| `OPENCHAMBER_RELAY_SERVER_MAX_SOCKETS` | `2048` | upgraded WebSockets |
| `OPENCHAMBER_RELAY_SERVER_MAX_CONNECTIONS` | `1000` | global client connections |
| `OPENCHAMBER_RELAY_SERVER_MAX_CLIENTS_PER_HOST` | `100` | connections per Host |
| `OPENCHAMBER_RELAY_SERVER_MAX_CLIENTS_PER_IP` | `30` | connections per Client IP |
| `OPENCHAMBER_RELAY_SERVER_MAX_PENDING_CLIENTS` | `30` | Clients awaiting a Host data connection |
| `OPENCHAMBER_RELAY_SERVER_PENDING_MS` | `15000` | ms awaiting a Host data connection |
| `OPENCHAMBER_RELAY_SERVER_MAX_RAW_SOCKETS` | `4096` | accepted TCP sockets before upgrade |
| `OPENCHAMBER_RELAY_SERVER_MAX_RAW_SOCKETS_PER_IP` | `128` | TCP sockets per Relay TCP peer IP |
| `OPENCHAMBER_RELAY_SERVER_GRACE_MS` | `30000` | ms Host control disconnect grace |
| `OPENCHAMBER_RELAY_SERVER_TIMESTAMP_SKEW_MS` | `60000` | ms Host signature timestamp window |
| `OPENCHAMBER_RELAY_SERVER_REPLAY_MS` | `120000` | ms replay-record lifetime; at least twice timestamp skew |
| `OPENCHAMBER_RELAY_SERVER_MAX_REPLAY_ENTRIES` | `10000` | Host signature replay records |
| `OPENCHAMBER_RELAY_SERVER_MAX_FRAME_BYTES` | `131072` | bytes per forwarded frame |
| `OPENCHAMBER_RELAY_SERVER_MAX_QUEUED_BYTES_PER_CONNECTION` | `2097152` | bytes per Client pair |
| `OPENCHAMBER_RELAY_SERVER_MAX_GLOBAL_QUEUED_BYTES` | `33554432` | bytes across all queues |
| `OPENCHAMBER_RELAY_SERVER_MAX_BUFFERED_AMOUNT` | `2097152` | bytes buffered by a WebSocket before pump retry |
| `OPENCHAMBER_RELAY_SERVER_MAX_CONTROL_QUEUE_ENTRIES` | `256` | queued Host control messages |
| `OPENCHAMBER_RELAY_SERVER_MAX_CONTROL_QUEUED_BYTES` | `2097152` | bytes queued for Host control |
| `OPENCHAMBER_RELAY_SERVER_PUMP_RETRY_MS` | `25` | ms between backpressure retries |
| `OPENCHAMBER_RELAY_SERVER_HEARTBEAT_MS` | `30000` | ms WebSocket ping interval |
| `OPENCHAMBER_RELAY_SERVER_HANDSHAKE_MS` | `10000` | ms for TCP and WebSocket admission |
| `OPENCHAMBER_RELAY_SERVER_CLOSE_DEADLINE_MS` | `5000` | ms before forced socket close |
| `OPENCHAMBER_RELAY_SERVER_ADMISSION_WINDOW_MS` | `60000` | ms per-IP admission window |
| `OPENCHAMBER_RELAY_SERVER_MAX_ADMISSIONS_PER_IP` | `120` | upgrades per role and IP per admission window |
| `OPENCHAMBER_RELAY_SERVER_MAX_ADMISSION_ENTRIES` | `10000` | tracked role/IP admission records |
| `OPENCHAMBER_RELAY_SERVER_ID_ATTEMPTS` | `4` | random connection-ID attempts |

### Host Push URL override

These variables belong on the OpenChamber Host, not on the Push process:

| Variable | Default | Unit / purpose |
| --- | --- | --- |
| `OPENCHAMBER_PUSH_RELAY_URL` | derived from the effective Relay `ws`/`wss` URL | Host override for `https://` or `http://` `…/v1/push/send` |
| `OPENCHAMBER_PUSH_RELAY_DISABLED` | unset | Host-only; `true` skips Push Relay and uses direct APNs |

The derived send URL always uses `/v1/push/send` on the same host and port as the Relay URL. `wss` maps to `https`; `ws` maps to `http`. Register is the same origin with `/v1/push/register-token`. iOS Live Activity tokens use `/v1/push/register-live-activity-token`, `/v1/push/unregister-live-activity-token`, and `/v1/push/live-activity` on that same origin. Live Activity APNs requests use topic `{bundleId}.push-type.liveactivity` and never include session IDs, titles, alerts, or collapse IDs.

### Push process environment

Command flags take precedence over `OPENCHAMBER_PUSH_RELAY_*` variables, which take precedence over defaults. APNs Key ID, Team ID, and `.p8` material are required.

| Variable | Default | Unit / purpose |
| --- | --- | --- |
| `OPENCHAMBER_PUSH_RELAY_HOST` | `127.0.0.1` | Listener address |
| `OPENCHAMBER_PUSH_RELAY_PORT` | `8788` | TCP port |
| `OPENCHAMBER_PUSH_RELAY_TRUST_PROXY` | `false` | Read one canonical Client IP from proxy-replaced `X-Forwarded-For` |
| `OPENCHAMBER_PUSH_RELAY_DATABASE_PATH` | `./data/push-relay.sqlite` | SQLite file; directory must be writable |
| `OPENCHAMBER_PUSH_RELAY_TIMESTAMP_SKEW_MS` | `300000` | ms signed `ts` window |
| `OPENCHAMBER_PUSH_RELAY_REPLAY_MS` | `600000` | ms replay-record lifetime; at least twice timestamp skew |
| `OPENCHAMBER_PUSH_RELAY_MAX_REPLAY_ENTRIES` | `10000` | replay records |
| `OPENCHAMBER_PUSH_RELAY_REGISTER_LIMIT_PER_MINUTE` | `60` | register requests per Client IP per minute |
| `OPENCHAMBER_PUSH_RELAY_SEND_LIMIT_PER_MINUTE` | `60` | send requests per Client IP per minute |
| `OPENCHAMBER_PUSH_RELAY_SERVER_SEND_LIMIT_PER_MINUTE` | `120` | send requests per `serverId` per minute |
| `OPENCHAMBER_PUSH_RELAY_MAX_TOKENS` | `100000` | persisted device-token bindings |
| `OPENCHAMBER_PUSH_RELAY_MAX_IN_FLIGHT` | `64` | concurrent APNs deliveries |
| `OPENCHAMBER_PUSH_RELAY_APNS_KEY_ID` | required | Apple APNs key ID |
| `OPENCHAMBER_PUSH_RELAY_APNS_TEAM_ID` | required | Apple Team ID |
| `OPENCHAMBER_PUSH_RELAY_APNS_BUNDLE_ID` | `com.yee94.openchamber` | App bundle ID |
| `OPENCHAMBER_PUSH_RELAY_APNS_P8` | required unless path set | APNs `.p8` PEM; literal `\n` accepted |
| `OPENCHAMBER_PUSH_RELAY_APNS_P8_PATH` | unset | Path to the `.p8` file; used when `APNS_P8` is empty |

TestFlight and App Store Hosts send `env: production` (`OPENCHAMBER_APNS_ENVIRONMENT=production` on the Host). Xcode development builds use `sandbox`. The Push process does not choose the APNs environment; each send request carries it.

## systemd

Create `/etc/openchamber-relay.env`:

```sh
OPENCHAMBER_RELAY_SERVER_PUBLIC_URL=wss://relay.example.com/ws
```

Create `/etc/systemd/system/openchamber-relay.service`:

```ini
[Unit]
Description=OpenChamber Private Relay
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
EnvironmentFile=/etc/openchamber-relay.env
ExecStart=/usr/local/bin/openchamber-relay
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

Enable and inspect the service:

```sh
sudo systemctl daemon-reload
sudo systemctl enable --now openchamber-relay
sudo systemctl status openchamber-relay
```

## Operations and security

- `GET` and `HEAD` requests to `/healthz` report process health. `/readyz` reports ready status after the listener reaches the running state.
- `SIGTERM` and `SIGINT` start graceful Relay shutdown. Hosts reconnect after a process restart.
- Size Host, Client, pending, socket, frame, and queue limits for expected concurrency and message volume.
- Keep the default loopback listener, terminate public TLS at a reverse proxy, restrict ingress with firewall rules, and publish the matching `wss://` URL.
- Keep logs and metrics snapshots free of URL query strings, `sig`, `pk`, `grant`, encrypted payloads, pairing material, bearer credentials, APNs `.p8` contents, Key ID / Team ID values, and device tokens.
- Run a single Push process per SQLite file. WAL mode does not make multi-instance sharing safe.

## Docker delivery assets

Each non-dry-run OpenChamber `v*` release and each `relay/v*` Relay-only release publishes a Docker Hub image for `linux/amd64` and `linux/arm64` as `<DOCKERHUB_USERNAME>/openchamber-relay:<version>` and `<DOCKERHUB_USERNAME>/openchamber-relay:latest`. The image default entrypoint is Layer 1. The same image also contains Node 24 and the `openchamber-push-relay` source/bin/package files. Layer 1 is a Bun 1.3.14 compile standalone; Push is executed with Node 24 and `node:sqlite`. The container runs as a non-root user, exposes `8787` and `8788`, and health-checks Layer 1 with Node. The release pipeline requires the `DOCKERHUB_USERNAME` GitHub Actions repository variable and a `DOCKERHUB_TOKEN` repository secret with Docker Hub Read and Write permissions. Image publication must succeed before the GitHub Release is finalized. `relay/v*` publishes the same npm package and Docker image without desktop, mobile, TestFlight, or OTA artifacts.

The `Relay Docker` workflow can republish only the current Relay package version without creating or modifying a GitHub Release or other platform artifacts.

Pull and run an immutable release tag behind a host TLS reverse proxy:

```sh
docker pull <dockerhub-username>/openchamber-relay:<version>
docker run -d \
  --name openchamber-relay \
  --restart unless-stopped \
  --read-only \
  --tmpfs /tmp \
  --security-opt no-new-privileges:true \
  -p 127.0.0.1:8787:8787 \
  -e OPENCHAMBER_RELAY_SERVER_PUBLIC_URL=wss://relay.example.com/ws \
  <dockerhub-username>/openchamber-relay:<version>
```

For an end-to-end public deployment with Caddy-managed HTTPS, use [`docker-compose.relay.remote.yml`](../../docker-compose.relay.remote.yml) with Docker Compose 2.23.1 or later:

```sh
OPENCHAMBER_RELAY_IMAGE='<dockerhub-username>/openchamber-relay:<version>@sha256:<manifest-digest>' \
RELAY_DOMAIN=relay.example.com \
ACME_EMAIL=admin@example.com \
docker compose -f docker-compose.relay.remote.yml up -d
```

`OPENCHAMBER_RELAY_IMAGE` is required so the repository never binds this reusable deployment file to a personal registry namespace. Use an immutable version-and-digest reference in production.

To run Layer 1 and Push from that same immutable image, with APNs secrets only on Push, a persistent SQLite volume, read-only root filesystems, and Caddy routing `/v1/push/*` to Push, use [`docker-compose.relay-push.remote.yml`](../../docker-compose.relay-push.remote.yml):

```sh
OPENCHAMBER_RELAY_IMAGE='<dockerhub-username>/openchamber-relay:<version>@sha256:<manifest-digest>' \
RELAY_DOMAIN=relay.example.com \
ACME_EMAIL=admin@example.com \
OPENCHAMBER_PUSH_RELAY_APNS_KEY_ID='<apns-key-id>' \
OPENCHAMBER_PUSH_RELAY_APNS_TEAM_ID='<apns-team-id>' \
OPENCHAMBER_PUSH_RELAY_APNS_BUNDLE_ID=com.yee94.openchamber \
OPENCHAMBER_PUSH_RELAY_APNS_P8_FILE=/etc/openchamber/AuthKey.p8 \
docker compose -f docker-compose.relay-push.remote.yml up -d
```

The Push container reads the `.p8` from the Docker secret path `/run/secrets/apns_p8`. Layer 1 does not receive that secret. Inspect both health checks with `docker compose -f docker-compose.relay-push.remote.yml ps`. Public `/healthz` and `/readyz` are Layer 1. Push `/healthz` stays on the internal listener.

Existing Layer-1-only Compose files keep their current behavior: [`docker-compose.relay.yml`](../../docker-compose.relay.yml) for loopback, and [`docker-compose.relay.remote.yml`](../../docker-compose.relay.remote.yml) for public Layer 1 without Push.

The repository provides optional Docker delivery assets at [`Dockerfile.relay`](../../Dockerfile.relay) and [`docker-compose.relay.yml`](../../docker-compose.relay.yml). The Compose service publishes `127.0.0.1:${OPENCHAMBER_RELAY_PUBLISHED_PORT:-8787}` and accepts `OPENCHAMBER_RELAY_SERVER_PUBLIC_URL` plus selected Relay limits.

```sh
OPENCHAMBER_RELAY_SERVER_PUBLIC_URL=wss://relay.example.com/ws \
OPENCHAMBER_RELAY_PUBLISHED_PORT=8787 \
docker compose -f docker-compose.relay.yml up -d --build
```

These assets define an optional follow-on deployment path. Validate the image, proxy integration, TLS configuration, and operational limits in the target environment before production use.

## Troubleshooting

| Symptom | Checks and resolution |
| --- | --- |
| Host or Client cannot connect | Confirm the public URL uses the deployed `wss://` scheme, host, and exact Relay path. Confirm DNS, certificate, firewall, and proxy upstream reachability. |
| `/healthz` succeeds and `/readyz` fails | Wait for the listener startup to complete, then inspect process stderr and service logs for bind errors. |
| Clients receive admission or connection limits | Review `MAX_CONNECTIONS`, per-Host, per-Client-IP, pending, admission, and raw-socket limits against current traffic. |
| Many Clients share a reverse proxy | Increase `MAX_RAW_SOCKETS_PER_IP` for aggregate proxy-peer concurrency. |
| Per-Client IP limits behave as proxy limits | Enable trusted-proxy mode, fully isolate Relay ingress behind that proxy, and configure a single replaced `X-Forwarded-For` IP. |
| Existing clients continue using an earlier endpoint | Refresh the candidate or create a new pairing link after changing `OPENCHAMBER_RELAY_URL`. |
| WebSocket application traffic fails while HTTP works | Confirm the Host endpoint mints and supplies a short-lived `oc_url_token` for the WebSocket path. |
| Push register or send returns 404 on the public hostname | Confirm the reverse proxy sends `/v1/push/*` to the Push listener on port 8788, not to Layer 1. |
| Push container is unhealthy | Confirm APNs Key ID / Team ID / Bundle ID and the `.p8` secret path, and that the SQLite volume is writable by the non-root user. |
| Device tokens stop receiving after a Relay URL change | Confirm the Host re-registered against the new Push origin before the first send, or set `OPENCHAMBER_PUSH_RELAY_URL` explicitly. |

## Development and test coverage

Run Relay package unit tests and Host/Client end-to-end coverage independently from the repository root:

```sh
bunx vitest run --project @openchamber/relay-server
bunx vitest run --project @openchamber/web packages/web/server/lib/relay/relay-server.e2e.test.ts
```

`packages/web/server/lib/relay/relay-server.e2e.test.ts` builds a compiled Relay executable and exercises a real Host and TypeScript Client across authenticated HTTP, streaming SSE, URL-token WebSocket traffic, Relay restart recovery, and cleanup. Use this E2E coverage when validating Relay transport changes.
