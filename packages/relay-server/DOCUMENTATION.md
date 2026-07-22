# Relay Server Package Documentation

`packages/relay-server/` owns the self-hosted Layer 1 Relay server, the `openchamber-relay` CLI, and the package release and deployment contract.

## Purpose and security boundary

The Relay server brokers Layer 1 routing: Host control connections, client route requests, and matching Host data connections. It forwards opaque Layer 2/3 frames verbatim.

Host and Client terminate the E2EE channel. Each Host authenticates Relay connections with its long-lived P-256 signing key. Pairing secrets and client bearer credentials continue through endpoint validation; Relay reachability grants transport access.

Relay v1 admission accepts anonymous Client route requests. Per-IP, global, pending-connection, raw-socket, frame, and queue limits bound that public entry point. Configure limits for the expected traffic volume and keep the Relay behind TLS.

The Relay keeps process-local routing state only. Hosts reconnect after Relay restarts, and a control disconnect retains its Host route for the 30-second grace period.

## Quick deployment

Install the package, then start the Relay:

```sh
npm install -g @openchamber/relay-server
openchamber-relay
```

The default listener is `127.0.0.1:8787` and the WebSocket path is `/ws`. Deploy with the default loopback listener and a TLS reverse proxy. Set the public URL to the same public scheme, host, and path:

```sh
openchamber-relay --public-url wss://relay.example.com/ws
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

Run the Relay with `--public-url wss://relay.example.com/ws`. The `/ws` path in the public URL and Relay configuration must match. `proxy_set_header X-Forwarded-For $remote_addr;` replaces the inbound value with the single client source IP.

## Docker

From the repository root, build and start the supplied service. The compatibility assets are [`Dockerfile.relay`](../../Dockerfile.relay) and [`docker-compose.relay.yml`](../../docker-compose.relay.yml):

```sh
OPENCHAMBER_RELAY_SERVER_PUBLIC_URL=wss://relay.example.com/ws \
OPENCHAMBER_RELAY_PUBLISHED_PORT=8787 \
docker compose -f docker-compose.relay.yml up -d --build
```

Compose publishes `127.0.0.1:${OPENCHAMBER_RELAY_PUBLISHED_PORT:-8787}` by default; use `OPENCHAMBER_RELAY_PUBLISHED_PORT` to select the host port. The Compose service uses an ephemeral filesystem and keeps Host identity keys on each OpenChamber Host. Its image health check calls `GET /healthz`. Terminate public TLS at an external reverse proxy and publish `wss://relay.example.com/ws`. A public Relay port binding requires firewall rules and TLS; loopback publishing with a TLS reverse proxy is the deployment path.

## Connect Hosts

Set the Relay URL on every OpenChamber Host, start the Host, then generate a Relay pairing link or enable Relay pairing in the application:

```sh
export OPENCHAMBER_RELAY_URL=wss://relay.example.com/ws
openchamber
```

Saved candidates contain an endpoint snapshot. Existing clients switch to this Relay after a new pairing flow or a candidate refresh; generate a fresh pairing link when immediate endpoint replacement is required.

## Configuration

Configuration precedence is command flags, then `OPENCHAMBER_RELAY_SERVER_*` variables, then defaults. `--host`, `--port`, `--path`, `--public-url`, `--trust-proxy`, `--no-trust-proxy`, `--json`, and `--quiet` are available.

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

## Operations

- `GET` and `HEAD` requests to `/healthz` return process health. `/readyz` returns ready status after the listener reaches running state.
- `SIGTERM` and `SIGINT` begin graceful Relay shutdown. Docker grants a 30-second stop period.
- Hosts automatically reconnect after a Relay process restart. Relay state remains ephemeral.
- Keep logs and metrics snapshots free of URL query strings, `sig`, `pk`, `grant`, and encrypted payloads.

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
