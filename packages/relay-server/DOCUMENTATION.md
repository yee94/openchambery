# Relay Server Package Documentation

`packages/relay-server/` owns the self-hosted Layer 1 Relay server, the isolated Push Relay process, the `openchamber-relay` and `openchamber-push-relay` CLIs, and the package release and deployment contract.

## Purpose and security boundary

The Relay server brokers Layer 1 routing: Host control connections, client route requests, and matching Host data connections. It forwards opaque Layer 2/3 frames verbatim.

Host and Client terminate the E2EE channel. Each Host authenticates Relay connections with its long-lived P-256 signing key. Pairing secrets and client bearer credentials continue through endpoint validation; Relay reachability grants transport access.

Relay v1 admission accepts anonymous Client route requests. Per-IP, global, pending-connection, raw-socket, frame, and queue limits bound that public entry point. Configure limits for the expected traffic volume and keep the Relay behind TLS. Pair queues pause the fast sender at half the per-connection byte limit so a slow peer applies TCP backpressure instead of filling memory until `4029`. Ready pairs send one frame per tick so one tunnel cannot monopolize the event loop.

The Relay keeps process-local routing state only. Hosts reconnect after Relay restarts, and a control disconnect retains its Host route for the 30-second grace period.

Layer 1 and Push are separate processes in this package. Layer 1 never holds APNs credentials or the device-token database. Push never sees Relay tunnel frames, pairing secrets, or client bearer credentials. Give Apple secrets only to the Push process. SQLite token storage is single-instance: one Push process per database file.

## Quick deployment

Install the package, then start the Relay:

```sh
npm install -g @openchambery/relay-server
openchamber-relay
```

The default listener is `127.0.0.1:8787` and the WebSocket path is `/ws`. Deploy with the default loopback listener and a TLS reverse proxy. Set the public URL to the same public scheme, host, and path:

```sh
openchamber-relay --public-url wss://relay.example.com/ws
```

Push is a second executable from the same package. Default listen address is `127.0.0.1:8788`:

```sh
export OPENCHAMBER_PUSH_RELAY_APNS_KEY_ID='<apns-key-id>'
export OPENCHAMBER_PUSH_RELAY_APNS_TEAM_ID='<apns-team-id>'
export OPENCHAMBER_PUSH_RELAY_APNS_BUNDLE_ID=com.yee94.openchamber
export OPENCHAMBER_PUSH_RELAY_APNS_P8_PATH=/etc/openchamber/AuthKey.p8
openchamber-push-relay --host 127.0.0.1 --port 8788
```

The Host maps the effective Relay `wss://`/`ws://` URL to the same host as `https://`/`http://` `/v1/push/send`. Set `OPENCHAMBER_PUSH_RELAY_URL` on the Host to override. After a Relay switch, the Host re-registers persisted tokens and binds them before the first send. iOS Live Activity uses the same Push origin: `POST /v1/push/register-live-activity-token`, `POST /v1/push/unregister-live-activity-token`, and `POST /v1/push/live-activity`. Each Live Activity APNs request authenticates with the Host signing key, uses topic `{bundleId}.push-type.liveactivity`, and carries only `aps.timestamp`, `aps.event`, `aps.content-state`, and optional `dismissal-date` / `stale-date`. Successful `end` deliveries delete the token binding.

### Combined mode (single port)

When `openchamber-relay` sees any non-empty `OPENCHAMBER_PUSH_RELAY_APNS_*` variable, it mounts Push HTTP on the same listener at `/v1/push/*`. Missing required APNs fields fail startup instead of silently skipping Push. With no such variables, Layer 1 does not load the Push module.

Combined mode ignores `OPENCHAMBER_PUSH_RELAY_HOST` and `OPENCHAMBER_PUSH_RELAY_PORT`. Public `/healthz` and `/readyz` stay Layer 1. The standalone `openchamber-push-relay` entry is unchanged.

```sh
export OPENCHAMBER_PUSH_RELAY_APNS_KEY_ID='<apns-key-id>'
export OPENCHAMBER_PUSH_RELAY_APNS_TEAM_ID='<apns-team-id>'
export OPENCHAMBER_PUSH_RELAY_APNS_BUNDLE_ID=com.yee94.openchamber
export OPENCHAMBER_PUSH_RELAY_APNS_P8_PATH=/etc/openchamber/AuthKey.p8
export OPENCHAMBER_PUSH_RELAY_DATABASE_PATH=/var/lib/openchamber/push-relay.sqlite
openchamber-relay --public-url wss://relay.example.com/ws
```

Minimal Compose environment:

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

### Caddy

```caddyfile
relay.example.com {
    reverse_proxy 127.0.0.1:8787 {
        header_up X-Forwarded-For {remote_host}
    }
}
```

