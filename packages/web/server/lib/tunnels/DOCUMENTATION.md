# Tunnels Module Documentation

## Purpose
This module contains tunnel provider orchestration for OpenChamber, including provider registry/service wiring, managed remote token config lifecycle, and tunnel HTTP route registration.

## Entrypoints and structure
- `packages/web/server/lib/tunnels/index.js`: tunnel service orchestration.
- `packages/web/server/lib/tunnels/executable-search.js`: cross-platform executable discovery, including Windows Store app aliases.
- `packages/web/server/lib/tunnels/registry.js`: provider registry.
- `packages/web/server/lib/tunnels/managed-config.js`: managed remote tunnel token/preset persistence runtime.
- `packages/web/server/lib/tunnels/install-help.js`: provider/platform install command metadata for missing tunnel dependencies.
- `packages/web/server/lib/tunnels/routes.js`: tunnel API route registration and request orchestration runtime.
- `packages/web/server/lib/tunnels/types.js`: tunnel constants, normalization, and shared type helpers.
- `packages/web/server/lib/tunnels/providers/cloudflare.js`: Cloudflare tunnel provider implementation.
- `packages/web/server/lib/tunnels/providers/ngrok.js`: Ngrok quick tunnel provider implementation.
- `packages/web/server/lib/tunnels/providers/hapi.js`: HAPI/tunwg provider. The UI supplies the relay service hostname; the PC automatically forwards the active OpenChamber listen port. Persistent tunwg keys live under the OpenChamber data directory so the assigned public URL can survive restarts.

## Public exports (routes.js)
- `createTunnelRoutesRuntime(dependencies)`: creates tunnel routes runtime and helpers.
- Returned API:
  - `registerRoutes(app)`
  - `startTunnelWithNormalizedRequest(request)`
