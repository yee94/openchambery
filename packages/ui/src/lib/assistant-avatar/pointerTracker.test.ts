import { afterEach, expect, test, vi } from 'vitest';
import { acquireAvatarPointer } from './pointerTracker';

const releases: Array<() => void> = [];
afterEach(() => { releases.splice(0).forEach((release) => release()); vi.restoreAllMocks(); });
const acquire = () => {
  const pointer = acquireAvatarPointer(window);
  releases.push(pointer.release);
  return pointer;
};
const send = (type: string, props: object = {}) => window.dispatchEvent(Object.assign(new Event(type), {
  pointerType: 'mouse', clientX: 30, clientY: 70, relatedTarget: null, ...props,
}));

test('twenty consumers share one pointer listener and coalesce events into the latest sample', () => {
  const add = vi.spyOn(window, 'addEventListener'), remove = vi.spyOn(window, 'removeEventListener');
  const pointers = Array.from({ length: 20 }, acquire);
  expect(add.mock.calls.filter(([type]) => String(type) === 'pointermove')).toHaveLength(1);
  for (let i = 0; i < 1000; i++) send('pointermove', { clientX: i });
  pointers.forEach((pointer) => expect(pointer.read()).toEqual({ x: 999, y: 70 }));
  pointers[0].release(); pointers[0].release();
  expect(remove.mock.calls.filter(([type]) => String(type) === 'pointermove')).toHaveLength(0);
  pointers.slice(1).forEach((pointer) => pointer.release());
  expect(remove.mock.calls.filter(([type]) => String(type) === 'pointermove')).toHaveLength(1);
  expect(acquire().read()).toBeNull();
});

test('leaving the window, losing focus and switching to touch clear mouse gaze', () => {
  const pointer = acquire();
  send('pointermove');
  send('pointerout', { relatedTarget: document.body });
  expect(pointer.read()).toEqual({ x: 30, y: 70 });
  send('pointerout');
  expect(pointer.read()).toBeNull();
  send('pointermove'); send('blur');
  expect(pointer.read()).toBeNull();
  send('pointermove'); send('pointermove', { pointerType: 'touch' });
  expect(pointer.read()).toBeNull();
});
