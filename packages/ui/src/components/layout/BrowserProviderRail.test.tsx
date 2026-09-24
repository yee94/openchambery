import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { dict as en } from '@/lib/i18n/messages/en';
import type { SurfaceClientHandlers } from '@/lib/browser-provider/surface-client';
import { BrowserProviderRail } from './BrowserProviderRail';

vi.mock('@/lib/i18n', () => ({
  useI18n: () => ({
    t: (key: keyof typeof en, params?: Record<string, string>) => {
      let text: string = en[key] ?? key;
      for (const [name, value] of Object.entries(params ?? {})) text = text.replace(`{${name}}`, value);
      return text;
    },
  }),
}));

let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

describe('BrowserProviderRail', () => {
  it('shows an empty state instead of a picture when the provider has no surface', async () => {
    await act(async () => {
      root.render(<BrowserProviderRail provider={{ id: 'ext.chrome', name: 'Chrome', surface: false }} />);
    });
    expect(host.textContent).toContain('Chrome has no live view.');
    expect(host.querySelector('canvas')).toBeNull();
  });

  it('hands control back to the extension after the user has taken it', async () => {
    const release = vi.fn();
    const sendInput = vi.fn();
    let handlers: SurfaceClientHandlers | null = null;
    await act(async () => {
      root.render(
        <BrowserProviderRail
          provider={{ id: 'ext.chrome', name: 'Chrome', surface: true }}
          clientFactory={(_id, next) => {
            handlers = next;
            return {
              start: () => {
                next.onConnection({ status: 'open' });
                next.onControl({ controller: 'user', mine: true });
              },
              dispose: () => undefined,
              ack: () => undefined,
              sendInput,
              release,
              resize: () => undefined,
              retry: () => undefined,
            };
          }}
        />,
      );
    });
    expect(host.textContent).toContain('You have control');
    const button = Array.from(host.querySelectorAll('button')).find((node) => node.textContent === 'Hand back to extension');
    expect(button).toBeTruthy();
    await act(async () => {
      button?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(release).toHaveBeenCalledTimes(1);
    await act(async () => {
      handlers?.onControl({ controller: 'agent', mine: false });
    });
    expect(host.textContent).toContain('Agent is working');
    expect(host.textContent).not.toContain('Hand back to extension');
  });
});
