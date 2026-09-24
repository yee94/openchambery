import { useStore } from 'zustand';
import { useDirectoryStore } from '@/sync/sync-context';
import { useI18n } from '@/lib/i18n';
import { ResponseStatusRow } from './message/ResponseStatusRow';

export function SessionRecoveryNotice({ sessionId, directory }: { sessionId: string; directory: string }) {
  const store = useDirectoryStore(directory, { bootstrap: false });
  const recovering = useStore(store, (state) => state.session_execution_recovery[sessionId]?.reason === 'shutdown');
  const { t } = useI18n();
  if (!recovering) return null;
  return (
    <div className="px-4 py-1.5" aria-live="polite">
      <ResponseStatusRow presentation={{
        text: t('chat.sessionRecovery.awaitingConfirmation'),
        icon: 'restart',
        variant: 'info',
      }} />
    </div>
  );
}
