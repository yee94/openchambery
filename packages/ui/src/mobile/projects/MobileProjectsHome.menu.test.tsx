import { describe, expect, test } from 'vitest';
import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { I18nProvider } from '@/lib/i18n';

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
});
