import { useQuery } from '@tanstack/react-query';
import { assistantContactQueryOptions } from './assistantQueries';
import { isContactVisiblePart, type ContactMessagesView } from './assistantContactMessages';

const selectLastContact = (view: ContactMessagesView) => {
  for (let index = view.messages.length - 1; index >= 0; index--) {
    const message = view.messages[index];
    if (message.parts.some(isContactVisiblePart) && Number.isFinite(new Date(message.createdAt).getTime())) {
      return { timestamp: message.createdAt, empty: false };
    }
  }
  return { timestamp: undefined, empty: view.generation >= 0 && view.olderComplete && !view.hasMessageGap };
};

/** Passive projection: the contact surface owns fetching and refresh. */
export const useAssistantLastContactQuery = (assistantID: string, transport: string) => useQuery({
  ...assistantContactQueryOptions(assistantID, transport),
  enabled: false,
  select: selectLastContact,
});
