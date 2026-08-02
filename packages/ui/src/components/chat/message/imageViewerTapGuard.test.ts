import { describe, expect, test } from 'bun:test';
import {
  closeImageViewerAfterMobileTap,
  installImageViewerTrailingClickGuard,
} from './imageViewerTapGuard';

class PositionedClickEvent extends Event {
  constructor(
    public readonly clientX: number,
    public readonly clientY: number,
  ) {
    super('click', { bubbles: true, cancelable: true });
  }
}

describe('imageViewerTapGuard', () => {
  test('arms the guard before the close callback removes the viewer', () => {
    const target = new EventTarget();
    let underlyingClicks = 0;
    const trailingClick = new PositionedClickEvent(120, 240);
    closeImageViewerAfterMobileTap({ x: 120, y: 240 }, () => {
      target.addEventListener('click', () => { underlyingClicks += 1; });
      target.dispatchEvent(trailingClick);
    }, { target });

    expect(trailingClick.defaultPrevented).toBe(true);
    expect(underlyingClicks).toBe(0);
  });

  test('keeps unrelated clicks available and consumes one matching trailing click', () => {
    const target = new EventTarget();
    let underlyingClicks = 0;
    const cleanup = installImageViewerTrailingClickGuard({ x: 120, y: 240 }, { target });
    target.addEventListener('click', () => { underlyingClicks += 1; });

    target.dispatchEvent(new PositionedClickEvent(300, 400));
    target.dispatchEvent(new PositionedClickEvent(130, 250));
    target.dispatchEvent(new PositionedClickEvent(120, 240));
    cleanup();

    expect(underlyingClicks).toBe(2);
  });

  test('expires when the browser emits no trailing click', async () => {
    const target = new EventTarget();
    let underlyingClicks = 0;
    installImageViewerTrailingClickGuard({ x: 120, y: 240 }, { target, durationMs: 1 });
    target.addEventListener('click', () => { underlyingClicks += 1; });

    await new Promise((resolve) => globalThis.setTimeout(resolve, 5));
    target.dispatchEvent(new PositionedClickEvent(120, 240));

    expect(underlyingClicks).toBe(1);
  });
});
