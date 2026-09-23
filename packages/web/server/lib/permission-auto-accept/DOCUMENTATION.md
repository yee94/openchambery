# Permission Auto-Accept

## Purpose

This module owns the authoritative permission auto-accept policy for web, desktop, and mobile runtimes. Policy is persisted in OpenChamber settings so permission handling survives UI disconnects and server restarts.

## Policy

`permissionAutoAccept.sessions` contains explicit per-session boolean policies.

Policy inheritance uses the nearest explicit session value. A child `false` therefore overrides a parent `true`. Sessions with no explicit value, including a missing ancestor lookup, default to allow. A failed settings load still fails closed and does not approve.

## Runtime

`createPermissionAutoAcceptRuntime` loads and serializes policy writes, subscribes to the global OpenCode event hub, caches session lineage, retries transient replies, and reconciles pending permissions after startup, reconnect, and policy enablement. Pending requests are listed at `GET /permission/request` and approved with `POST /session/:sessionID/permission/:requestID/reply` body `{ decision: "always" }`. OpenCode 2.0.12 rejects the legacy `{ reply }` body and the unscoped `/permission/:id/reply` path.

A failed settings load fails closed and does not approve. A failed pending-permission fetch is distinct from an empty successful response and never clears policy state.

## Routes

- `GET /api/permission-auto-accept`
- `PUT /api/permission-auto-accept/sessions/:sessionId`

These are normal authenticated OpenChamber runtime routes. They must not be added to browser URL-token allowlists.

## UI ownership

`packages/ui/src/stores/permissionStore.ts` is a projection of server policy and does not persist an independent policy. The server is the sole responder and the UI renders pending requests until the authoritative `permission.replied` event arrives.

`ChatInput` derives control visibility from the persisted, directory-scoped `useConfigStore` agent snapshot via `shouldShowPermissionAutoAcceptControl`. It reads the V2 wire `permissions` field when present (OpenCode `AgentInfo.permissions`), otherwise the legacy singular `permission` document. Rule normalization reuses `toPermissionRuleset` so both V2 `{ action, resource, effect }` and V1 `{ permission, pattern, action }` / tool-map shapes are recognized. A selected agent with a final global `allow` or `deny` rule has no remaining prompt path and hides the control. Unknown snapshots, missing selected agents, unparseable rules, and rules that can still ask keep the control visible. This path issues no additional request and does not change server auto-accept policy.

VS Code retains its foreground-only implementation because it does not run the web server runtime (`isVSCodeRuntime()` always shows the control).

## Tests

`runtime.test.js` covers restart persistence, nearest explicit subagent inheritance, missing-lineage lookup, retry/deduplication, and reconnect reconciliation. `packages/ui/src/components/chat/permissionAutoAccept.test.ts` covers permission configuration normalization and visibility decisions.

```sh
bunx vitest run --project @openchamber/web packages/web/server/lib/permission-auto-accept/runtime.test.js
bunx vitest run --project @openchamber/ui packages/ui/src/components/chat/permissionAutoAccept.test.ts
```
