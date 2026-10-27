import React from 'react';
import { useEvent } from '@reactuses/core';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { useI18n } from '@/lib/i18n';
import { markAllAssistantsRead, type AssistantSnapshot } from '@/queries/assistantQueries';

export function AssistantMarkAllReadButton({ snapshot, rowClassName, compact = false }: { snapshot: AssistantSnapshot; rowClassName?: string; compact?: boolean }) {
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
  return <div className={rowClassName} style={compact && !hasUnread ? { visibility: 'hidden' } : undefined}><Button type="button" variant="ghost" size="xs" onClick={markAll}
    className={compact ? 'h-auto bg-transparent px-1 py-1 text-[11px] font-normal text-muted-foreground hover:bg-transparent whitespace-nowrap' : 'max-w-full whitespace-normal text-right'}
    disabled={pending || !snapshot.assistants.some((assistant) => (assistant.unreadCount ?? 0) > 0 && assistant.readTip)}
    aria-busy={pending}
  >{t('assistants.unread.markAll')}</Button></div>;
}
