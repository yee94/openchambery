# Component render counts

Run with Bun against a development build exposing the React render entry points:

```sh
bun scripts/perf/component-render-probe.mjs --url="$SESSION_URL" --out="$COLD_REPORT"
bun scripts/perf/component-render-probe.mjs --url="$SESSION_URL" --pre=25000 --out="$WARM_REPORT"
bunx vitest run --project @yuriai/ui packages/ui/src/components/ui/componentRenderCounter.test.ts
```

Each run uses an isolated Chromium profile. The probe waits until the transcript is
visible, waits the optional `pre` interval, starts counting, waits 600ms, dispatches
40 upward wheel steps and 25 downward steps (120px, 60ms apart), then waits 800ms.
Cold therefore means the early visible-transcript window, not all calls since
navigation. Run scenarios serially after edits/builds settle.

Pass `--settle=2000` to measure a separate idle window immediately afterward.
The original wheel sequence and 800ms finish remain unchanged. `settled` records
the additional render calls, mounts and requests; report it separately whenever
quiet-window adoption moves work to the end of the primary window. A reduction
in that primary window alone does not establish less total adoption work.
Request diagnostics include HTTP methods and anonymous directory scope numbers,
so different projects are not mistaken for repeated requests for one project.

For repeated comparisons, run each cold configuration at least three times and
report medians and ranges; retain `pre=25000` warm samples. Every report checks the
final pathname, records final rows/messages/users, DOM message mounts (including
nodes already present at the start), unique message/user counts, virtualization
transitions, and 50-message/network request timing relative to the count window.
Normalize each transcript count by that run's DOM message mounts before taking
the median. This denominator includes remounts and differs from unique IDs or the
final visible window. Keep these figures together; normalization alone does not
remove the cost difference between normal flow and virtualization.

Hydration diagnostics compare provider props/child prop identities and aggregate
the changed prop names. They retain no message text. Historical reports without
DOM/network evidence cannot be retroactively normalized or causally attributed.

The CDP response transform adds counters immediately before React invokes function
components and class `render()`. It never edits the installed React package. A run
requires exactly one function entry and one class entry, a nonempty result and zero
missing Fibers; an unsupported bundle fails instead of reporting a misleading zero.
Calls include StrictMode repeats and interrupted/retried renders. Host DOM elements,
memo bailouts and React's built-in Fiber operations are not component calls.

Region attribution follows the closest named ancestor: SessionSidebar/Sidebar owns
`sidebar`; MessageList/ChatViewport/ChatInput owns `transcript`; other components
belong to `other`. Portals retain their React ancestry. Reports aggregate by region
and component name; anonymous or identically named components share an entry.
This is a development render-call metric, not a production timing profile.

The independent verifier instruments Node's React load in memory and compares
against counters inside actual components: memo leaf and nested bailouts are 0/0,
50 leaf updates are 50/50, 50 nested updates are 100/100, and StrictMode with
forwardRef/class calls is 6/6. A walk of committed Fiber flags is unsuitable because
bailouts may retain flags from an earlier render.

Render counts do not validate scroll correctness. Use the transcript's frame/visual
probes separately for passive displacement and transient flashes. Report each region
and the total, including increases; a lower sidebar count alone does not establish
a lower whole-page count. Preserve the requested reference and scenario instead of
silently replacing it after a different startup or pagination schedule.
