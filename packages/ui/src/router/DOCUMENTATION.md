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

The shared `useRouter` state bridge gives the active assistant/schedule primary
precedence over a retained new-session draft. Selecting an Assistant writes
`/assistant/$id`; initial links and browser Back/Forward restore that selection
without selecting an OpenCode session. Changing or clearing the Assistant drops
the previous Assistant's focused child-session suffix. Returning to Chat restores
`/session/new` when its draft is still open and no session is selected.
