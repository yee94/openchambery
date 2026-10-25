---
name: ui-api-decoupling
description: Use when creating or modifying Yuri shared UI data access, React Hooks, `@tanstack/react-query`, query keys/cache/invalidation, `@reactuses/core`, browser Hooks, OpenCode SDK calls, `RuntimeAPIs`, runtime fetch/auth/URLs, authenticated browser assets, bridges/proxies, runtime switching, or server API routes.
---

# UI API Decoupling

## Core Boundary

- Official OpenCode API calls use `@opencode-ai/sdk/v2` through `opencodeClient`.
- Yuri-owned HTTP capabilities use `RuntimeAPIs` where runtime-specific behavior exists, otherwise explicit Yuri routes through `runtimeFetch`.
- Browser/realtime consumers use shared runtime URL/socket helpers.
- Shared UI never hardcodes localhost, ports, API origins, credentials, or one runtime's transport assumptions.

## State Ownership

| State or boundary | Owner |
|---|---|
| Runtime-scoped pull server state | TanStack Query |
| Standard browser, DOM, event, timer, observer, and storage interaction | `@reactuses/core` |
| UI selection, draft, and mutation orchestration | Zustand or component state |
| Realtime push state | Sync and relay transport |
| Cross-runtime capability and HTTP boundary | `RuntimeAPIs` and `runtimeFetch` |

Use `useEffect` for external-system synchronization. Calculate derived values during render. Trigger mutations from event handlers. Load `sync-state-invariants` for synchronization lifecycles and `performance-engineering` for high-volume or hot paths.

## TanStack Query

### Layering

- Define a query-options factory for each resource, a React `useQuery` Hook for component consumers, and imperative snapshot, ensure, and refresh functions for non-React consumers.
- Build every query key from transport identity, then normalized directory, path, provider, and request options that affect the result.
- Pass the query `signal` through every SDK or runtime request. Let `queryFn` throw transport failures.
- Treat an unknown cache entry as incomplete: ensure or fetch it before evaluating an empty result.
- Capture transport identity and scope when starting a mutation. Apply precise `setQueryData` updates and targeted invalidation on completion.
- Clear the `QueryClient` when runtime identity changes.
- Bind paginated requests to a generation and cursor; discard stale completions from an earlier generation.
- Components use declarative Hooks. Non-React paths use the `QueryClient` imperative API.

### Mutation and Cache Semantics

- Preserve the previous snapshot through a failed refresh and expose the failure separately from a successful empty response.
- Update Diagram and Plan cache entries after confirmed write success. Serialize Plan writes by document identity and drain each identity in order.
- Carry the VS Code directory through query options, keys, and transport calls.

## `@reactuses/core`

- `@reactuses/core` is installed. Import Hooks as named exports from the package root.
- Reuse its standard Hooks for browser, DOM, events, timers, observers, storage, debouncing, and stable callbacks after verifying the installed version's exports, SSR fallback, cleanup behavior, and return shape.
- Project-appropriate candidates include `useEventListener`, `useClickOutside`, `useResizeObserver`, `useScrollLock`, `useMediaQuery`, `useNetwork`, `useDebounce`, `useDebounceFn`, `useTimeoutFn`, `useInterval`, and `useEvent`.
- Shared UI never uses `React.useCallback` or `useCallback`. Event handlers and callbacks passed to child components or external subscriptions with stable identity requirements use `useEvent`.
- Render-phase selectors, synchronous derived calculations, and callback factories use `useMemo`, module-level pure functions, or ordinary functions. `useEvent` serves event-time callbacks because its latest implementation changes during the layout phase.
- Effect rerun conditions express their real semantic dependencies. `useEvent` identity never controls an effect's rerun condition.
- Keep server state in TanStack Query, global UI/app state in Zustand, and IPC/SSE behavior in runtime and sync modules.

### Callback boundaries on high-frequency paths

Apply these rules when an input, streaming update, or timer can rerender a caller:

