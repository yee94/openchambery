# Local HTTPS proxy

`Caddyfile` is an optional local development example: it forwards port 3443 to
`[::1]:3001` using certificates at `/tmp/localhost.crt` and `/tmp/localhost.key`.
Adjust the upstream and certificate paths for your local setup. From the
repository root, pass `--config deploy/dev/Caddyfile` when starting Caddy.
