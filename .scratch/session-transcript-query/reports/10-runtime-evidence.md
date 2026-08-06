# Ticket 10 — Runtime reconnect & performance evidence

**Ticket:** `10-runtime-reconnect-performance-validation`  
**Date:** 2026-08-06  
**Scope:** Validation-only. No production cutover changes.  
**Evidence sources:** focused unit/runtime tests (in-process), not live platform shells.

---

## 1. Deterministic long-gap runtime scenario

**Source:** `packages/ui/src/sync/session-transcript-long-gap.runtime.test.js`  
**Stack (real seams, test-local wiring):**

- `QueryClient` (`@tanstack/react-query`)
- `createQueryTranscriptRepository`
- `createTranscriptReconnectCompensationController`
- Host `createSessionReconcileService` (`packages/web/server/lib/session-turn-pages/reconcile.service.js`)

**Scenario controls:**

- `pageRecordLimit=4` forces first reconcile round past a single page → signed `ocr2.*` continuation.
- Host holds turns through `msg_01`…`msg_10` after disconnect (client starts with anchor turn only).
- On the **first** round-completion latest-head probe, Host appends a new turn (`msg_11`/`msg_12`) so `capturedHead != latestHead`, forcing a **second-round** latest-head chase.

**Observed terminal state (assertions):**

| Check | Result |
| --- | --- |
| Message IDs | 12 unique IDs, full order `msg_01`…`msg_12` |
| Parts | Every message has ≥1 part; text parts present |
| Pagination / cursor | `boundary.kind === "has-more"`; initial authoritative cursor retained |
| Checkpoint | `state === "complete"`; `continuation === null`; heads converge on chase head |
| Controller flight | `isSessionInFlight === false` (flight=0) |
| Query fetching | related transcript queries + `client.isFetching()` = 0 |
| Reconcile task | terminal `status === "complete"` |

Continuation tokens observed in the call log start with `ocr2.`. Anchor-bearing requests ≥2 (multi-round).

---

## 2. `resetRequired` → destructive tail

Same runtime harness; two Host-driven paths:

### 2a. Anchor missing

- Client holds old chain + has-more cursor; Host transcript no longer contains the checkpoint anchor.
- Host returns `resetRequired`.
- **Result:** old chain cleared; new authoritative tail present; task status includes `reset`; controller flight=0; Query fetching=0; checkpoint cleared after successful destructive ensure.

### 2b. Total page budget

- Anchor never appears within Host `totalPageLimit` (with tight page/total budgets).
- First response may still emit `ocr2` continuation; subsequent page promotes `resetRequired`.
- **Result:** old chain cleared; rebuilt tail in effect; task reset; flight/fetching=0.

Both paths assert destructive tail rebuild, not soft merge of the stale chain.

---

## 3. Replay-before-ready / `isReconnect`

**Source:** event-pipeline tests (`packages/ui/src/sync/__tests__/event-pipeline.test.js`, related pipeline suites).

Recorded contracts:

- Replay events flush **before** the ready compensation trigger.
- One compensation trigger per ready barrier.
- Clean first ready: `isReconnect: false` (gap compensation skipped).
- Real reconnect ready: `isReconnect: true` (Query compensation path armed after replay).

---

## 4. SSE / pipeline operation counts

### 4a. Query SSE narrow-observer (operation counts)

**Source:** `packages/ui/src/sync/session-transcript-sse.performance.test.js`

| Metric | Value |
| --- | --- |
| Seeded messages | 200 |
| Input deltas | 1000 |
| `targetPartsChanges` | 1000 |
| `targetMessageChanges` | 0 |
| `unrelatedObserverChanges` | 0 |
| `unchangedRefs` | 398 |

Token deltas update only the target message/parts observers; unrelated message/parts refs and pagination remain stable. Counts are deterministic (not wall-clock).

### 4b. Event-pipeline stress (coalesce + integrity)

**Source:** `packages/ui/src/sync/__tests__/event-pipeline.bench.js` stress scenario  
(10 projects × 5 sessions × 1000 tokens framing → large input stream)

