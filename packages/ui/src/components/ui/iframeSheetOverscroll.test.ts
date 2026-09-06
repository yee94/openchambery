import { afterEach, describe, expect, test, vi } from 'vitest';

import {
  MOBILE_WINDOW_MOTION_ID_ATTR,
  attachIframeSheetOverscroll,
  collectIframeScrollChain,
  findOwningMotionId,
  getIframeDocumentScroller,
  isIframeScrollChainAtTop,
  shouldHandIframePanToSheet,
  shouldKeepIframeSheetDismiss,
} from './iframeSheetOverscroll';
import {
  getMobileWindowMotionFrame,
  getMobileWindowMotionVisibleProgress,
} from './MobileWindowMotionRecipe';
import { registerMobileWindowMotionController } from './MobileWindowMotionRegistry';

const cleanups: Array<() => void> = [];

afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

const track = (cleanup: () => void) => {
  cleanups.push(cleanup);
  return cleanup;
};

/** Independent local client and physical screen coordinates. */
const dispatchIframeTouch = (
  doc: Document,
  type: 'touchstart' | 'touchmove' | 'touchend' | 'touchcancel',
  opts: {
    clientX: number;
    clientY: number;
    screenX: number;
    screenY: number;
    timeStamp: number;
    identifier?: number;
    target?: EventTarget;
    touchesCount?: number;
  },
) => {
  const target = (opts.target as EventTarget | undefined) ?? doc.documentElement;
  const identifier = opts.identifier ?? 1;
  const touch = new Touch({
    identifier,
    target: target as Element,
    clientX: opts.clientX,
    clientY: opts.clientY,
    screenX: opts.screenX,
    screenY: opts.screenY,
    pageX: opts.clientX,
    pageY: opts.clientY,
  });
  const extra: Touch[] = [];
  if ((opts.touchesCount ?? 1) > 1 && type !== 'touchend' && type !== 'touchcancel') {
    extra.push(new Touch({
      identifier: identifier + 1,
      target: target as Element,
      clientX: opts.clientX + 10,
      clientY: opts.clientY + 10,
      screenX: opts.screenX + 10,
      screenY: opts.screenY + 10,
      pageX: opts.clientX + 10,
      pageY: opts.clientY + 10,
    }));
  }
  const active = type === 'touchend' || type === 'touchcancel' ? [] : [touch, ...extra];
  const event = new TouchEvent(type, {
    bubbles: true,
    cancelable: true,
    touches: active,
    targetTouches: active,
    changedTouches: type === 'touchend' && opts.identifier === -1 ? [] : [touch],
  });
  Object.defineProperty(event, 'timeStamp', { configurable: true, value: opts.timeStamp });
  (target as Element).dispatchEvent(event);
  return event;
};

const iframeClientFromScreen = (fingerScreenY: number, iframeTopScreen: number): number => (
  fingerScreenY - iframeTopScreen
);

const mountSheetIframe = (motionId: string, surfaceHeight: number, surfaceTop: number) => {
  const surface = document.createElement('div');
  surface.setAttribute(MOBILE_WINDOW_MOTION_ID_ATTR, motionId);
  surface.style.height = `${surfaceHeight}px`;
  const iframe = document.createElement('iframe');
  surface.appendChild(iframe);
  document.body.appendChild(surface);
  let surfaceTranslateY = 0;
  let geometryReads = 0;
  vi.spyOn(surface, 'getBoundingClientRect').mockImplementation(() => {
    geometryReads += 1;
    return {
      x: 0,
      y: surfaceTop + surfaceTranslateY,
      top: surfaceTop + surfaceTranslateY,
      left: 0,
      right: 390,
      bottom: surfaceTop + surfaceTranslateY + surfaceHeight,
      width: 390,
      height: surfaceHeight,
      toJSON() { return this; },
    } as DOMRect;
  });
  return {
    surface,
    iframe,
    get geometryReads() { return geometryReads; },
    get surfaceTranslateY() { return surfaceTranslateY; },
    set surfaceTranslateY(value: number) { surfaceTranslateY = value; },
    iframeTop: () => surfaceTop + surfaceTranslateY,
  };
};

