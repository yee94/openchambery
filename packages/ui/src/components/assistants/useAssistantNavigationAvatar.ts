import { useAssistantSnapshotQuery, type AssistantSnapshot } from '@/queries/assistantQueries';
import { generatedAvatarDataUri } from '@/lib/generatedAvatar';
import { useAssistantWorking } from './assistantWorking';
import { sortAssistantContacts } from './sortAssistantContacts';

const selectNavigationContact = (snapshot: AssistantSnapshot) => {
  if (!snapshot.enabled) return null;
  const contact = sortAssistantContacts(snapshot.assistants.filter((item) => item.enabled))[0];
  if (!contact) return null;
  return { id: contact.id, seed: contact.avatarSeed ?? contact.id, working: Boolean(contact.working || contact.activeContactTurn) };
};

/** Shared identity and live animation for web and native navigation icons. */
export function useAssistantNavigationAvatar(): string | null {
  const { data: contact } = useAssistantSnapshotQuery(selectNavigationContact);
  const working = useAssistantWorking(contact?.id ?? '', contact?.working);
  return contact ? generatedAvatarDataUri('assistant', contact.seed, working) : null;
}
