import type { AssistantDTO } from '@/queries/assistantDTO';

/** Newest visible contact message first. Read/config state never changes this order. */
export function sortAssistantContacts<T extends Pick<AssistantDTO, 'latestMessagePreview'>>(contacts: readonly T[]): T[] {
  return [...contacts].sort((a, b) => {
    const left = a.latestMessagePreview?.createdAt ?? Number.NEGATIVE_INFINITY;
    const right = b.latestMessagePreview?.createdAt ?? Number.NEGATIVE_INFINITY;
    return left === right ? 0 : right - left;
  });
}