1. **Classify invocation time.** Use `useEvent` for callbacks invoked after commit by user actions or external events. Keep render-time selectors, render props, and calculations as ordinary functions or `useMemo`; they need the current render's values.
2. **Stabilize the actual boundary.** Pass the `useEvent` result directly to an identity-sensitive child or subscription. An inline adapter such as `onInsert={(text) => handleTranscript(text, true)}` creates a new prop even when `handleTranscript` is stable; give the adapter its own `useEvent`.
3. **Isolate unrelated work.** Keep high-frequency state with its owner and subscribe to narrow fields. For an independent leaf under an updating parent, use an evidenced memo boundary with stable props. Check callback, object, array, and JSX props together; one fresh prop defeats the boundary. Local state and relevant context/store updates must still reach the leaf.
4. **Let the listener Hook own freshness.** `useEventListener` already forwards to the latest handler. Inline handlers at that Hook are valid; adding another `useEvent` solely to prevent listener reattachment is redundant. Subscription lifetime follows the actual event, target, and options. Custom subscription Hooks should likewise separate callback freshness from resource lifetime.
5. **Account for Hook work.** `useEvent` uses a layout effect to update its latest handler; it is not a zero-effect primitive. Prefer it over hand-written callback-ref synchronization, but first eliminate unrelated leaf renders. Keep Effects that synchronize real external resources and express their semantic dependencies; never hide a required reconnect or reconfiguration behind a stable callback.
6. **Guard the call site.** On hot-path boundary changes, test at least 50 unrelated parent updates with zero unrelated leaf Hook/subscription work, then verify that callbacks see the latest committed state and owner changes perform the required cleanup/rebind. Test the production JSX boundary so a new inline adapter cannot silently invalidate the guard. Composer timing and scale gates remain in `packages/ui/src/composer/DOCUMENTATION.md#input-responsiveness-contract`.

```tsx
const MemoSpeechControls = React.memo(SpeechControls);

function Composer() {
    const finishSpeech = useEvent((text: string) => applyTranscript(text, true));
    return <MemoSpeechControls onInsert={finishSpeech} />;
}
```

Native DOM event props and Hooks that already own handler freshness do not need a blanket inline-function ban. ESLint dependency checks cannot prove callback stability across components or zero per-keystroke work; use the operation-count guard and browser measurements above.

