import React from 'react';
import { useI18n } from '@/lib/i18n';
import { useLatestSessionError } from '@/sync/notification-store';
import { useSessionErrorAt } from '@/sync/sync-context';
import { resolveAssistantErrorPresentation } from './message/assistantErrorPresentation';
import { ResponseStatusRow } from './message/ResponseStatusRow';

/** Execution can fail before an assistant message exists to own an inline error. */
export const SessionErrorNotice = ({ sessionId, directory, hasInlineError = false, fallbackHeader }: {
  sessionId: string;
  directory?: string | null;
  hasInlineError?: boolean;
  fallbackHeader?: React.ReactNode;
}) => {
  const { t } = useI18n();
  const notification = useLatestSessionError(sessionId);
  const errorAt = useSessionErrorAt(sessionId, directory ?? undefined);
  if (errorAt === undefined || !notification || hasInlineError) return null;
  if (notification.directory && directory && notification.directory !== directory) return null;
  const presentation = resolveAssistantErrorPresentation(notification.error, t)
    ?? { text: t('chat.chatInput.toast.messageSendFailed'), icon: 'error-warning' as const, variant: 'error' as const };
  return (
    <div className="chat-message-column py-1.5" data-session-error={sessionId}>
      {fallbackHeader ? <div className="pb-2">{fallbackHeader}</div> : null}
      <ResponseStatusRow presentation={presentation} />
    </div>
  );
};
