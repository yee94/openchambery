import { expect, it } from 'bun:test';

import { createInFlightGate, createWorkTracker } from '../src/push/guard.js';

it('rejects waiters without zeroing active and isolates leftover releases after reset', async () => {
  const gate = createInFlightGate(1);
  const first = await gate.acquire();
  expect(first).toBeTruthy();
  expect(gate.active).toBe(1);
  const waiting = gate.acquire();
  expect(gate.waiting).toBe(1);
  let idle = false;
  const idlePromise = gate.whenIdle().then(() => { idle = true; });
  gate.rejectWaiters();
  expect(await waiting).toBe(false);
  expect(gate.active).toBe(1);
  expect(gate.waiting).toBe(0);
  expect(idle).toBe(false);
  expect(await gate.acquire()).toBe(false);
  gate.release(first);
  await idlePromise;
  expect(idle).toBe(true);
  expect(gate.active).toBe(0);
  const leftover = await (async () => {
    const next = createInFlightGate(1);
    const ticket = await next.acquire();
    next.reset();
    expect(next.active).toBe(0);
    const fresh = await next.acquire();
    expect(next.active).toBe(1);
    next.release(ticket);
    expect(next.active).toBe(1);
    next.release(fresh);
    expect(next.active).toBe(0);
    return true;
  })();
  expect(leftover).toBe(true);
});

it('tracks HTTP work across generations without carrying stale completions', async () => {
  const work = createWorkTracker();
  const end = work.begin();
  expect(work.active).toBe(1);
  let idle = false;
  const idlePromise = work.whenIdle().then(() => { idle = true; });
  expect(idle).toBe(false);
  work.reset();
  expect(work.active).toBe(0);
  const endFresh = work.begin();
  expect(work.active).toBe(1);
  end();
  expect(work.active).toBe(1);
  endFresh();
  await idlePromise;
  expect(work.active).toBe(0);
});
