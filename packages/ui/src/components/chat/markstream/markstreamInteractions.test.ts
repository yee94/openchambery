import { afterEach, describe, expect, test, vi } from 'vitest';

const { openExternalUrl } = vi.hoisted(() => ({
  openExternalUrl: vi.fn(async () => true),
}));

vi.mock('@/lib/url', async () => {
  const actual = await vi.importActual<typeof import('@/lib/url')>('@/lib/url');
  return {
    ...actual,
    openExternalUrl,
  };
});

import { handleMarkstreamPointerEvent } from './markstreamInteractions';

const click = (target: EventTarget, currentTarget: EventTarget): MouseEvent => {
  const event = new MouseEvent('click', { bubbles: true, button: 0 });
  Object.defineProperty(event, 'target', { value: target });
  Object.defineProperty(event, 'currentTarget', { value: currentTarget });
  return event;
};

afterEach(() => {
  openExternalUrl.mockClear();
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
});