Reference: [ReactUse useEvent](https://reactuse.com/effect/useevent/). Check the installed implementation when choosing a Hook; stable callback identity and avoiding renders are separate guarantees.

## Refactor Patterns

- Query owns pull state for Agents, Commands, Skills, MCP, Plugins, GitHub, Files, and Plans. Store-owned loaders and effects retain UI synchronization responsibilities.
- Stores retain UI state and mutation orchestration.
- Batch metadata requests to remove per-entity metadata fanout.
- Ensure the slash-command query before reading a cold cache.
- Preserve prior snapshots across failures and represent successful empty results distinctly.
- Apply Diagram and Plan cache updates after confirmed writes; serialize Plan operations by document identity.
- Pass VS Code directories through the complete query and transport path.

## Anti-Patterns

| Pattern | Required implementation |
|---|---|
| Store loader or component effect fetches pull state | Query options factory, `useQuery`, and imperative Query helpers |
| Cache read treats an unknown entry as empty | Ensure or fetch before interpreting the result |
| Mutation refreshes every resource | Capture transport and scope, then update or invalidate the affected query key |
| Refresh failure clears displayed data | Preserve the prior snapshot and surface the failure |
| Per-entity metadata requests | Batch metadata by resource scope |
| Plan writes complete out of order | Serialize and drain by document identity |
| Runtime or directory switch reuses cached identity | Key by normalized scope and clear the `QueryClient` on runtime change |

## Classify First

| Need | Correct path |
|---|---|
| Official OpenCode endpoint | `opencodeClient` or its SDK client |
| SDK gap for official OpenCode | Narrow documented wrapper in `opencodeClient` preserving request fidelity |
| Yuri HTTP route | `runtimeFetch('/api/...')` |
| Runtime-owned capability | Extend `RuntimeAPIs` and implement each applicable runtime |
| Browser-owned authenticated URL | Runtime URL resolver and scoped URL auth |
| SSE/WebSocket | Owning realtime transport; also load `relay-transport` |

## Load References By Task

| Task | Required reference |
|---|---|
| Iframes, downloads, raw images, object URLs, URL tokens, preview proxy/subresources | `references/browser-assets-and-auth.md` |
| Adding runtime capabilities, VS Code behavior, Electron privilege/security, unsupported runtime behavior | `references/runtime-parity.md` |
| Locating implementations, route registration, runtime switching, or focused tests | `references/implementation-map.md` |

Load every matching reference before editing.

## Mandatory Rules

1. **Do not bypass the SDK for official OpenCode APIs.** Preserve SDK-generated method, body, headers, query, auth, and abort signal.
2. **Keep Yuri routes explicit.** Register them before the generic OpenCode proxy.
3. **Use runtime APIs for runtime-owned capabilities.** Components consume hooks/providers, not runtime globals.
4. **Resolve runtime state at call time.** Do not cache runtime base URLs, resolver output, credentials, or SDK clients across endpoint switches.
5. **Let transport own auth.** HTTP uses runtime bearer handling; browser/realtime URLs use scoped short-lived URL auth where headers are impossible.
6. **Never put long-lived client credentials in URLs.** Do not manually append URL tokens.
7. **Define runtime parity explicitly.** Shared UI needs deliberate web, Electron, VS Code, hosted-mobile, and Capacitor behavior or stable unsupported responses.
8. **Authoritative fetches must signal failure.** Do not convert failure into a valid empty value that callers use to clear state.
9. **Keep privileges at the native/runtime boundary.** UI visibility and prompts are not authorization.
10. **Confirm trust-boundary mutations.** Host imports, credential writes, privileged deep links, and runtime switching require explicit user intent.

## HTTP Decision Rules

Pass route paths directly to `runtimeFetch`:

```ts
await runtimeFetch('/health');
await runtimeFetch('/api/config/settings');
await runtimeFetch('/api/fs/raw', { query: { path } });
```

Do not immediately fetch a URL produced by `getRuntimeUrlResolver()`. Use the resolver only when the browser/realtime API itself consumes the URL:

```ts
const iframeSrc = getRuntimeUrlResolver().authenticatedAsset('/api/preview/frame');
const eventUrl = getRuntimeUrlResolver().sse('/api/event');
```

Plain `fetch` is reserved for intentional external origins that are not the active Yuri/OpenCode runtime.

## Runtime Switch Safety

Review runtime base URL, auth, SDK clients, terminal/realtime transports, stores, session memory, and caches. Key caches by runtime identity where IDs, paths, or URLs can collide. Reset or reconnect affected state through the established runtime-switch flow.

## Common Anti-Patterns

| Avoid | Use |
|---|---|
| Raw feature `fetch` to official OpenCode | SDK wrapper/client |
| Component reads runtime globals | `useRuntimeAPIs()` / provider |
| Hardcoded runtime URL | `runtimeFetch` or runtime URL resolver |
| Browser URL containing bearer/client token | Scoped URL-auth helper |
| Web-only shared route | Explicit VS Code/mobile decision |
| Returning `[]` after authoritative fetch failure | Throw or distinct failure result |
| Rebuilding SDK `Request` from URL only | Preserve original request body/headers/signal |

## Verification

- Official calls use SDK paths or documented SDK-gap wrappers.
- Yuri routes win before generic proxy fallback.
- Request fidelity, auth, abort, query, and body behavior are tested.
- Browser/realtime auth uses narrow allowlists and scoped tokens.
- Every applicable runtime has implementation or explicit unsupported behavior.
- Runtime switching cannot reuse stale endpoint/auth/cache state.
- Privileged Electron/extension behavior is enforced outside the renderer.
- Focused query tests cover query keys, option factories, signals, cache updates, invalidation, mutation refresh, and cold-cache and warm-cache reads.
- Failed refreshes preserve stale snapshots, and successful empty responses clear state intentionally.
- Runtime and directory switch tests include VS Code directory propagation.
- Affected paths cover Web, VS Code, and mobile parity.
- Load `sync-state-invariants` for realtime reconciliation tests and `performance-engineering` for batching or high-frequency performance validation.
- Focused transport, bridge, proxy, auth, and runtime tests pass; static type/lint checks alone are insufficient.
