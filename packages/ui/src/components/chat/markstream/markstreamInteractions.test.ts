import { afterEach, describe, expect, test, vi } from 'vitest';

const { openExternalUrl, openFileReferenceFromElement } = vi.hoisted(() => ({
  openExternalUrl: vi.fn(async () => true),
  openFileReferenceFromElement: vi.fn(async () => undefined),
}));

vi.mock('@/lib/url', async () => {
  const actual = await vi.importActual<typeof import('@/lib/url')>('@/lib/url');
  return {
    ...actual,
    openExternalUrl,
  };
});

vi.mock('../fileReferenceActions', () => ({
  openFileReferenceFromElement,
}));

import { handleMarkstreamFileReferenceKeyDown, handleMarkstreamPointerEvent } from './markstreamInteractions';

const click = (
  target: EventTarget,
  currentTarget: EventTarget,
  modifiers?: Partial<Pick<MouseEvent, 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey'>>,
): MouseEvent => {
  const event = new MouseEvent('click', {
    bubbles: true,
    button: 0,
    metaKey: modifiers?.metaKey,
    ctrlKey: modifiers?.ctrlKey,
    altKey: modifiers?.altKey,
    shiftKey: modifiers?.shiftKey,
  });
  Object.defineProperty(event, 'target', { value: target });
  Object.defineProperty(event, 'currentTarget', { value: currentTarget });
  return event;
};

afterEach(() => {
  openExternalUrl.mockClear();
  openFileReferenceFromElement.mockClear();
});

describe('handleMarkstreamPointerEvent', () => {
  test('opens https links via in-app browser opener when directory is present', () => {
    const openInAppBrowser = vi.fn();
    const root = document.createElement('div');
    const external = document.createElement('a');
    external.setAttribute('href', 'https://example.com/docs');
    root.append(external);

    handleMarkstreamPointerEvent(click(external, root), {
      effectiveDirectory: '/repo',
      openInAppBrowser,
    });

    expect(openInAppBrowser).toHaveBeenCalledWith('/repo', 'https://example.com/docs');
    expect(openExternalUrl).not.toHaveBeenCalled();
  });

  test('opens localhost http links via in-app browser opener (not system browser)', () => {
    const openInAppBrowser = vi.fn();
    const root = document.createElement('div');
    const loopback = document.createElement('a');
    loopback.setAttribute('href', 'http://localhost:5173/app');
    root.append(loopback);

    handleMarkstreamPointerEvent(click(loopback, root), {
      effectiveDirectory: '/repo',
      openInAppBrowser,
    });

    expect(openInAppBrowser).toHaveBeenCalledWith('/repo', 'http://localhost:5173/app');
    expect(openExternalUrl).not.toHaveBeenCalled();
  });

  test('falls back to openExternalUrl when directory or opener is missing', () => {
    const root = document.createElement('div');
    const external = document.createElement('a');
    external.setAttribute('href', 'https://example.com/docs');
    const local = document.createElement('a');
    local.setAttribute('href', 'src/app.ts');
    root.append(external, local);

    handleMarkstreamPointerEvent(click(external, root), {});
    expect(openExternalUrl).toHaveBeenCalledWith('https://example.com/docs');

    openExternalUrl.mockClear();
    handleMarkstreamPointerEvent(click(local, root), {});
    expect(openExternalUrl).not.toHaveBeenCalled();

    openExternalUrl.mockClear();
    const openInAppBrowser = vi.fn();
    handleMarkstreamPointerEvent(click(external, root), {
      effectiveDirectory: '',
      openInAppBrowser,
    });
    expect(openInAppBrowser).not.toHaveBeenCalled();
    expect(openExternalUrl).toHaveBeenCalledWith('https://example.com/docs');
  });

  test('modifier click does not call opener or openExternalUrl', () => {
    const openInAppBrowser = vi.fn();
    const root = document.createElement('div');
    const external = document.createElement('a');
    external.setAttribute('href', 'https://example.com/docs');
    root.append(external);

    for (const modifiers of [
      { metaKey: true },
      { ctrlKey: true },
      { altKey: true },
      { shiftKey: true },
    ] as const) {
      openInAppBrowser.mockClear();
      openExternalUrl.mockClear();
      handleMarkstreamPointerEvent(click(external, root, modifiers), {
        effectiveDirectory: '/repo',
        openInAppBrowser,
      });
      expect(openInAppBrowser).not.toHaveBeenCalled();
      expect(openExternalUrl).not.toHaveBeenCalled();
    }
  });

  test('opens markdown images through the existing popup contract', () => {
    const onShowPopup = vi.fn();
    const openInAppBrowser = vi.fn();
    const root = document.createElement('div');
    const image = document.createElement('img');
    image.setAttribute('src', 'https://example.com/a.png');
    image.setAttribute('alt', 'diagram');
    root.append(image);

    handleMarkstreamPointerEvent(click(image, root), {
      onShowPopup,
      effectiveDirectory: '/repo',
      openInAppBrowser,
    });

    expect(onShowPopup).toHaveBeenCalledWith({
      open: true,
      title: 'diagram',
      content: '',
      image: {
        url: 'https://example.com/a.png',
        filename: 'diagram',
        gallery: [{ url: 'https://example.com/a.png', filename: 'diagram' }],
        index: 0,
      },
    });
    expect(openInAppBrowser).not.toHaveBeenCalled();
    expect(openExternalUrl).not.toHaveBeenCalled();
  });

  test('opens annotated file path tokens through the shared file-reference opener', () => {
    const fileReference = {
      effectiveDirectory: '/tmp',
    };
    const openInAppBrowser = vi.fn();
    const root = document.createElement('div');
    const token = document.createElement('span');
    token.textContent = '/tmp/report.html';
    token.setAttribute('data-openchamber-file-link', 'true');
    token.setAttribute('data-openchamber-file-ref', '/tmp/report.html');
    token.setAttribute('data-openchamber-file-path', '/tmp/report.html');
    root.append(token);

    handleMarkstreamPointerEvent(click(token, root), { fileReference, openInAppBrowser });

    expect(openFileReferenceFromElement).toHaveBeenCalledWith(token, fileReference);
    expect(openInAppBrowser).not.toHaveBeenCalled();
    expect(openExternalUrl).not.toHaveBeenCalled();
  });

  test('opens annotated file path tokens from the keyboard', () => {
    const fileReference = {
      effectiveDirectory: '/tmp',
    };
    const token = document.createElement('span');
    token.setAttribute('data-openchamber-file-link', 'true');
    const event = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true });
    Object.defineProperty(event, 'target', { value: token });

    handleMarkstreamFileReferenceKeyDown(event, { fileReference });
    expect(openFileReferenceFromElement).toHaveBeenCalledWith(token, fileReference);
  });
});
