# Browser Provider Host

## Purpose

An installed extension can declare that it provides `browser`. Agent `browser.*`
actions then go to that extension, and the host adopts the extension's result.
This fork has no `packages/sdk` and no guest process platform, so this module is
the minimal host: recognize the declaration, list reachable providers, send one
action to the selected provider, and refuse when none is selected.

It does not render a settings dropdown, a live rail, or takeover / handoff.
Those belong to a later surface that calls this contract.

## What this fork does not do

- It does not spawn extension processes, approve capabilities, or proxy a guest panel.
- It does not drive the in-app browser pane. No provider means the action is
  refused. The pane's existing behavior is unchanged because this module never
  calls it.
- It does not persist the installed-extension catalog. Registration is
  in-process. The selected id is persisted; the extension must be registered
  again after a restart before that id is listed or used.
- It does not write `browser.capture` images to disk. The extension's `data` is
  returned as-is.

## Declaration

An extension declares the role with the first array among:

1. `service.provides`
2. `provides`
3. `contributes.service.provides`

`"browser"` in that array is the declaration. A service array that does not
include `browser` is not a browser provider, even if another field says it is.
The host recognizes that declaration with `extensionDeclaresBrowser`.

Registration is in-process, not an open HTTP install route (an endpoint field
would otherwise be a client-controlled fetch):

```js
getBrowserProviderHost().install({
  id: 'server-chrome',
  name: 'Server Chrome',
  service: { provides: ['browser'] },
  answer: async (request) => ({ ok: true, data: { url, title } }),
  // or endpoint: 'http://127.0.0.1:9'  → POST /browser-control
});
```

`answer` wins when both are set. `endpoint` must be loopback `http:` or
`https:` with no userinfo. A bare origin is posted to `/browser-control`.
A disabled extension, a missing id, or a declaration with no way to answer is
rejected and not listed.

## Agent action

`host.dispatchAgentBrowserAction({ action, parameters, context, providerId, signal })`
is the agent entry. `providerId` overrides the stored selection for that call
only. Otherwise the stored selection is used. The model does not supply
`context`; callers pass `{ directory, sessionId }`, each `null` when unknown.

The extension receives:

```json
{
  "requestId": "…",
  "action": "browser.click",
  "parameters": { "selector": "#save" },
  "context": { "directory": "/repo", "sessionId": "ses_1" }
}
```

It answers `{ "ok": true, "data": { } }` or `{ "ok": false, "error": "…" }`.
`data` is what the agent gets. `ok: false` is the agent-visible error, not an
empty success. A missing, non-JSON, or non-200 answer is unknown page state.
A call that was sent and then lost may have run; a call that never left the
host did not.

Actions: `browser.open`, `browser.snapshot`, `browser.click`, `browser.type`,
`browser.scroll`, `browser.back`, `browser.forward`, `browser.inspect`,
`browser.capture`, `browser.resize`. Parameters are validated before send.
`browser.open` waits 45s; other actions wait 20s.

## HTTP contract

Registered on the web server before the generic OpenCode proxy. The global
`/api` auth gate already covers these routes; this module does not add a second
one. Web, Electron
(in-process server), hosted mobile, and Capacitor mobile use these routes.
VS Code returns **501** `{ ok: false, code: "UNSUPPORTED", error }` for the
same paths and does not proxy them. That is not an empty catalog.

Settings and the rail call the first two routes. Provider ids match
`^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$`. `surface` is always `false` here: this
host does not push a live picture, and reporting `true` would open a socket
that does not exist.

| Call | Success | Refusal |
|---|---|---|
| `GET /api/browser-providers` | `200 { providers: [{ id, name, surface: false }], selectedId }` | `503 { error, code: "CATALOG_UNAVAILABLE" }` — never `providers: []` |
| `PUT /api/browser-providers/selection` body `{ id }` | `200 { selectedId }` naming that same id | `404 PROVIDER_NOT_FOUND`, `400 INVALID_SELECTION`, or `503 SELECTION_UNAVAILABLE`; selection unchanged |
| `POST /api/browser-providers/actions` body `{ action, parameters?, context?, providerId? }` | `200 { ok: true, providerId, data }` | `ok: false` plus `code` — never `{ ok: true, data: {} }` |

`selectedId` is `null` unless it names a provider in `providers`. A saved id
for an extension that is not installed right now is kept on disk but not
reported as connected. The selection file is
`browser-provider-selection.json` under the OpenChamber data dir and stores
only `{ selectedId }`. A missing file is no selection. A read or write failure
is not an empty catalog and does not change the previous choice.

No endpoint, handler, or credential is returned.

Action codes:

| code | status | meaning |
|---|---|---|
| `NO_PROVIDER` | 409 | nothing selected; nothing ran |
| `PROVIDER_NOT_FOUND` | 404 | id is not a reachable provider; nothing ran |
| `CATALOG_UNAVAILABLE` | 503 | catalog read failed; nothing ran |
| `INVALID_ACTION` | 400 | action or parameters rejected; nothing sent |
| `PROVIDER_REJECTED` | 400 | extension `ok: false`; `error` is the extension text |
| `UNKNOWN_RESULT` | 502 | answer was not a browser result; page state unknown |
| `REQUEST_FAILED` | 504 | sent, no usable answer; may have run |
| `PROVIDER_UNAVAILABLE` | 503 | never sent |
| `CANCELLED` | 499 | cancelled before send |
| `UNSUPPORTED` | 501 | VS Code only |

An empty `providers` array with status 200 means the catalog was read and no
reachable browser provider is installed. That is not a connected browser.

## Invariants

- No selected provider does not fall through to the in-app pane and does not
  return success.
- A catalog read failure is not "no providers" and does not run the action.
- The extension is re-read from the catalog on every action. A stale selection
  that is no longer listed fails; it is not silently retargeted.
- Choosing an unknown id does not clear a previous valid selection.
- Failure after the request was handed to the extension is not described as
  "nothing changed".
