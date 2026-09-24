# Browser provider UI seam

Settings and the right sidebar consume the browser-provider host in
`packages/web/server/lib/browser-provider`. They do not execute browser
actions and they do not invent a built-in connected browser.

## Host routes

The host owns the catalog, the saved selection, and agent action routing.
UI calls the first two routes through `runtimeFetch`:

- `GET /api/browser-providers`
  - `200` `{ providers: [{ id, name, surface }], selectedId }`
  - `selectedId` is null unless it names a listed provider.
  - `200` with `providers: []` is a successful empty catalog. The selector and
    the rail stay hidden. That is not a connected browser.
  - `503 CATALOG_UNAVAILABLE` and VS Code `501 UNSUPPORTED` are failures. The
    UI keeps the last good snapshot and does not replace it with an empty
    connected choice.
- `PUT /api/browser-providers/selection` with `{ id }`
  - `200` `{ selectedId }` naming that same id.
  - A refused write leaves the previous choice in place. The host persists the
    id; the UI does not keep a second copy.

Provider ids match `^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$`. This host always
reports `surface: false`. The rail must not open a picture socket for that
row. A later host that sets `surface: true` is the only reason the sidebar
opens `WebSocket /api/browser-providers/:id/surface/ws`.

## Live view

While `surface` is false, selecting a provider shows an empty rail state, not
a canvas and not a takeover control. Input and `release` are sent only after
the host reports a surface and a frame. Handing back is a surface message; it
does not run a second browser executor. Agent actions stay on
`POST /api/browser-providers/actions`, which this UI does not call.
