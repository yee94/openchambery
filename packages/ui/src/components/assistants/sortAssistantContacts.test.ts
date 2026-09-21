import { expect, test } from 'vitest';
import { sortAssistantContacts } from './sortAssistantContacts';
const contact = (id: string, createdAt?: number) => ({ id, unreadCount: 0, updatedAt: 0, latestMessagePreview: createdAt === undefined ? null : { createdAt, messageID: id, ordinal: 1, role: 'user' as const, text: id, fallbackKind: null } });
test('latest message time ranks contacts independently of unread and config changes', () => {
  const input = [{ ...contact('old', 10), unreadCount: 99, updatedAt: 999 }, contact('new', 20)];
  expect(sortAssistantContacts(input).map(item => item.id)).toEqual(['new', 'old']);
  const read = input.map(item => ({ ...item, unreadCount: 0, updatedAt: 1000 }));
  expect(sortAssistantContacts(read).map(item => item.id)).toEqual(['new', 'old']);
  expect(input.map(item => item.id)).toEqual(['old', 'new']);
});
test('equal timestamps retain input order and empty or legacy histories remain at the bottom', () => {
  const input = [contact('empty'), contact('first', 20), contact('second', 20), contact('legacy')];
  expect(sortAssistantContacts(input).map(item => item.id)).toEqual(['first', 'second', 'empty', 'legacy']);
});
