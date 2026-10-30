import { useAssistantSnapshotQuery, type AssistantSnapshot } from '@/queries/assistantQueries';
import { sortAssistantContacts } from './sortAssistantContacts';

const selectNavigationContact = (snapshot: AssistantSnapshot) => {
  if (!snapshot.enabled) return null;
  const contact = sortAssistantContacts(snapshot.assistants.filter((item) => item.enabled))[0];
  if (!contact) return null;
  return { id: contact.id, seed: contact.avatarSeed ?? contact.id };
};

/** Navigation identity seed; ambient animation is separate from activity badges. */
export function useAssistantNavigationAvatar(): string | null {
  const { data: contact } = useAssistantSnapshotQuery(selectNavigationContact);
  return contact?.seed ?? null;
}