Run the Relay with `--public-url wss://relay.example.com/ws`. Caddy proxies WebSocket upgrades for `/ws` and serves `/healthz` and `/readyz` through the same upstream. `header_up X-Forwarded-For {remote_host}` replaces the inbound value with the single client source IP.

Shared hostname with Push:

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

Run the Relay with `--public-url wss://relay.example.com/ws`. The `/ws` path in the public URL and Relay configuration must match. `proxy_set_header X-Forwarded-For $remote_addr;` replaces the inbound value with the single client source IP. For Push on the same hostname, proxy `/v1/push/` to `127.0.0.1:8788` and keep `/` including `/ws` on `127.0.0.1:8787`, replacing `X-Forwarded-For` on both locations.

## Docker

Each non-dry-run OpenChamber `v*` release and each `relay/v*` Relay-only release publishes a multi-platform Relay image for `linux/amd64` and `linux/arm64` to Docker Hub. The image default entrypoint is Layer 1. The same image includes Node 24 plus `openchamber-push-relay` source/bin/package files. Layer 1 is compiled with Bun 1.3.14; Push is not Bun-compiled and runs under Node 24 (`node:sqlite`). The container user is non-root, ports `8787` and `8788` are exposed, and the image health check uses Node against Layer 1 `/healthz`. CI builds each architecture natively in parallel (`ubuntu-latest` and `ubuntu-24.04-arm`), then merges digests into a single multi-arch manifest tagged as:

```text
<DOCKERHUB_USERNAME>/openchamber-relay:<version>
<DOCKERHUB_USERNAME>/openchamber-relay:latest
```

The release workflow reads the Docker Hub account from the `DOCKERHUB_USERNAME` GitHub Actions repository variable and authenticates with the `DOCKERHUB_TOKEN` repository secret. Use a Docker Hub personal access token with Read and Write permissions; Delete permission is not required. A failed image build or push blocks final publication of the GitHub Release.

For an image-only republish of the current package version, run the `Relay Docker` workflow directly or dispatch the `Release` workflow with `relay_only` enabled. The image-only path does not create or modify a GitHub Release or any desktop and mobile artifacts.

Pull and run a published image behind a host TLS reverse proxy:

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

Use an immutable version tag in production. Each non-dry-run release updates `latest` together with its immutable version tag.

For a complete public deployment using the published immutable image, automatic HTTPS, and an internal-only Relay listener, use [`docker-compose.relay.remote.yml`](../../docker-compose.relay.remote.yml). Docker Compose 2.23.1 or later is required for its inline Caddy config. Point the domain's `A` and/or `AAAA` record at the server, allow inbound TCP ports 80 and 443 plus UDP port 443, then run:

```sh
OPENCHAMBER_RELAY_IMAGE='<dockerhub-username>/openchamber-relay:<version>@sha256:<manifest-digest>' \
RELAY_DOMAIN=relay.example.com \
ACME_EMAIL=admin@example.com \
docker compose -f docker-compose.relay.remote.yml up -d
```

`OPENCHAMBER_RELAY_IMAGE` is required; the deployment file must never bind to a personal registry namespace. Supply an immutable version-and-manifest-digest reference in production. The file keeps Relay off host ports, replaces forwarded client IPs at Caddy, persists Caddy certificates and configuration, and enables trusted-proxy mode on Relay. Inspect startup and readiness with:

```sh
docker compose -f docker-compose.relay.remote.yml ps
curl -fsS https://relay.example.com/healthz
curl -fsS https://relay.example.com/readyz
```

Layer 1 plus Push from the same immutable image uses [`docker-compose.relay-push.remote.yml`](../../docker-compose.relay-push.remote.yml). Layer 1 receives no APNs secrets. Push receives only APNs Key ID / Team ID / Bundle ID and the `.p8` Docker secret path, plus a persistent SQLite volume, with a read-only root filesystem. Caddy serves one hostname: `/v1/push/*` to `push:8788`, everything else including `/ws` to `relay:8787`, each replacing `X-Forwarded-For` once. Both services have health checks; Caddy waits until both are healthy.

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

```sh
docker compose -f docker-compose.relay-push.remote.yml ps
curl -fsS https://relay.example.com/healthz
curl -fsS https://relay.example.com/readyz
```

Public `/healthz` and `/readyz` are Layer 1. Push health remains on the internal `8788` listener and the Compose health check. Existing Layer-1-only Compose files keep their previous behavior.

From the repository root, build and start the supplied service. The compatibility assets are [`Dockerfile.relay`](../../Dockerfile.relay) and [`docker-compose.relay.yml`](../../docker-compose.relay.yml):

```sh
OPENCHAMBER_RELAY_SERVER_PUBLIC_URL=wss://relay.example.com/ws \
OPENCHAMBER_RELAY_PUBLISHED_PORT=8787 \
docker compose -f docker-compose.relay.yml up -d --build
```

