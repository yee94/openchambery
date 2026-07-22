# OpenChamber Relay Server

`openchamber-relay` is the self-hosted Layer 1 relay for OpenChamber remote access. It gives OpenChamber Hosts an outbound Relay connection and carries encrypted client traffic through that connection.

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

## Requirements

- `@openchamber/relay-server` installation: Node.js 22 or later and a supported package manager such as npm, pnpm, yarn, or Bun.
- Single-file bundle build: Bun. This repository uses Bun 1.3.14.
- Public deployment: a DNS name, TLS certificate, reverse proxy, and firewall policy appropriate for the deployment.

## Install and quick start

`openchamber-relay` ships as an executable in the public `@openchamber/relay-server` package.

```sh
npm install -g @openchamber/relay-server
openchamber-relay --public-url wss://relay.example.com/ws
```

The default listener is `127.0.0.1:8787` and the default WebSocket upgrade path is `/ws`. Keep this loopback listener behind a TLS reverse proxy and set `--public-url` to the public `ws://` or `wss://` URL with the same path.

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

The executable remains independently deployable after compilation. `@openchamber/relay-server` owns its distribution and publishes the `openchamber-relay` executable.

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

## Connect OpenChamber Hosts

Set the public Relay URL in every OpenChamber Host environment, then start the Host and create a Relay pairing link or enable Relay pairing in the application.

```sh
export OPENCHAMBER_RELAY_URL=wss://relay.example.com/ws
openchamber
```

Saved candidates include an endpoint snapshot. Existing Clients use a candidate refresh or a new pairing flow to receive a changed Relay endpoint. Create a fresh pairing link when immediate endpoint replacement is required.

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
- Keep logs and metrics snapshots free of URL query strings, `sig`, `pk`, `grant`, encrypted payloads, pairing material, and bearer credentials.

## Docker delivery assets

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

## Development and test coverage

Run Relay package unit tests and Host/Client end-to-end coverage independently from the repository root:

```sh
bun test packages/relay-server/test
bun test packages/web/server/lib/relay/relay-server.e2e.test.ts
```

`packages/web/server/lib/relay/relay-server.e2e.test.ts` builds a compiled Relay executable and exercises a real Host and TypeScript Client across authenticated HTTP, streaming SSE, URL-token WebSocket traffic, Relay restart recovery, and cleanup. Use this E2E coverage when validating Relay transport changes.
