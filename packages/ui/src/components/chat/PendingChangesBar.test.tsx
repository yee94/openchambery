import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, test, vi } from 'vitest';

const fetchStatus = vi.hoisted(() => vi.fn(async () => false));
const git = vi.hoisted(() => ({ getGitStatus: vi.fn() }));
const gitState = vi.hoisted(() => ({
  status: {
    isClean: false,
    files: [{ path: 'src/app.ts', index: ' ', working_dir: 'M' }],
    diffStats: { 'src/app.ts': { insertions: 2, deletions: 1 } } as Record<string, { insertions: number; deletions: number }> | undefined,
  },
}));
const defaultStatus = vi.hoisted(() => ({ value: null as unknown }));

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
    directories: new Map([['/repo', { status: gitState.status }]]),
    fetchStatus,
  }),
}));

import { RuntimeAPIContext } from '@/contexts/runtimeAPIContext';
import type { RuntimeAPIs } from '@/lib/api/types';
import { PendingChangesBar } from './PendingChangesBar';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

defaultStatus.value = gitState.status;

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  fetchStatus.mockClear();
  gitState.status = defaultStatus.value as typeof gitState.status;
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

describe('PendingChangesBar large change sets', () => {
  const FILE_COUNT = 60_000;
  const createLargeStatus = () => {
    const files = Array.from({ length: FILE_COUNT }, (_, index) => ({
      path: `src/dir-${index % 100}/file-${index}.ts`,
      index: ' ',
      working_dir: 'M',
    }));
    const diffStats: Record<string, { insertions: number; deletions: number }> = {};
    for (const file of files) diffStats[file.path] = { insertions: 1, deletions: 2 };
    return { isClean: false, files, diffStats };
  };

  test('collapsed trigger reports the full count and totals', async () => {
    gitState.status = createLargeStatus();
    await renderBar();

    const text = host.textContent ?? '';
    expect(text).toContain(`chat.pendingChanges.fileCountPlural:${FILE_COUNT}`);
    expect(text).toContain(`+${FILE_COUNT}`);
    expect(text).toContain(`-${FILE_COUNT * 2}`);
  });

  test('expanded list keeps the full count but renders a bounded window of rows', async () => {
    // happy-dom has no layout; give elements a popover-sized viewport.
    const proto = HTMLElement.prototype as unknown as Record<string, unknown>;
    const previous = {
      clientHeight: Object.getOwnPropertyDescriptor(proto, 'clientHeight'),
      clientWidth: Object.getOwnPropertyDescriptor(proto, 'clientWidth'),
      offsetHeight: Object.getOwnPropertyDescriptor(proto, 'offsetHeight'),
    };
    // Scroll viewport is 352px tall; each measured row is 32px.
    Object.defineProperty(proto, 'clientHeight', { configurable: true, get: () => 352 });
    Object.defineProperty(proto, 'clientWidth', { configurable: true, get: () => 400 });
    Object.defineProperty(proto, 'offsetHeight', { configurable: true, get: () => 32 });
    try {
      gitState.status = createLargeStatus();
      await renderBar();
      const trigger = host.querySelector('button');

      await act(async () => {
        trigger?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      });

      const rows = host.querySelectorAll('button[title^="chat.changedFiles.actions.openFileTitle"]');
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.length).toBeLessThan(200);
      expect(host.textContent).toContain(String(FILE_COUNT));
    } finally {
      for (const [key, descriptor] of Object.entries(previous)) {
        if (descriptor) Object.defineProperty(proto, key, descriptor);
        else delete proto[key];
      }
    }
  });

  test('scrolling measures row height once instead of re-measuring every mounted row', async () => {
    const proto = HTMLElement.prototype as unknown as Record<string, unknown>;
    const previous = {
      clientHeight: Object.getOwnPropertyDescriptor(proto, 'clientHeight'),
      clientWidth: Object.getOwnPropertyDescriptor(proto, 'clientWidth'),
      offsetHeight: Object.getOwnPropertyDescriptor(proto, 'offsetHeight'),
    };
    let heightReads = 0;
    Object.defineProperty(proto, 'clientHeight', { configurable: true, get: () => 352 });
    Object.defineProperty(proto, 'clientWidth', { configurable: true, get: () => 400 });
    // Real rows render taller than any fixed estimate (35px on desktop).
    Object.defineProperty(proto, 'offsetHeight', { configurable: true, get: () => { heightReads += 1; return 35; } });
    try {
      gitState.status = createLargeStatus();
      await renderBar();
      await act(async () => {
        host.querySelector('button')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      });
      const scroller = host.querySelector<HTMLElement>('[class*="overflow-y-auto"]');
      expect(scroller).not.toBeNull();

      heightReads = 0;
      for (let step = 1; step <= 20; step += 1) {
        await act(async () => {
          scroller!.scrollTop = step * 3_500;
          scroller!.dispatchEvent(new Event('scroll'));
        });
      }

      expect(heightReads).toBeLessThan(5);
      const row = host.querySelector<HTMLElement>('[data-index="2000"]');
      expect(row?.style.transform).toBe('translateY(70000px)');
    } finally {
      for (const [key, descriptor] of Object.entries(previous)) {
        if (descriptor) Object.defineProperty(proto, key, descriptor);
        else delete proto[key];
      }
    }
  });
});