Compose publishes `127.0.0.1:${OPENCHAMBER_RELAY_PUBLISHED_PORT:-8787}` by default; use `OPENCHAMBER_RELAY_PUBLISHED_PORT` to select the host port. The Compose service uses an ephemeral filesystem and keeps Host identity keys on each OpenChamber Host. Its image health check uses Node to call Layer 1 `GET /healthz`. Terminate public TLS at an external reverse proxy and publish `wss://relay.example.com/ws`. A public Relay port binding requires firewall rules and TLS; loopback publishing with a TLS reverse proxy is the deployment path.

## Connect Hosts

Set the Relay URL on every OpenChamber Host, start the Host, then generate a Relay pairing link or enable Relay pairing in the application:

```sh
export OPENCHAMBER_RELAY_URL=wss://relay.example.com/ws
openchamber
```

The **Add a device** dialog can select this endpoint per pairing. An owner UI session or the local Desktop shell (`desktop-local`) may persist a custom Host endpoint and switch the control connection; the effective `relayUrl` is embedded in the pairing-v2 candidate before the QR code. Endpoints must be `ws://` or `wss://` without userinfo; query and fragment are not part of identity and are stripped. `OPENCHAMBER_RELAY_URL` pins the endpoint and disables the override. The creating client remembers its last effective choice locally; consuming Mobile and Desktop clients persist the endpoint snapshot with the saved connection.

Existing clients switch to a new Relay after a new pairing flow; generate a fresh pairing link when endpoint replacement is required.

## Configuration

Configuration precedence is command flags, then `OPENCHAMBER_RELAY_SERVER_*` variables, then defaults. `--host`, `--port`, `--path`, `--public-url`, `--trust-proxy`, `--no-trust-proxy`, `--json`, and `--quiet` are available. Push flags are `--host`, `--port`, `--trust-proxy`, `--no-trust-proxy`, `--json`, and `--quiet`, with `OPENCHAMBER_PUSH_RELAY_*` variables.

`OPENCHAMBER_RELAY_SERVER_PUBLIC_URL` affects startup output. `OPENCHAMBER_RELAY_SERVER_PATH` selects the actual WebSocket upgrade endpoint. Relay listens on loopback by default. Enable `OPENCHAMBER_RELAY_SERVER_TRUST_PROXY=true` when a trusted reverse proxy fully isolates Relay ingress and replaces any client-supplied `X-Forwarded-For` value with one canonical client IP. Relay accepts one forwarded IP in this mode.

With correctly configured trusted proxying, client and admission limits use that canonical client IP. `OPENCHAMBER_RELAY_SERVER_MAX_RAW_SOCKETS_PER_IP` always counts the TCP peer that connects to Relay; reverse-proxy deployments therefore count raw sockets against the proxy and require a higher value sized for aggregate concurrent traffic.

For an IPv6 literal in a public URL, enclose the host in brackets: `wss://[2001:db8::1]/ws`.

| Variable | Default | Unit / purpose |
| --- | --- | --- |
| `OPENCHAMBER_RELAY_SERVER_HOST` | `127.0.0.1` | Listener address |
| `OPENCHAMBER_RELAY_SERVER_PORT` | `8787` | TCP port |
| `OPENCHAMBER_RELAY_SERVER_PATH` | `/ws` | WebSocket upgrade path |
| `OPENCHAMBER_RELAY_SERVER_PUBLIC_URL` | unset | Startup output URL; `ws://` or `wss://`, same path as `PATH` |
| `OPENCHAMBER_RELAY_SERVER_TRUST_PROXY` | `false` | Read one canonical client IP from proxy-replaced `X-Forwarded-For` |
| `OPENCHAMBER_RELAY_SERVER_MAX_URL_BYTES` | `4096` | bytes |
| `OPENCHAMBER_RELAY_SERVER_MAX_FIELD_BYTES` | `512` | bytes per routing field |
| `OPENCHAMBER_RELAY_SERVER_MAX_HOSTS` | `256` | active Host routes |
| `OPENCHAMBER_RELAY_SERVER_MAX_SOCKETS` | `2048` | upgraded WebSockets |
| `OPENCHAMBER_RELAY_SERVER_MAX_CONNECTIONS` | `1000` | global client connections |
| `OPENCHAMBER_RELAY_SERVER_MAX_CLIENTS_PER_HOST` | `100` | connections per Host |
| `OPENCHAMBER_RELAY_SERVER_MAX_CLIENTS_PER_IP` | `30` | connections per client IP |
| `OPENCHAMBER_RELAY_SERVER_MAX_PENDING_CLIENTS` | `30` | clients awaiting Host data connection |
| `OPENCHAMBER_RELAY_SERVER_PENDING_MS` | `15000` | ms awaiting Host data connection |
| `OPENCHAMBER_RELAY_SERVER_MAX_RAW_SOCKETS` | `4096` | accepted TCP sockets before upgrade |
| `OPENCHAMBER_RELAY_SERVER_MAX_RAW_SOCKETS_PER_IP` | `128` | TCP sockets per Relay TCP peer IP |
| `OPENCHAMBER_RELAY_SERVER_GRACE_MS` | `30000` | ms Host control disconnect grace |
| `OPENCHAMBER_RELAY_SERVER_TIMESTAMP_SKEW_MS` | `60000` | ms Host signature timestamp window |
| `OPENCHAMBER_RELAY_SERVER_REPLAY_MS` | `120000` | ms replay-record lifetime; at least twice timestamp skew |
| `OPENCHAMBER_RELAY_SERVER_MAX_REPLAY_ENTRIES` | `10000` | Host signature replay records |
| `OPENCHAMBER_RELAY_SERVER_MAX_FRAME_BYTES` | `131072` | bytes per forwarded frame |
| `OPENCHAMBER_RELAY_SERVER_MAX_QUEUED_BYTES_PER_CONNECTION` | `2097152` | bytes per client pair |
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

