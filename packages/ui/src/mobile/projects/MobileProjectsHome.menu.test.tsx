import { describe, expect, test } from 'vitest';
import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { I18nProvider } from '@/lib/i18n';
import { MOBILE_PRESS_TARGET_SELECTOR } from '@/hooks/streamingHaptics';

import {
  MobileProjectsHome,
  type MobileProjectHomeItem,
  type MobileProjectsHomeProps,
} from './MobileProjectsHome';

const noop = () => undefined;

const projects: MobileProjectHomeItem[] = [{
  id: 'project-1',
  name: 'OpenChamber',
  path: '/code/openchamber',
  sessionCount: 0,
  expanded: false,
  worktrees: [],
}];

const baseProps: MobileProjectsHomeProps = {
  projects,
  pinnedSessions: [],
  onAddProject: noop,
  onNewSession: noop,
  onToggleProject: noop,
  onOpenProjectActions: noop,
  onToggleWorktree: noop,
  onNewWorktreeSession: noop,
  onOpenWorktreeActions: noop,
  onDeleteWorktree: noop,
  onSelectSession: noop,
  onPinSession: noop,
  onArchiveSession: noop,
  onOpenSessionActions: noop,
};

function mount(props: MobileProjectsHomeProps): { root: Root; container: HTMLElement } {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(
      <I18nProvider>
        <MobileProjectsHome {...props} />
      </I18nProvider>,
    );
  });
  return { root, container };
}

function clickMenuTrigger(container: HTMLElement) {
  const trigger = container.querySelector<HTMLButtonElement>('button[aria-label="More actions"]');
  expect(trigger).not.toBeNull();
  act(() => {
    trigger!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  });
}

function findMenuItem(label: string): HTMLElement | null {
  const items = Array.from(document.body.querySelectorAll<HTMLElement>('[data-slot="dropdown-menu-item"]'));
  return items.find((item) => item.textContent?.includes(label)) ?? null;
}

describe('MobileProjectsHome header menu', () => {
  test('plus trigger rotates and shows the base two actions when optional props are absent', async () => {
    const calls: string[] = [];
    const { root, container } = mount({
      ...baseProps,
      onNewSession: () => calls.push('new-session'),
      onAddProject: () => calls.push('add-project'),
    });

    const trigger = container.querySelector<HTMLButtonElement>('button[aria-label="More actions"]');
    expect(trigger).not.toBeNull();
    expect(trigger!.querySelector('svg')?.getAttribute('class')).toContain('rotate-0');

    clickMenuTrigger(container);

    // Base-ui mounts the popup in a portal attached to document.body.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(trigger!.querySelector('svg')?.getAttribute('class')).toContain('rotate-45');

    const bodyText = document.body.textContent ?? '';
    expect(bodyText).toContain('New chat');
    expect(bodyText).toContain('New project');
    expect(bodyText).not.toContain('Scan QR code');
    expect(bodyText).not.toContain('Switch instance');

    const newProjectItem = findMenuItem('New project');
    expect(newProjectItem).not.toBeNull();
    expect(newProjectItem!.querySelector('use')?.getAttribute('href')).toBe('#oc-folder');
    expect(newProjectItem!.getAttribute('role')).toBe('menuitem');

    const newChatItem = findMenuItem('New chat');
    expect(newChatItem).not.toBeNull();
    act(() => {
      newChatItem!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(calls).toEqual(['new-session']);

    root.unmount();
    document.body.innerHTML = '';
  });

  test('scan and switch-instance entries render when their callbacks are provided', async () => {
    const { root, container } = mount({
      ...baseProps,
      onScanQr: noop,
      onSwitchInstance: noop,
    });

    clickMenuTrigger(container);

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    const bodyText = document.body.textContent ?? '';
    expect(bodyText).toContain('Scan QR code');
    expect(bodyText).toContain('Switch instance');

    root.unmount();
    document.body.innerHTML = '';
  });

  test('all four actions use semantic active fill and one global menuitem haptic target', async () => {
    const { root, container } = mount({
      ...baseProps,
      onScanQr: noop,
      onSwitchInstance: noop,
    });

    const trigger = container.querySelector<HTMLButtonElement>('button[aria-label="More actions"]');
    expect(trigger?.getAttribute('data-mobile-press-feedback')).toBe('compact');
    clickMenuTrigger(container);

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    const items = Array.from(document.body.querySelectorAll<HTMLElement>('[data-slot="dropdown-menu-item"]'));
    expect(items).toHaveLength(4);
    for (const item of items) {
      expect(item.getAttribute('role')).toBe('menuitem');
      expect(item.className).toContain('active:bg-interactive-active');
      expect(item.matches(MOBILE_PRESS_TARGET_SELECTOR)).toBe(true);
      expect(item.getAttribute('data-mobile-press-feedback')).toBeNull();
      expect(item.querySelector('svg')?.closest(MOBILE_PRESS_TARGET_SELECTOR)).toBe(item);
    }

    root.unmount();
    document.body.innerHTML = '';
  });
});

describe('MobileProjectsHome global pinned group', () => {
  test('hides the global group while filtering projects', () => {
    const { root, container } = mount({
      ...baseProps,
      pinnedSessions: [{
        id: 'pinned-session',
        kind: 'pagination',
        title: 'Global pinned session',
      }],
    });

    expect(container.textContent).toContain('Global pinned session');
    const searchTrigger = container.querySelector<HTMLButtonElement>('button[aria-label="Search sessions"]');
    expect(searchTrigger).not.toBeNull();
    act(() => searchTrigger!.click());

    const input = container.querySelector<HTMLInputElement>('input[type="text"]');
    expect(input).not.toBeNull();
    act(() => {
      const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      valueSetter?.call(input, 'open');
      input!.dispatchEvent(new Event('input', { bubbles: true }));
    });

    expect(container.textContent).not.toContain('Global pinned session');
    root.unmount();
    document.body.innerHTML = '';
  });
});