| Metric | Value |
| --- | --- |
| Input events | 50,150 |
| Delivered events | 170 |
| Input deltas | 50,000 |
| Delivered deltas | 60 |
| Delta reduction | ~99.9% |
| Bytes integrity | pass (concatenated delta bytes match input total) |
| Wall clock | ~505.1 ms |

**Note:** wall time includes fixed wait bounds in the bench harness; treat as a trace only, not a latency SLO.

---

## 5. LRU / generation evidence

**Sources (existing suites, not reimplemented for Ticket 10):**

- `packages/ui/src/sync/session-transcript-query-cache.test.ts` — inactive LRU by `dataUpdatedAt`, capacity bounds, `purgeSession` / `purgeGeneration`, `destructiveReset` chain isolation, active retain (registry + Query observers + repository subscribe).
- Reconnect compensation / runtime generation isolation covered by compensation and cache tests already green under Ticket 07/08/09.

---

## 6. Command results (validation run)

| Suite / check | Result |
| --- | --- |
| UI focused (9 files) | 127 pass / 0 fail |
| Web focused (3 files) | 44 pass / 0 fail |
| UI type-check | pass |
| Docs validate | 387 pass / 43 (as reported by `docs:validate` run) |
| `bun run dead-code` | completed; remaining hits are repository baseline only |
| Isolated runtime + perf + pipeline | 35 pass / 0 fail |

---

## 7. Platform matrix

| Surface | Coverage in this ticket |
| --- | --- |
| In-process Web Host reconcile + client protocol | **Covered** (real `createSessionReconcileService` + Query stack) |
| Shared UI runtime (Query repo, compensation, pipeline, SSE merge) | **Covered** (focused tests) |
| Real browser visibility / bfcache | **Pending** platform smoke |
| Electron suspend / resume | **Pending** platform smoke |
| VS Code webview with page limit=4 long gap | **Pending** platform smoke |
| Capacitor mobile network suspension | **Pending** platform smoke |

**Claim boundary:** static and in-process evidence supports protocol correctness and data convergence (unique IDs, parts, cursor/complete, flight/fetching settlement, narrow SSE updates, coalesce integrity). This report does **not** claim real platform event-loop, paint, or OS-lifecycle correctness.

---

## 8. Known test logs

Event-pipeline suites emit an expected error-path log for `ws_closed:1006` (abnormal close simulation). All related assertions passed; the log is intentional, not a failure.

---

## Ticket 10 checklist mapping

1. Replay before ready; ready then compensation — §3  
2. Final message IDs once; parts complete; cursor/complete Host-aligned — §1  
3. Continuation, multi-round head chase, `resetRequired` runtime evidence — §1, §2  
4. Transcript Query tasks complete; fetching → 0 — §1, §2  
5. Token delta narrow observers + scale counts/trace — §4  
6. Covered vs pending platforms — §7  

---

## Gate 3 remediation / final run

**Date:** 2026-08-06  
**Result:** Oracle Gate 3 **PASS**. Phase 3 complete.  
**Scope:** B1 stale-reconcile parts rollback fix + independent regression; historical Ticket 10 numbers above are preserved as the original validation run.

### B1 — stale reconcile parts rollback (TDD)

- **Reproduce (old policy):** Expected live-newer / Received stale-lagging when
  stale recovery/reconcile parts overwrote newer live parts for the same part ID.
- **Fix:**
  - Stale recovery / reconcile merge: `messages: insert-only`, `parts: skip-existing`.
  - Current (live) path unchanged: `upsert` + `replace`.
- **Tests strengthened:** same part-ID race coverage; reducer backfill / identity
  coverage.

### Independent regression (Gate 3 final)

| Suite / check | Result |
| --- | --- |
| Independent regression (13 files) | 242 pass / 0 fail / 1298 expects |
| UI type-check | pass |
| Docs validate | 387 pass / 43 (as reported by `docs:validate`) |

### Oracle re-review

- B1 closed.
- No blocking findings.
- Gate 3 **PASS**.

### Remaining uncertainty (non-blocking follow-up)

Real platform smokes remain open and do **not** block Gate 3:

- Real browser visibility / bfcache
- Electron suspend / resume
- VS Code webview with page limit=4 long gap
- Capacitor mobile network suspension

In-process evidence continues to support protocol correctness and data
convergence only — not real event-loop, paint, or OS-lifecycle correctness.