Host Push URL (OpenChamber Host, not the Push process):

| Variable | Default | Unit / purpose |
| --- | --- | --- |
| `OPENCHAMBER_PUSH_RELAY_URL` | derived from the effective Relay URL | explicit `…/v1/push/send` override |
| `OPENCHAMBER_PUSH_RELAY_DISABLED` | unset | `true` disables Push Relay on the Host |

Push process:

| Variable | Default | Unit / purpose |
| --- | --- | --- |
| `OPENCHAMBER_PUSH_RELAY_HOST` | `127.0.0.1` | Listener address |
| `OPENCHAMBER_PUSH_RELAY_PORT` | `8788` | TCP port |
| `OPENCHAMBER_PUSH_RELAY_TRUST_PROXY` | `false` | Read one canonical client IP from proxy-replaced `X-Forwarded-For` |
| `OPENCHAMBER_PUSH_RELAY_DATABASE_PATH` | `./data/push-relay.sqlite` | SQLite file |
| `OPENCHAMBER_PUSH_RELAY_TIMESTAMP_SKEW_MS` | `300000` | ms signed `ts` window |
| `OPENCHAMBER_PUSH_RELAY_REPLAY_MS` | `600000` | ms replay-record lifetime; at least twice timestamp skew |
| `OPENCHAMBER_PUSH_RELAY_MAX_REPLAY_ENTRIES` | `10000` | replay records |
| `OPENCHAMBER_PUSH_RELAY_REGISTER_LIMIT_PER_MINUTE` | `60` | register requests per client IP per minute |
| `OPENCHAMBER_PUSH_RELAY_SEND_LIMIT_PER_MINUTE` | `60` | send requests per client IP per minute |
| `OPENCHAMBER_PUSH_RELAY_SERVER_SEND_LIMIT_PER_MINUTE` | `120` | send requests per `serverId` per minute |
| `OPENCHAMBER_PUSH_RELAY_MAX_TOKENS` | `100000` | persisted device-token bindings |
| `OPENCHAMBER_PUSH_RELAY_MAX_IN_FLIGHT` | `64` | concurrent APNs deliveries |
| `OPENCHAMBER_PUSH_RELAY_APNS_KEY_ID` | required | Apple APNs key ID |
| `OPENCHAMBER_PUSH_RELAY_APNS_TEAM_ID` | required | Apple Team ID |
| `OPENCHAMBER_PUSH_RELAY_APNS_BUNDLE_ID` | `com.yee94.openchamber` | App bundle ID |
| `OPENCHAMBER_PUSH_RELAY_APNS_P8` | required unless path set | APNs `.p8` PEM |
| `OPENCHAMBER_PUSH_RELAY_APNS_P8_PATH` | unset | Path to the `.p8` file |

TestFlight and App Store Hosts use `OPENCHAMBER_APNS_ENVIRONMENT=production`. Each send request carries `env`; the Push process does not pick sandbox vs production itself.

## Operations

- `GET` and `HEAD` requests to `/healthz` return process health. `/readyz` returns ready status after the listener reaches running state.
- `SIGTERM` and `SIGINT` begin graceful Relay shutdown. Docker grants a 30-second stop period.
- Hosts automatically reconnect after a Relay process restart. Relay state remains ephemeral.
- Keep logs and metrics snapshots free of URL query strings, `sig`, `pk`, `grant`, encrypted payloads, APNs `.p8` material, and device tokens.
- Run one Push process per SQLite database file.

### systemd

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

Enable it:

```sh
sudo systemctl daemon-reload
sudo systemctl enable --now openchamber-relay
```
