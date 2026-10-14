import { expect, test } from 'vitest';

import { resolveMobileTabMark } from './mobileTabActivity';

test('unread replaces a loading mark, and loading appears only at zero unread', () => {
  expect(resolveMobileTabMark({ unreadCount: 3, working: true })).toBe('unread');
  expect(resolveMobileTabMark({ unreadCount: 1, working: false })).toBe('unread');
  expect(resolveMobileTabMark({ unreadCount: 0, working: true })).toBe('loading');
  expect(resolveMobileTabMark({ unreadCount: 0, working: false })).toBeNull();
});
