# App Router — product navigation

## Top-level exclusive primaries

These are **siblings**, not children of a session:

| Primary | Path | Main column |
|---|---|---|
| **session** | `/session/$id` · `/session/$id/plan` · `/session/$id/{git,diff,…}` | Chat + optional tool |
| **new session** | `/session/new` (alias `/new`) | Welcome / draft composer (no real session id) |
| **schedule** | `/schedule` · `/schedule/history` · `/schedule/tasks/$p/$t` · `…/agent/$focus` | Schedule workspace only |
| **assistant** | `/assistant` · `/assistant/$id` · `…/agent/$focus` | Assistant workspace only |
| **settings** | `/settings/$slug[/$entity]` | Settings overlay only |

**Invalid product URLs (must not be written):**

- ~~`/session/$id/schedule`~~
- ~~`/session/$id/assistant`~~

Legacy nested forms still **parse** into top-level `schedule` / `assistant` kinds; all **writes** use top-level paths.

## Mutual exclusion

At most one of: session shell · plan · schedule · assistant · settings  
MainLayout never keep-alive-mounts Chat under schedule/assistant/plan.

## Session tools only under session

`git | diff | terminal | files | diagram | plan` live under `/session/$id/…`.

## API

```ts
buildSchedulePath()      // → /schedule
buildAssistantPath()     // → /assistant
buildSessionPath({ sessionId, tab: 'git' })  // → /session/$id/git
// buildSessionPath({ tab: 'schedule' }) redirects to buildSchedulePath()
```

`createAppNavigation`: `goSchedule()` / `goAssistant()` / `goSession()`.

Individual tasks use `/schedule/tasks/$projectId/$taskId`. The scheduled workspace
restores the composite identity on initial load and browser Back/Forward; list
selection, save, and editor dismissal write the matching task/list path.
`openScheduledTask` is the shared Assistant card/Settings-row entry. It also
queues a transient UI open request for already-mounted workspaces and URL-disabled
hosts (VS Code/embedded); the active host consumes it once, without persisting it.
Mobile task links and list selections open the shared `MobileResizableSheet`,
including cold links. Desktop retains the workspace detail panel. Missing tasks
and failed project loads retain the requested identity and show unavailable/retry,
never an empty create form. The sheet's close and drag-dismiss share the dirty-draft guard.

The shared `useRouter` state bridge gives the active assistant/schedule primary
precedence over a retained new-session draft. Selecting an Assistant writes
`/assistant/$id`; initial links and browser Back/Forward restore that selection
without selecting an OpenCode session. Changing or clearing the Assistant drops
the previous Assistant's focused child-session suffix. Returning to Chat restores
`/session/new` when its draft is still open and no session is selected.
