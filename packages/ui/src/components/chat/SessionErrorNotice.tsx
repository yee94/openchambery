import React from 'react';
import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';
import { useLatestSessionError } from '@/sync/notification-store';
import { useSessionErrorAt } from '@/sync/sync-context';
import { resolveAssistantErrorPresentation } from './message/assistantErrorPresentation';

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
  const presentation = resolveAssistantErrorPresentation(notification.error, t('chat.messageBody.aborted'));
  const text = presentation?.text ?? t('chat.chatInput.toast.messageSendFailed');
  return (
    <div className="chat-message-column py-1.5" data-session-error={sessionId}>
      {fallbackHeader ? <div className="pb-2">{fallbackHeader}</div> : null}
      <div role="alert" className="flex w-full min-w-0 items-start gap-1.5 typography-meta leading-5 text-muted-foreground">
        <span className="inline-flex h-5 shrink-0 items-center" aria-hidden="true">
          <Icon name="error-warning" className="size-3.5 text-[var(--status-error)]/85" />
        </span>
        <span className="min-w-0 flex-1 whitespace-pre-wrap [overflow-wrap:anywhere]">{text}</span>
      </div>
    </div>
  );
};
