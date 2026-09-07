import { describe, expect, test } from 'vitest';

import type { MobileSessionTreeNode } from './MobileProjectsHome';
import {
  reuseMobileSessionTreeNode,
  reuseMobileSessionTreeNodeList,
} from './mobileSessionTreeNode';

const node = (
  id: string,
  overrides: Partial<MobileSessionTreeNode> = {},
): MobileSessionTreeNode => ({
  id,
  title: `Session ${id}`,
  directory: '/repo',
  unread: false,
  pinned: false,
  ...overrides,
});

describe('reuseMobileSessionTreeNode', () => {
  test('returns the previous object when display fields are identical', () => {
    const previous = node('a');
    const next = node('a');
    expect(reuseMobileSessionTreeNode(previous, next)).toBe(previous);
  });

  test('allocates a new object when a display field changes', () => {
    const previous = node('a', { unread: false });
    const next = node('a', { unread: true });
    const reused = reuseMobileSessionTreeNode(previous, next);
    expect(reused).not.toBe(previous);
    expect(reused.unread).toBe(true);
  });

  test('treats children array identity as part of equality', () => {
    const child = node('child');
    const previous = node('a', { children: [child] });
    const nextSameChildren = node('a', { children: previous.children });
    expect(reuseMobileSessionTreeNode(previous, nextSameChildren)).toBe(previous);

    const nextNewChildren = node('a', { children: [child] });
    expect(reuseMobileSessionTreeNode(previous, nextNewChildren)).not.toBe(previous);
  });
});

describe('reuseMobileSessionTreeNodeList', () => {
  test('keeps identity for unchanged rows across a 40+ list rebuild', () => {
    const previous = Array.from({ length: 48 }, (_, index) => node(`s${index}`));
    // Simulate a parent model rebuild where only s7's unread flips.
    const next = previous.map((entry, index) => (
      index === 7
        ? node(entry.id, { unread: true })
        : node(entry.id)
    ));

    const reused = reuseMobileSessionTreeNodeList(previous, next);

    let stable = 0;
    let changed = 0;
    for (let i = 0; i < reused.length; i += 1) {
      if (reused[i] === previous[i]) stable += 1;
      else changed += 1;
    }

    expect(reused).toHaveLength(48);
    expect(stable).toBe(47);
    expect(changed).toBe(1);
    expect(reused[7]?.unread).toBe(true);
    expect(reused[7]).not.toBe(previous[7]);
  });

  test('returns the previous array reference when every row is unchanged', () => {
    const previous = Array.from({ length: 12 }, (_, index) => node(`s${index}`));
    const next = previous.map((entry) => node(entry.id));
    expect(reuseMobileSessionTreeNodeList(previous, next)).toBe(previous);
  });
});
