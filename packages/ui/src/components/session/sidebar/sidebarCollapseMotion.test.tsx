import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionFolderItem } from '../SessionFolderItem';

vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('@/components/icon/Icon', () => ({ Icon: () => null }));
vi.mock('./utils', () => ({ getSidebarRowPaddingLeft: (depth: number) => depth * 22, SIDEBAR_ROW_HOVER_CLASS: '' }));

const here = dirname(fileURLToPath(import.meta.url));
let host: HTMLDivElement;
let styles: HTMLStyleElement;
let root: Root;
let finishAnimation: () => void;
let animations: { finished: Promise<void> }[];
const originalGetAnimations = Object.getOwnPropertyDescriptor(Element.prototype, 'getAnimations');

async function frames() {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 80)); });
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  styles = document.createElement('style');
  styles.textContent = '[class*="transition-[height]"] { animation-name: none; transition-property: height; transition-duration: 0.2s; }';
  document.head.append(styles);
  animations = [];
  Object.defineProperty(Element.prototype, 'getAnimations', { configurable: true, value: () => animations });
  vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(120);
  vi.spyOn(HTMLElement.prototype, 'scrollWidth', 'get').mockReturnValue(240);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  styles.remove();
  vi.restoreAllMocks();
  if (originalGetAnimations) Object.defineProperty(Element.prototype, 'getAnimations', originalGetAnimations);
  else Reflect.deleteProperty(Element.prototype, 'getAnimations');
  vi.unstubAllGlobals();
});

function beginAnimation() {
  animations = [{ finished: new Promise<void>((resolve) => { finishAnimation = resolve; }) }];
}

async function renderFolder(collapsed: boolean, onToggle = vi.fn(), child = <span key="row" data-row>Session</span>) {
  await act(async () => root.render(
    <SessionFolderItem
      folder={{ id: 'folder', name: 'Folder', sessionIds: ['session'], createdAt: 0 }}
      sessions={['session']}
      isCollapsed={collapsed}
      onToggle={onToggle}
      onRename={vi.fn()}
      onDelete={vi.fn()}
      renderSessionNode={() => child}
    />,
  ));
}

describe('sidebar collapse motion', () => {
  it('mounts on expansion, retains inert rows during exit, and unmounts on animation completion', async () => {
    const mounted = vi.fn();
    const unmounted = vi.fn();
    function Row() {
      React.useEffect(() => { mounted(); return unmounted; }, []);
      return <span data-row>Session</span>;
    }
    const child = <Row key="row" />;
    await renderFolder(true, undefined, child);
    expect(host.querySelector('[data-row]')).toBeNull();
    expect(mounted).toHaveBeenCalledTimes(0);

    await renderFolder(false, undefined, child);
    await frames();
    expect(mounted).toHaveBeenCalledTimes(1);
    beginAnimation();
    await renderFolder(true, undefined, child);
    await frames();
    expect(host.querySelector('[data-row]')).not.toBeNull();
    expect(host.querySelector('[data-ending-style][inert]')).not.toBeNull();
    expect(unmounted).toHaveBeenCalledTimes(0);

    await act(async () => { animations = []; finishAnimation(); });
    await frames();
    expect(host.querySelector('[data-row]')).toBeNull();
    expect(unmounted).toHaveBeenCalledTimes(1);
    await renderFolder(false, undefined, child);
    await frames();
    expect(mounted).toHaveBeenCalledTimes(2);
  });

  it('keeps a reopened body when an interrupted exit settles', async () => {
    await renderFolder(false);
    await frames();
    beginAnimation();
    await renderFolder(true);
    await frames();
    await renderFolder(false);
    await act(async () => { animations = []; finishAnimation(); });
    await frames();
    expect(host.querySelector('[data-row]')).not.toBeNull();
    expect(host.querySelector('[inert]')).toBeNull();
  });

  it('keeps the existing header in control and closes without a running animation', async () => {
    const toggle = vi.fn();
    await renderFolder(false, toggle);
    await frames();
    await act(async () => host.querySelector<HTMLElement>('[role="button"]')!.click());
    expect(toggle).toHaveBeenCalledTimes(1);
    expect(host.querySelector('[data-row]')).not.toBeNull();
    expect(host.querySelector('button button')).toBeNull();
    await renderFolder(true, toggle);
    await frames();
    expect(host.querySelector('[data-row]')).toBeNull();
  });

  it('unmounts with transitions disabled for reduced motion', async () => {
    styles.textContent = '[data-sidebar-collapse] { animation-name: none; transition-duration: 0s; transition-property: none; }';
    await renderFolder(false);
    await frames();
    expect(host.querySelector('[data-row]')).not.toBeNull();
    await renderFolder(true);
    expect(host.querySelector('[data-row]')).toBeNull();
  });

  it.each(['SidebarProjectsList.tsx', 'SessionGroupSection.tsx', '../SessionFolderItem.tsx'])(
    '%s shares the bounded height/presence recipe', (file) => {
      const source = readFileSync(join(here, file), 'utf8');
      expect(source).toContain('<Collapsible open={!isCollapsed}');
      expect(source).toContain('h-[var(--collapsible-panel-height)] transition-[height] duration-200 ease-out');
      expect(source).toContain('data-[starting-style]:h-0 data-[ending-style]:h-0');
      expect(source).toContain('motion-reduce:transition-none');
      expect(source).toContain('inert={isCollapsed || undefined}');
      expect(source).toContain('data-sidebar-collapse');
      expect(source).not.toContain('keepMounted');
      expect(source).not.toContain('<CollapsibleTrigger');
    },
  );

  it('preserves search expansion and ties virtual layout invalidation to actual presence', () => {
    const source = readFileSync(join(here, 'SessionGroupSection.tsx'), 'utf8');
    expect(source).toContain('const isCollapsed = hasSessionSearchQuery ? false : collapsedGroups.has(groupKey)');
    expect(source).toContain('isCollapsed={hasSessionSearchQuery ? false : collapsedFolderIds.has(folder.id)}');
    expect(source).toContain('<div ref={setVirtualContainer}>');
    expect(source).toContain('archivedVirtualContainerRef.current = node;');
    expect(source).toContain('setLayoutVersion((version) => version + 1)');
    expect(source).toContain("useEventListener('transitionend'");
    expect(source).toContain("event.target.hasAttribute('data-sidebar-collapse')");
    expect(source).toContain('virtualizerReady ? archivedScrollEl : null');
  });
});
