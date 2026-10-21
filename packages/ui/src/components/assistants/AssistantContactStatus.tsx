import React from 'react';
import { useI18n } from '@/lib/i18n';
import { useRuntimeTransportIdentity } from '@/components/chat/imageSource';
import { useAssistantLastContactQuery } from '@/queries/assistantContactStatus';
import { useAssistantWorking } from './assistantWorking';
import { createContactTimeFormatter } from './contactMessageTime';

type AssistantContactStatusProps = {
  assistantID: string;
  serverWorking: boolean;
  lastContactAt?: number;
};

export const AssistantContactStatus: React.FC<AssistantContactStatusProps> = React.memo(({ assistantID, serverWorking, lastContactAt }) => {
  const { t, locale } = useI18n();
  const working = useAssistantWorking(assistantID, serverWorking);
  const transport = useRuntimeTransportIdentity();
  const contactQuery = useAssistantLastContactQuery(assistantID, transport);
  const timestamp = lastContactAt !== undefined && Number.isFinite(new Date(lastContactAt).getTime())
    ? lastContactAt : contactQuery.data?.timestamp;
  const today = new Date().toDateString();
  const todayLabel = t('common.date.today');
  const lastContact = React.useMemo(() => {
    if (timestamp === undefined) return null;
    return createContactTimeFormatter(locale, todayLabel, new Date(today))(timestamp);
  }, [timestamp, locale, todayLabel, today]);
  const label = working
    ? t('assistants.conversation.typing')
    : lastContact
      ? t('assistants.conversation.lastContact', { time: lastContact })
      : contactQuery.data?.empty
        ? t('assistants.conversation.neverContacted')
        : contactQuery.isError ? t('assistants.contact.loadFailed') : t('common.loading');

  return <span className="mt-1 block truncate typography-micro font-normal leading-4 text-muted-foreground/70" aria-live="polite" title={label}>{label}</span>;
});
