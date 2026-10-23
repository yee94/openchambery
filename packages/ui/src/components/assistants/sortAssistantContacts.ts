import type { AssistantDTO } from '@/queries/assistantDTO';

/** Unread contacts first, then newest visible message; configuration never ranks contacts. */
export function sortAssistantContacts<T extends Pick<AssistantDTO, 'latestMessagePreview'> & { unreadCount?: number }>(contacts: readonly T[]): T[] {
  return [...contacts].sort((a, b) => {
    const unread = Number((b.unreadCount ?? 0) > 0) - Number((a.unreadCount ?? 0) > 0);
    if (unread) return unread;
    const left = a.latestMessagePreview?.createdAt ?? Number.NEGATIVE_INFINITY;
    const right = b.latestMessagePreview?.createdAt ?? Number.NEGATIVE_INFINITY;
    return left === right ? 0 : right - left;
  });
}
