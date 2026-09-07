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

const click = (target: EventTarget, currentTarget: EventTarget): MouseEvent => {
  const event = new MouseEvent('click', { bubbles: true, button: 0 });
  Object.defineProperty(event, 'target', { value: target });
  Object.defineProperty(event, 'currentTarget', { value: currentTarget });
  return event;
};

afterEach(() => {
  openExternalUrl.mockClear();
  openFileReferenceFromElement.mockClear();
});

describe('handleMarkstreamPointerEvent', () => {
  test('opens external http links and leaves local file links alone', () => {
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
  });

  test('opens markdown images through the existing popup contract', () => {
    const onShowPopup = vi.fn();
    const root = document.createElement('div');
    const image = document.createElement('img');
    image.setAttribute('src', 'https://example.com/a.png');
    image.setAttribute('alt', 'diagram');
    root.append(image);

    handleMarkstreamPointerEvent(click(image, root), { onShowPopup });

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
  });

  test('opens annotated file path tokens through the shared file-reference opener', () => {
    const fileReference = {
      effectiveDirectory: '/tmp',
    };
    const root = document.createElement('div');
    const token = document.createElement('span');
    token.textContent = '/tmp/report.html';
    token.setAttribute('data-openchamber-file-link', 'true');
    token.setAttribute('data-openchamber-file-ref', '/tmp/report.html');
    token.setAttribute('data-openchamber-file-path', '/tmp/report.html');
    root.append(token);

    handleMarkstreamPointerEvent(click(token, root), { fileReference });

    expect(openFileReferenceFromElement).toHaveBeenCalledWith(token, fileReference);
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
