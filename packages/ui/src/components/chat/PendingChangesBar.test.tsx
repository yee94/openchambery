import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, test, vi } from 'vitest';

const fetchStatus = vi.hoisted(() => vi.fn(async () => false));
const git = vi.hoisted(() => ({ getGitStatus: vi.fn() }));

vi.mock('@/lib/i18n', () => ({
  useI18n: () => ({ t: (key: string, values?: { count?: number }) => (
    values?.count === undefined ? key : `${key}:${values.count}`
  ) }),
}));

vi.mock('@/hooks/useEffectiveDirectory', () => ({
  useEffectiveDirectory: () => '/repo',
}));

vi.mock('@/apps/mobileAppContext', () => ({
  useMobileAppActions: () => null,
}));

vi.mock('@/stores/useGitStore', () => ({
  useIsGitRepo: () => true,
  useGitStore: (selector: (state: {
    directories: Map<string, { status: unknown }>;
    fetchStatus: typeof fetchStatus;
  }) => unknown) => selector({
    directories: new Map([['/repo', {
      status: {
        isClean: false,
        files: [{ path: 'src/app.ts', index: ' ', working_dir: 'M' }],
        diffStats: { 'src/app.ts': { insertions: 2, deletions: 1 } },
      },
    }]]),
    fetchStatus,
  }),
}));

import { RuntimeAPIContext } from '@/contexts/runtimeAPIContext';
import type { RuntimeAPIs } from '@/lib/api/types';
import { PendingChangesBar } from './PendingChangesBar';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  fetchStatus.mockClear();
});

const renderBar = async () => {
  host = document.createElement('div');
  root = createRoot(host);
  document.body.append(host);
  await act(async () => {
    root.render(
      <RuntimeAPIContext.Provider value={{ git } as unknown as RuntimeAPIs}>
        <PendingChangesBar />
      </RuntimeAPIContext.Provider>,
    );
  });
};

describe('PendingChangesBar expand refresh', () => {
  test('expanding the composer diff refreshes git status in the background', async () => {
    await renderBar();
    const button = host.querySelector('button');
    expect(button?.getAttribute('aria-expanded')).toBe('false');

    await act(async () => {
      button?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(button?.getAttribute('aria-expanded')).toBe('true');
    expect(fetchStatus).toHaveBeenCalledTimes(1);
    expect(fetchStatus).toHaveBeenCalledWith('/repo', git, { silent: true });
    expect(host.textContent).not.toMatch(/loading/i);
  });

  test('collapsing does not refresh', async () => {
    await renderBar();
    const button = host.querySelector('button');

    await act(async () => {
      button?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    fetchStatus.mockClear();

    await act(async () => {
      button?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(button?.getAttribute('aria-expanded')).toBe('false');
    expect(fetchStatus).not.toHaveBeenCalled();
  });
});
