# Router agent browser E2E (CDP / opencli)

Path-mode navigation acceptance for OpenChamber web. **No Playwright** — drive Chrome via CDP (`--remote-debugging-port`) or opencli bridge.

## Prerequisites

1. OpenChamber web dev/server reachable (example: `bun run dev` → loopback UI).
2. Chrome with remote debugging:

```bash
/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome \
  --remote-debugging-port=9222 \
  --user-data-dir=/tmp/openchamber-router-e2e \
  "http://127.0.0.1:4096/"
```

Optional: `export CDP_ENDPOINT=http://127.0.0.1:9222`

## Scenario checklist (must all pass)

| ID | Steps | Expect |
|---|---|---|
| E1 | Cold open app root | Final URL is path form (`/`, `/new`, or `/session/…`) — **not** `?session=` |
| E2 | Open an existing session from sidebar | `pathname` = `/session/{id}`; chat visible |
| E3 | Switch to Diff and select a file | `pathname` includes `/diff`; search has `file=` |
| E4 | Open Settings → Providers | `pathname` = `/settings/providers` (or `/settings/…`) |
| E5 | Close Settings | Returns to previous workspace path; session still selected |
| E6 | Browser Back after E2→E3 | Previous path restored |
| E7 | Hard reload on `/session/{id}` | Same session still selected (index loaded) |
| E8 | Visit `/mcp/oauth/callback` | OAuth page (not swallowed as session route) |
| E9 | Navigate to `/session/{id}/not-a-tab` | Falls back to chat for that session (no white screen) |

## Agent runbook

1. Start server + Chrome CDP.
2. Attach via CDP WebSocket (or opencli).
3. For each scenario: `Page.navigate` / click → `Runtime.evaluate` → read `location.pathname + location.search`.
4. Assert **no** business query keys: `session`, `tab`, `settings` as route params.

### Suggested evaluate snippet

```js
() => ({
  href: location.href,
  pathname: location.pathname,
  search: location.search,
  hasLegacySessionQuery: new URLSearchParams(location.search).has('session'),
  hasLegacyTabQuery: new URLSearchParams(location.search).has('tab'),
  hasLegacySettingsQuery: new URLSearchParams(location.search).has('settings'),
})
```

## Script entry

```bash
bun run e2e:router:check   # static scenario contract (no browser)
# Full browser run is agent/CDP manual until CI CDP harness lands
```

See `scenarios.json` for machine-readable steps.
