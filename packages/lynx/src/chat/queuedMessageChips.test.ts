import { describe, expect, test } from 'vitest';

import {
  canRemoveLynxQueueChip,
  canSendNowLynxQueueChip,
  lynxQueuedMessagePreviewLine,
  moveLynxQueueChip,
  reorderLynxQueueChips,
  shouldShowLynxQueueShell,
  toLynxQueueChipItems,
} from './queuedMessageChips';

describe('lynxQueuedMessagePreviewLine', () => {
  test('trims and takes first line', () => {
    expect(lynxQueuedMessagePreviewLine('  hello\nworld  ')).toBe('hello');
  });

  test('truncates long text', () => {
    const long = 'a'.repeat(140);
    expect(lynxQueuedMessagePreviewLine(long).endsWith('…')).toBe(true);
    expect(lynxQueuedMessagePreviewLine(long).length).toBeLessThanOrEqual(120);
  });
});

describe('chip action gates', () => {
  test('remove blocked while sending', () => {
    expect(canRemoveLynxQueueChip({ id: '1', text: 'x', createdAt: 1, sending: true })).toBe(false);
    expect(canRemoveLynxQueueChip({ id: '1', text: 'x', createdAt: 1 })).toBe(true);
  });

  test('send-now blocked while working or sending', () => {
    const item = { id: '1', text: 'hi', createdAt: 1 };
    expect(canSendNowLynxQueueChip(item)).toBe(true);
    expect(canSendNowLynxQueueChip(item, { sessionIsWorking: true })).toBe(false);
    expect(canSendNowLynxQueueChip({ ...item, sending: true })).toBe(false);
    expect(canSendNowLynxQueueChip({ id: '1', text: '  ', createdAt: 1 })).toBe(false);
  });
});

describe('portable reorder', () => {
  const items = [
    { id: 'a', text: '1', createdAt: 1 },
    { id: 'b', text: '2', createdAt: 2 },
    { id: 'c', text: '3', createdAt: 3 },
  ];

  test('reorderLynxQueueChips moves active onto over', () => {
    expect(reorderLynxQueueChips(items, 'a', 'c').map((i) => i.id)).toEqual(['b', 'c', 'a']);
    expect(reorderLynxQueueChips(items, 'c', 'a').map((i) => i.id)).toEqual(['c', 'a', 'b']);
  });

  test('move up/down', () => {
    expect(moveLynxQueueChip(items, 'b', 'up').map((i) => i.id)).toEqual(['b', 'a', 'c']);
    expect(moveLynxQueueChip(items, 'b', 'down').map((i) => i.id)).toEqual(['a', 'c', 'b']);
    expect(moveLynxQueueChip(items, 'a', 'up').map((i) => i.id)).toEqual(['a', 'b', 'c']);
  });
});

describe('shell visibility', () => {
  test('opens for chips or trailing only', () => {
    expect(shouldShowLynxQueueShell(0, false)).toBe(false);
    expect(shouldShowLynxQueueShell(1, false)).toBe(true);
    expect(shouldShowLynxQueueShell(0, true)).toBe(true);
  });

  test('toLynxQueueChipItems maps sending set', () => {
    const chips = toLynxQueueChipItems(
      [{ id: 'q1', text: 'hi', createdAt: 1 }],
      new Set(['q1']),
    );
    expect(chips[0]?.sending).toBe(true);
  });
});
