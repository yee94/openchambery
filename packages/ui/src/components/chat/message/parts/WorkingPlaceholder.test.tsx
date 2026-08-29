import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { WorkingPlaceholder } from './WorkingPlaceholder';

vi.mock('@/lib/i18n', () => ({
  useI18n: () => ({
    locale: 'en',
    t: (key: string) => key,
  }),
}));

vi.mock('./MorphOrb', () => ({
  MorphOrb: () => React.createElement('span', { 'data-testid': 'orb' }),
}));

describe('WorkingPlaceholder status stickiness', () => {
  let container: HTMLElement;
  let root: Root;

  beforeEach(() => {
    vi.useFakeTimers({
      toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'],
    });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    vi.useRealTimers();
    document.body.innerHTML = '';
  });

  const render = async (
    props: Omit<React.ComponentProps<typeof WorkingPlaceholder>, 'isMobile'>,
  ) => {
    await act(async () => {
      root.render(React.createElement(WorkingPlaceholder, { isMobile: false, ...props }));
    });
  };

  const text = () => container.textContent ?? '';

  test('specific → generic does not switch within 1200ms (queued)', async () => {
    await render({
      isWorking: true,
      statusText: 'Running command',
      isGenericStatus: false,
    });
    expect(text()).toContain('Running command');

    await render({
      isWorking: true,
      statusText: 'Working…',
      isGenericStatus: true,
    });
    expect(text()).toContain('Running command');
    expect(text()).not.toContain('Working…');

    await act(async () => {
      vi.advanceTimersByTime(1199);
    });
    expect(text()).toContain('Running command');

    await act(async () => {
      vi.advanceTimersByTime(1);
    });
    expect(text()).toContain('Working…');
  });

  test('generic → generic churn is ignored', async () => {
    await render({
      isWorking: true,
      statusText: 'Thinking…',
      isGenericStatus: true,
    });
    expect(text()).toContain('Thinking…');

    await render({
      isWorking: true,
      statusText: 'Working…',
      isGenericStatus: true,
    });
    expect(text()).toContain('Thinking…');
    expect(text()).not.toContain('Working…');

    await act(async () => {
      vi.advanceTimersByTime(2000);
    });
    expect(text()).toContain('Thinking…');
  });

  test('specific → specific switches immediately', async () => {
    await render({
      isWorking: true,
      statusText: 'Running command',
      isGenericStatus: false,
    });
    await render({
      isWorking: true,
      statusText: 'Editing file',
      isGenericStatus: false,
    });
    expect(text()).toContain('Editing file');
  });

  test('isWorking false then true within 600ms keeps the status text', async () => {
    await render({
      isWorking: true,
      statusText: 'Running command',
      isGenericStatus: false,
    });
    expect(text()).toContain('Running command');

    await render({
      isWorking: false,
      statusText: 'Running command',
      isGenericStatus: false,
    });
    // Linger: still visible during the clear delay.
    expect(text()).toContain('Running command');

    await act(async () => {
      vi.advanceTimersByTime(400);
    });
    await render({
      isWorking: true,
      statusText: 'Running command',
      isGenericStatus: false,
    });
    expect(text()).toContain('Running command');

    await act(async () => {
      vi.advanceTimersByTime(600);
    });
    expect(text()).toContain('Running command');
  });

  test('isWorking false for more than 600ms clears the status', async () => {
    await render({
      isWorking: true,
      statusText: 'Running command',
      isGenericStatus: false,
    });

    await render({
      isWorking: false,
      statusText: null,
      isGenericStatus: false,
    });
    expect(text()).toContain('Running command');

    await act(async () => {
      vi.advanceTimersByTime(600);
    });
    expect(text()).not.toContain('Running command');
    expect(container.querySelector('[role="status"]')).toBeNull();
  });

  test('isTurnSettled clears the status immediately without the 600ms linger', async () => {
    await render({
      isWorking: true,
      statusText: 'Thinking',
      isGenericStatus: false,
    });
    expect(text()).toContain('Thinking');

    await render({
      isWorking: false,
      statusText: null,
      isGenericStatus: false,
      isTurnSettled: true,
    });
    expect(text()).not.toContain('Thinking');
    expect(container.querySelector('[role="status"]')).toBeNull();
  });

  test('isTurnSettled hides the hint even while isWorking is still true', async () => {
    await render({
      isWorking: true,
      statusText: 'Composing',
      isGenericStatus: false,
    });
    expect(text()).toContain('Composing');

    await render({
      isWorking: true,
      statusText: 'Composing',
      isGenericStatus: false,
      isTurnSettled: true,
    });
    expect(text()).not.toContain('Composing');
    expect(container.querySelector('[role="status"]')).toBeNull();
  });
});
