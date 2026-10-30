import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { AssistantAvatarEditor } from './AssistantAvatarEditor';
import { AVATAR_PICKER_SHAPES, AVATAR_COLORS, encodeAssistantAvatar, resolveAssistantAvatar } from '@/lib/assistant-avatar/recipe';

vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('@/components/chat/AgentAvatar', () => ({ AgentAvatar: ({ name }: { name: string }) => <span data-preview-seed={name} /> }));
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement;
let root: Root;
beforeEach(() => { host = document.createElement('div'); document.body.append(host); root = createRoot(host); });
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });

test('shows visual shape tiles, color swatches and randomize without a separate preview, title or reset', async () => {
  await act(async () => root.render(<AssistantAvatarEditor seed="saved" disabled={false} onChange={vi.fn()} />));
  expect(host.querySelectorAll('[data-avatar-shape-option]')).toHaveLength(16);
  expect(AVATAR_PICKER_SHAPES).toHaveLength(16);
  expect(host.querySelector('[data-avatar-shape-option="tall"],[data-avatar-shape-option="compact"],[data-avatar-shape-option="large"]')).toBeNull();
  expect(host.querySelectorAll('[data-avatar-color-option]')).toHaveLength(AVATAR_COLORS.length);
  expect(host.querySelectorAll('button')).toHaveLength(AVATAR_PICKER_SHAPES.length + AVATAR_COLORS.length + 1);
  expect(host.textContent).toBe('assistants.settings.randomAvatar');
  expect(host.querySelector('select,[role="combobox"],[role="checkbox"]')).toBeNull();
  expect(host.textContent).not.toMatch(/assistants\.avatar\.(eyes|expression|animate|motion)/);
});

test('randomize updates the draft with a new valid seed', async () => {
  const change = vi.fn();
  await act(async () => root.render(<AssistantAvatarEditor seed="saved" disabled={false} onChange={change} />));
  await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="assistants.settings.randomAvatar"]')!.click());
  const seed = change.mock.lastCall?.[0];
  expect(seed).toMatch(/^[0-9a-f-]{36}$/);
  expect(seed).not.toBe('saved');
  expect(resolveAssistantAvatar(seed)).toBeDefined();
});

test('tile changes preserve hidden preferences', async () => {
  const original = encodeAssistantAvatar({ shape: 'soft', color: 'mint', eyes: 'oval', expression: 'beaming', animate: false }, 'saved');
  const changed = vi.fn();
  function Editor() {
    const [seed, setSeed] = React.useState(original);
    return <AssistantAvatarEditor seed={seed} disabled={false} onChange={(next) => { changed(next); setSeed(next); }} />;
  }
  await act(async () => root.render(<Editor />));
  await act(async () => host.querySelector<HTMLButtonElement>('[data-avatar-shape-option="cloud"]')!.click());
  await act(async () => host.querySelector<HTMLButtonElement>('[data-avatar-color-option="iris"]')!.click());
  expect(resolveAssistantAvatar(changed.mock.lastCall?.[0])).toEqual({ shape: 'cloud', color: 'iris', eyes: 'oval', expression: 'beaming', animate: false });
  expect(host.querySelector('[data-avatar-shape-option="cloud"]')?.getAttribute('aria-pressed')).toBe('true');
});

test('pending save disables every configuration mutation', async () => {
  const change = vi.fn();
  await act(async () => root.render(<AssistantAvatarEditor seed="draft" disabled onChange={change} />));
  await act(async () => host.querySelectorAll('button').forEach((button) => button.click()));
  expect(Array.from(host.querySelectorAll('button')).every((button) => button.disabled)).toBe(true);
  expect(change).not.toHaveBeenCalled();
});

test.each(['tall', 'compact', 'large'] as const)('retains the saved %s face when changing color even though its tile is retired', async (shape) => {
  const original = encodeAssistantAvatar({ shape, color: 'mint', eyes: 'oval', expression: 'beaming', animate: false }, 'saved');
  const change = vi.fn();
  await act(async () => root.render(<AssistantAvatarEditor seed={original} disabled={false} onChange={change} />));
  expect(host.querySelector(`[data-avatar-shape-option="${shape}"]`)).toBeNull();
  expect(change).not.toHaveBeenCalled();
  await act(async () => host.querySelector<HTMLButtonElement>('[data-avatar-color-option="iris"]')!.click());
  expect(resolveAssistantAvatar(change.mock.lastCall?.[0])).toEqual({ shape, color: 'iris', eyes: 'oval', expression: 'beaming', animate: false });
});
