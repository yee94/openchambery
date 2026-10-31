import React from 'react';
import { useEvent } from '@reactuses/core';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';
import { markAllAssistantsRead, type AssistantSnapshot } from '@/queries/assistantQueries';

export function AssistantMarkAllReadButton({ snapshot, rowClassName, compact = false, mobile = false }: { snapshot: AssistantSnapshot; rowClassName?: string; compact?: boolean; mobile?: boolean }) {
  const { t } = useI18n();
  const [pending, setPending] = React.useState(false);
  const flight = React.useRef(false);
  const markAll = useEvent(async () => {
    if (flight.current) return;
    flight.current = true;
    setPending(true);
    try {
      const result = await markAllAssistantsRead(snapshot);
      if (result.failed) toast.error(t('assistants.unread.markAllFailed'));
    } catch { toast.error(t('assistants.unread.markAllFailed')); }
    finally { flight.current = false; setPending(false); }
  });
  const hasUnread = snapshot.assistants.some((assistant) => (assistant.unreadCount ?? 0) > 0);
  if (!compact && !hasUnread) return null;
  return <div className={rowClassName} style={compact && !hasUnread ? { visibility: 'hidden' } : undefined}><Button type="button" variant={mobile ? 'mobileGlass' : 'ghost'} size={mobile ? 'mobileIcon' : 'icon'} onClick={markAll}
    aria-label={t('assistants.unread.markAll')}
    title={t('assistants.unread.markAll')}
    disabled={pending || !snapshot.assistants.some((assistant) => (assistant.unreadCount ?? 0) > 0 && assistant.readTip)}
    aria-busy={pending}
  ><Icon name="check-double" className={mobile ? 'size-5' : 'size-4'} /></Button></div>;
}
