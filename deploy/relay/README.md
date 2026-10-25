# Relay deployment assets

Run Compose from the repository root with `--project-directory .`. This keeps
the build context, local project name, `.env` lookup, and relative secret paths
rooted at the same location as before these files moved here.

```sh
docker compose --project-directory . -f deploy/relay/docker-compose.relay.yml up -d --build
```

Public Layer 1 and Layer 1 + Push deployments use the two `*.remote.yml` files.
Their explicit `yuri-relay` project name and named volumes are unchanged.
Configuration and full commands: [Relay server guide](../../packages/relay-server/README.md).

CI builds `deploy/relay/Dockerfile.relay` with the repository root as its context.
