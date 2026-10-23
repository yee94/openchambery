# Session folders and order

Folder membership/collapse retains `/api/session-folders` and
`sessions-directories.json`. Session ordering uses `/api/session-folders/order`
and `session-order.json` independently so an older folder client cannot erase it.

GET returns `{ revision, sessionOrderByScope, sessionOrderActivityByScope }`.
POST replaces one scope using `{ scopeKey, order, activity, onlyIfAbsent? }`.
Directory paths identify ordinary lists; `__pinned__` identifies global pins.
Writes serialize per Host, merge other scopes, atomically rename the new file,
then broadcast `openchamber:session-order-changed` through the product SSE stream.
Last committed drag wins within a scope; independent scopes never replace each
other. A failed write leaves the previous file and emits no success event.
Missing files mean an empty initial catalog; malformed/unreadable files fail.

`onlyIfAbsent` imports pre-existing local ranks without overwriting a scope
already saved by another device. It does not bump revision or emit a tip when
the scope already exists. Local caches are startup continuity, not authority.
Clients fetch first and refetch on tips/reconnect/foreground through the shared
runtime HTTP/SSE transport (direct and Relay use identical routes).
