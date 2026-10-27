import type { AssistantDTO } from '@/queries/assistantDTO';

/** Newest visible message first; read state and configuration never rank contacts. */
export function sortAssistantContacts<T extends Pick<AssistantDTO, 'latestMessagePreview'> & { unreadCount?: number }>(contacts: readonly T[]): T[] {
  return [...contacts].sort((a, b) => {
    const left = a.latestMessagePreview?.createdAt ?? Number.NEGATIVE_INFINITY;
    const right = b.latestMessagePreview?.createdAt ?? Number.NEGATIVE_INFINITY;
    return left === right ? 0 : right - left;
  });
}
