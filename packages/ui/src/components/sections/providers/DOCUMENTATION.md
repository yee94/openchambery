# Provider connections

`ProvidersPage` preserves the shared Settings presentation. The runtime generation
and selected directory key its content lifetime, including credential drafts.

`providerConnectionQueries.ts` owns the TanStack Query snapshot for active providers
and the complete integration catalog, keyed by transport, generation, and directory.
Requests use the installed official OpenCode 2 client through `opencodeClient`, with
location and cancellation signals. The add-provider picker uses integrations whose
`connections` are empty and whose IDs do not start with `mcp_`. `provider.list`
supplies active-provider-to-integration mappings; model rows continue consuming the
config store's separately assembled model catalog. A failed refresh retains the
last snapshot and exposes an error.

API-key connection and disconnect mutations capture directory, transport identity,
runtime generation, and the mounted content's abortable lifetime. Every awaited
stage checks that capture before refreshing, notifying, selecting, or clearing busy
state. Key connection and integration lookup carry explicit `location`. OpenCode
2.0.12's `credential.remove` is runtime-global and accepts only `credentialID`;
disconnect takes those IDs from the scoped integration lookup and passes the
lifetime's AbortSignal to deletion. Successful mutations refresh the current
connection Query after scoped provider/model catalog refresh. These mutations
never call `/api/config/reload`, `location.reload`, or the service lifecycle.
Global credential and location provider/model events also refresh other loaded
directories through `sync/config-live-refresh.ts`. A complete empty catalog after
an explicit credential/domain refresh may clear the last disconnected provider;
bootstrap-empty and failed/partial reads retain their existing safeguards. Key connection
selects the refreshed provider's actual ID through its `integrationID` mapping.

`providerOAuth.ts` owns one attempt and its request/timer lifecycle:

- `auto` immediately reads `integration.oauth.status`, then polls pending attempts
  every 1.5 seconds. Only `complete` triggers provider configuration/catalog refresh.
- `code` sends `integration.oauth.complete` after a non-empty pasted code.
- Server failure, expiry, and transport failure clear local waiting state and show
  localized generic feedback. Raw OAuth errors and authorization URLs are excluded
  from diagnostic logs. URL/code display is transient, cleared on completion or exit.
- Startup has a 30-second bound; waiting uses the earlier of server expiry and a
  ten-minute client ceiling, including stalled status requests.
- Cancel, provider/directory navigation, replacement, and unmount abort requests,
  clear timers, and best-effort cancel the old attempt. A late connect response is
  cancelled when its original runtime is still current. Once runtime generation
  changes, no cancellation is sent through the newly active transport; the old
  server owns expiry. Stale callbacks cannot refresh or select in the new UI scope.
  Directory validity is checked at response time, including the window before
  React's unmount cleanup executes.
- Claude Code owns opening its own sign-in browser; its informational URL remains
  available for explicit opening.

OpenCode Go sign-in uses `getSignInIntegrationId`: `opencode-go` maps to the `opencode` Console integration. Go's own integration only accepts a service-account key, so Console OAuth never starts against `opencode-go`. An OAuth credential on `opencode` means the Go card already has Console credentials. Workspace ID and auth cookie saves stay on the quota credential route.

All shared runtimes use the same SDK state machine and `openExternalUrl` boundary.
Focused component tests cover catalog selection, pending-to-complete, pasted codes,
failure, expiry, timeouts, cancellation, unmount, stale connect/status responses,
provider changes, runtime/directory changes, API-key/disconnect late responses,
scoped cache refresh, ID mapping, and refresh failure. Browser verification against
a real isolated server is separate from mocked component success assertions;
third-party login/consent and credential persistence require a human authorization.
