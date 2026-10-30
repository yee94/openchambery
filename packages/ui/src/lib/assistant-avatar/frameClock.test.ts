import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { subscribeAvatarFrames } from './frameClock';

const frames = new Map<number, FrameRequestCallback>();
const cleanups: Array<() => void> = [];
let id = 0;
beforeEach(() => {
  vi.stubGlobal('requestAnimationFrame', vi.fn((callback: FrameRequestCallback) => { frames.set(++id, callback); return id; }));
  vi.stubGlobal('cancelAnimationFrame', vi.fn((key: number) => frames.delete(key)));
});
afterEach(() => {
  cleanups.splice(0).forEach((stop) => stop());
  frames.clear();
  vi.unstubAllGlobals();
});
const step = (timestamp: number) => {
  const pending = [...frames.values()];
  frames.clear();
  pending.forEach((callback) => callback(timestamp));
};

test('20 visible avatars share one 30fps clock and clean up the last frame', () => {
  const paints = Array.from({ length: 20 }, () => vi.fn());
  paints.forEach((paint) => cleanups.push(subscribeAvatarFrames(paint)));
  expect(requestAnimationFrame).toHaveBeenCalledTimes(1);
  for (let i = 0; i < 120; i++) {
    step(i * (1000 / 120));
    expect(frames.size).toBe(1);
  }
  paints.forEach((paint) => expect(paint).toHaveBeenCalledTimes(30));
  cleanups.splice(0).forEach((stop) => stop());
  expect(frames.size).toBe(0);
});

test('removing one avatar preserves others; a new lifetime starts immediately', () => {
  const first = vi.fn();
  const second = vi.fn();
  const stopFirst = subscribeAvatarFrames(first);
  const stopSecond = subscribeAvatarFrames(second);
  cleanups.push(stopFirst, stopSecond);
  step(1000);
  stopFirst();
  step(1050);
  expect(first).toHaveBeenCalledTimes(1);
  expect(second).toHaveBeenCalledTimes(2);
  stopSecond();
  cleanups.push(subscribeAvatarFrames(first));
  step(1051);
  expect(first).toHaveBeenCalledTimes(2);
});