const prepareDoc = (iframe: HTMLIFrameElement, html = '<body style="height:2000px;margin:0">doc</body>') => {
  iframe.srcdoc = `<!doctype html><html>${html}</html>`;
  iframe.dispatchEvent(new Event('load'));
  const doc = iframe.contentDocument!;
  Object.defineProperty(doc.documentElement, 'scrollTop', {
    configurable: true,
    get: () => 0,
    set: () => undefined,
  });
  Object.defineProperty(doc, 'scrollingElement', {
    configurable: true,
    get: () => doc.documentElement,
  });
  return doc;
};

describe('iframeSheetOverscroll', () => {
  test('hands a downward pan to the sheet only at the top of the document', () => {
    expect(shouldHandIframePanToSheet(0, 12)).toBe(true);
    expect(shouldHandIframePanToSheet(2, 12)).toBe(false);
    expect(shouldHandIframePanToSheet(0, -8)).toBe(false);
  });

  test('keeps an active dismiss through reverse and scrollTop noise', () => {
    expect(shouldKeepIframeSheetDismiss(true, 8, -4)).toBe(true);
    expect(shouldKeepIframeSheetDismiss(false, 8, 16)).toBe(false);
  });

  test('finds owning motion id and root scroller', () => {
    const sheet = document.createElement('div');
    sheet.setAttribute(MOBILE_WINDOW_MOTION_ID_ATTR, 'mobile-direct-file');
    const iframe = document.createElement('iframe');
    sheet.appendChild(iframe);
    document.body.appendChild(sheet);
    expect(findOwningMotionId(iframe)).toBe('mobile-direct-file');
    iframe.srcdoc = '<!doctype html><html><body>x</body></html>';
    iframe.dispatchEvent(new Event('load'));
    expect(getIframeDocumentScroller(iframe)).toBeTruthy();
    sheet.remove();
  });

  test('scroll chain blocks when outer/root is scrolled even if inner nest is at top', () => {
    const iframe = document.createElement('iframe');
    document.body.appendChild(iframe);
    iframe.srcdoc = `<!doctype html><html><body style="height:3000px;margin:0">
      <div id="nest" style="height:100px;overflow:auto"><div style="height:500px">n</div></div>
    </body></html>`;
    iframe.dispatchEvent(new Event('load'));
    const doc = iframe.contentDocument!;
    const nest = doc.getElementById('nest') as HTMLElement;
    nest.style.overflowY = 'auto';
    Object.defineProperty(nest, 'scrollHeight', { configurable: true, get: () => 500 });
    Object.defineProperty(nest, 'clientHeight', { configurable: true, get: () => 100 });
    Object.defineProperty(nest, 'scrollTop', { configurable: true, get: () => 0, set: () => undefined });
    Object.defineProperty(doc.documentElement, 'scrollTop', {
      configurable: true,
      get: () => 80,
      set: () => undefined,
    });
    Object.defineProperty(doc.documentElement, 'scrollHeight', { configurable: true, get: () => 3000 });
    Object.defineProperty(doc.documentElement, 'clientHeight', { configurable: true, get: () => 600 });
    // Force root scrollable via style
    doc.documentElement.style.overflowY = 'auto';
    const chain = collectIframeScrollChain(doc, nest.firstElementChild);
    expect(chain.length).toBeGreaterThan(0);
    // Root is scrolled even though the inner nest is at top — handoff blocked.
    expect(chain.some((el) => el.scrollTop > 1)).toBe(true);
    expect(isIframeScrollChainAtTop(doc, nest.firstElementChild)).toBe(false);
    // With root at top, chain is clear.
    Object.defineProperty(doc.documentElement, 'scrollTop', {
      configurable: true,
      get: () => 0,
      set: () => undefined,
    });
    expect(isIframeScrollChainAtTop(doc, nest.firstElementChild)).toBe(true);
    iframe.remove();
  });

  test('attachIframeSheetOverscroll tracks fixed outer screen finger with monotonic progress', () => {
    const motionId = 'iframe-overscroll-screen-monotonic';
    const surfaceHeight = 640;
    const surfaceTop = 120;
    const host = mountSheetIframe(motionId, surfaceHeight, surfaceTop);
    const begins: string[] = [];
    const finishes: string[] = [];
    const progressSamples: number[] = [];

    track(registerMobileWindowMotionController(motionId, {
      begin: (operation) => {
        begins.push(operation);
        return true;
      },
      update: (progress) => {
        progressSamples.push(progress);
        host.surfaceTranslateY = progress * surfaceHeight;
        const visible = getMobileWindowMotionVisibleProgress('dismiss', progress);
        const frame = getMobileWindowMotionFrame('bottom', visible);
        host.surface.style.transform = frame.surfaceTransform;
      },
      finish: (finish) => finishes.push(finish),
      interrupt: () => undefined,
    }));

    const doc = prepareDoc(host.iframe);
    const geometryBefore = host.geometryReads;
    track(attachIframeSheetOverscroll(host.iframe));

    const screenYs = [180, 200, 240, 300, 380, 480];
    const screenX = 180;
    let t = 1_000;
    for (let index = 0; index < screenYs.length; index += 1) {
      const screenY = screenYs[index]!;
      const clientY = iframeClientFromScreen(screenY, host.iframeTop());
      dispatchIframeTouch(doc, index === 0 ? 'touchstart' : 'touchmove', {
        clientX: 10,
        clientY,
        screenX,
        screenY,
        timeStamp: t,
      });
      t += 16;
    }
    const endScreenY = screenYs[screenYs.length - 1]!;
    dispatchIframeTouch(doc, 'touchend', {
      clientX: 10,
      clientY: iframeClientFromScreen(endScreenY, host.iframeTop()),
      screenX,
      screenY: endScreenY,
      timeStamp: t,
    });

    expect(begins).toEqual(['dismiss']);
    expect(finishes).toHaveLength(1);
    expect(host.geometryReads - geometryBefore).toBeLessThanOrEqual(1);
    for (let index = 1; index < progressSamples.length; index += 1) {
      expect(progressSamples[index]!).toBeGreaterThanOrEqual(progressSamples[index - 1]! - 1e-9);
    }
    const outerTravel = endScreenY - screenYs[0]!;
    expect(progressSamples[progressSamples.length - 1]!).toBeGreaterThanOrEqual(outerTravel / surfaceHeight * 0.9);
  });

  test('hold with fixed screen finger does not shake progress while surface translates', () => {
    const motionId = 'iframe-overscroll-hold';
    const surfaceHeight = 640;
    const surfaceTop = 100;
    const host = mountSheetIframe(motionId, surfaceHeight, surfaceTop);
    const progressSamples: number[] = [];
    track(registerMobileWindowMotionController(motionId, {
      begin: () => true,
      update: (progress) => {
        progressSamples.push(progress);
        host.surfaceTranslateY = progress * surfaceHeight;
      },
      finish: () => undefined,
      interrupt: () => undefined,
    }));
    const doc = prepareDoc(host.iframe);
    track(attachIframeSheetOverscroll(host.iframe));

    const pullScreens = [150, 170, 210, 260];
    let t = 2_000;
    for (let index = 0; index < pullScreens.length; index += 1) {
      const screenY = pullScreens[index]!;
      dispatchIframeTouch(doc, index === 0 ? 'touchstart' : 'touchmove', {
        clientX: 40,
        clientY: iframeClientFromScreen(screenY, host.iframeTop()),
        screenX: 100,
        screenY,
        timeStamp: t,
      });
      t += 16;
    }
    const holdScreenY = pullScreens[pullScreens.length - 1]!;
    const atHold = progressSamples[progressSamples.length - 1] ?? 0;
    for (let i = 0; i < 6; i += 1) {
      dispatchIframeTouch(doc, 'touchmove', {
        clientX: 40,
        clientY: iframeClientFromScreen(holdScreenY, host.iframeTop()),
        screenX: 100,
        screenY: holdScreenY,
        timeStamp: t,
      });
      t += 16;
    }
    const holdSamples = progressSamples.slice(progressSamples.indexOf(atHold));
    for (let index = 1; index < holdSamples.length; index += 1) {
      expect(holdSamples[index]!).toBeGreaterThanOrEqual(holdSamples[index - 1]! - 1e-9);
    }
    expect(host.geometryReads).toBeLessThanOrEqual(1);
  });

  test('allows smooth reverse to progress 0 and still finishes once', () => {
    const motionId = 'iframe-overscroll-reverse';
    const surfaceHeight = 600;
    const surfaceTop = 80;
    const host = mountSheetIframe(motionId, surfaceHeight, surfaceTop);
    const begins: string[] = [];
    const finishes: string[] = [];
    const progressSamples: number[] = [];
    track(registerMobileWindowMotionController(motionId, {
      begin: (op) => { begins.push(op); return true; },
      update: (progress) => {
        progressSamples.push(progress);
        host.surfaceTranslateY = progress * surfaceHeight;
      },
      finish: (f) => finishes.push(f),
      interrupt: () => undefined,
    }));
    const doc = prepareDoc(host.iframe);
    track(attachIframeSheetOverscroll(host.iframe));

    const path = [100, 140, 220, 300, 220, 140, 100];
    let t = 3_000;
    for (let index = 0; index < path.length; index += 1) {
      const screenY = path[index]!;
      dispatchIframeTouch(doc, index === 0 ? 'touchstart' : 'touchmove', {
        clientX: 10,
        clientY: iframeClientFromScreen(screenY, host.iframeTop()),
        screenX: 90,
        screenY,
        timeStamp: t,
      });
      t += 16;
    }
    dispatchIframeTouch(doc, 'touchend', {
      clientX: 10,
      clientY: iframeClientFromScreen(100, host.iframeTop()),
      screenX: 90,
      screenY: 100,
      timeStamp: t,
    });

    expect(begins).toEqual(['dismiss']);
    expect(finishes).toEqual(['cancel']);
    expect(Math.min(...progressSamples)).toBe(0);
    expect(Math.max(...progressSamples)).toBeGreaterThan(0.2);
  });

  test('missing tracked end touch cancels instead of committing', () => {
    const motionId = 'iframe-overscroll-missing-end';
    const host = mountSheetIframe(motionId, 600, 40);
    const finishes: string[] = [];
    track(registerMobileWindowMotionController(motionId, {
      begin: () => true,
      update: (p) => { host.surfaceTranslateY = p * 600; },
      finish: (f) => finishes.push(f),
      interrupt: () => undefined,
    }));
    const doc = prepareDoc(host.iframe);
    track(attachIframeSheetOverscroll(host.iframe));
    let t = 4_000;
    for (const screenY of [100, 160, 240]) {
      dispatchIframeTouch(doc, screenY === 100 ? 'touchstart' : 'touchmove', {
        clientX: 5,
        clientY: iframeClientFromScreen(screenY, host.iframeTop()),
        screenX: 50,
        screenY,
        timeStamp: t,
      });
      t += 16;
    }
    // changedTouches empty via identifier sentinel
    dispatchIframeTouch(doc, 'touchend', {
      clientX: 5,
      clientY: 1,
      screenX: 50,
      screenY: 240,
      timeStamp: t,
      identifier: -1,
    });
    expect(finishes).toEqual(['cancel']);
  });

  test('ignores form and plaintext-only contenteditable; cleans only created style', () => {
    const motionId = 'iframe-overscroll-form';
    const host = mountSheetIframe(motionId, 500, 20);
    const begins: string[] = [];
    track(registerMobileWindowMotionController(motionId, {
      begin: (op) => { begins.push(op); return true; },
      update: () => undefined,
      finish: () => undefined,
      interrupt: () => undefined,
    }));
    const doc = prepareDoc(
      host.iframe,
      `<body style="height:2000px;margin:0">
        <input id="field" />
        <div id="plain" contenteditable="plaintext-only">edit</div>
        <div id="pad">x</div>
      </body>`,
    );
    // Pre-existing foreign style must survive detach of our binding.
    const foreign = doc.createElement('style');
    foreign.setAttribute('data-oc-sheet-overscroll', 'true');
    foreign.textContent = '/* foreign */';
    doc.head!.appendChild(foreign);

    const detach = attachIframeSheetOverscroll(host.iframe);
    track(detach);
    // We did not create a style because foreign already matched attr — createdStyle null.
    // Or if we only create when missing realm-safe style element — foreign is a style element
    // so no second inject. Detach must not remove foreign.
    expect(doc.querySelectorAll('style[data-oc-sheet-overscroll]').length).toBe(1);

    const field = doc.getElementById('field')!;
    dispatchIframeTouch(doc, 'touchstart', {
      clientX: 1, clientY: 1, screenX: 10, screenY: 10, timeStamp: 10, target: field,
    });
    dispatchIframeTouch(doc, 'touchmove', {
      clientX: 1, clientY: 40, screenX: 10, screenY: 80, timeStamp: 26, target: field,
    });
    const plain = doc.getElementById('plain')!;
    dispatchIframeTouch(doc, 'touchstart', {
      clientX: 1, clientY: 1, screenX: 10, screenY: 10, timeStamp: 40, target: plain,
    });
    dispatchIframeTouch(doc, 'touchmove', {
      clientX: 1, clientY: 50, screenX: 10, screenY: 90, timeStamp: 56, target: plain,
    });
    expect(begins).toEqual([]);

    detach();
    expect(doc.querySelector('style[data-oc-sheet-overscroll]')).toBe(foreign);
  });

  test('fullscreen iframe without owning sheet leaves document styles untouched', () => {
    const iframe = document.createElement('iframe');
    document.body.appendChild(iframe);
    iframe.srcdoc = '<!doctype html><html><body style="height:2000px">fs</body></html>';
    iframe.dispatchEvent(new Event('load'));
    const doc = iframe.contentDocument!;
    const before = doc.documentElement.outerHTML;
    const detach = attachIframeSheetOverscroll(iframe);
    expect(doc.querySelector('style[data-oc-sheet-overscroll]')).toBeNull();
    expect(doc.documentElement.outerHTML).toBe(before);
    detach();
    iframe.remove();
  });

  test('one begin and one finish across a continuous outer pull', () => {
    const motionId = 'iframe-overscroll-ownership';
    const surfaceHeight = 700;
    const surfaceTop = 80;
    const host = mountSheetIframe(motionId, surfaceHeight, surfaceTop);
    const begins: string[] = [];
    const finishes: string[] = [];
    track(registerMobileWindowMotionController(motionId, {
      begin: (op) => { begins.push(op); return true; },
      update: (progress) => { host.surfaceTranslateY = progress * surfaceHeight; },
      finish: (f) => finishes.push(f),
      interrupt: () => undefined,
    }));
    const doc = prepareDoc(host.iframe);
    track(attachIframeSheetOverscroll(host.iframe));
    const screenPath = [160, 175, 195, 220, 250, 290, 340];
    let t = 500;
    for (let index = 0; index < screenPath.length; index += 1) {
      const screenY = screenPath[index]!;
      dispatchIframeTouch(doc, index === 0 ? 'touchstart' : 'touchmove', {
        clientX: 12,
        clientY: iframeClientFromScreen(screenY, host.iframeTop()),
        screenX: 120,
        screenY,
        timeStamp: t,
      });
      t += 16;
    }
    dispatchIframeTouch(doc, 'touchend', {
      clientX: 12,
      clientY: iframeClientFromScreen(screenPath.at(-1)!, host.iframeTop()),
      screenX: 120,
      screenY: screenPath.at(-1)!,
      timeStamp: t,
    });
    expect(begins).toEqual(['dismiss']);
    expect(finishes).toHaveLength(1);
  });
});
