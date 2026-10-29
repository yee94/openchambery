import { afterEach, expect, it, vi } from 'vitest';
import { afterGuiPaint, createGuiInstallQueue } from './scheduling';

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

it('never installs in the commit turn and gives every cached plugin its own paint opportunities', async () => {
  vi.useFakeTimers();
  let frame = 0;
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => setTimeout(() => { frame++; callback(frame * 16); }, 16));
  vi.stubGlobal('cancelAnimationFrame', clearTimeout);
  const controller = new AbortController();
  const schedule = createGuiInstallQueue();
  const installed: number[] = [];
  const tasks = Array.from({ length: 20 }, () => schedule(controller.signal, () => installed.push(frame)));
  expect(installed).toEqual([]);
  await vi.advanceTimersByTimeAsync(16);
  expect(installed).toEqual([]);
  await vi.runAllTimersAsync();
  await Promise.all(tasks);
  expect(installed).toHaveLength(20);
  expect(installed.every((value, index) => value >= (installed[index - 1] ?? 0) + 2)).toBe(true);
});

it('cancels pending paint work and drains a failed or cancelled installation without starving others', async () => {
  vi.useFakeTimers();
  const controller = new AbortController();
  const paint = afterGuiPaint(controller.signal).catch(() => 'cancelled');
  controller.abort();
  expect(await paint).toBe('cancelled');
  const schedule = createGuiInstallQueue();
  const installed = vi.fn();
  const cancelled = schedule(controller.signal, installed).catch(() => {});
  const failed = schedule(new AbortController().signal, () => { throw new Error('bad plugin'); }).catch(() => {});
  const good = schedule(new AbortController().signal, installed);
  await vi.runAllTimersAsync();
  await Promise.all([cancelled, failed, good]);
  expect(installed).toHaveBeenCalledOnce();
});
