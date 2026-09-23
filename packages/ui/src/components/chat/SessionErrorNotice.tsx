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
      <div role="alert" className="inline-flex w-fit max-w-full items-start gap-1.5 rounded-lg border border-[var(--status-error-border)]/45 bg-[var(--status-error-background)]/50 px-2 py-0.5 typography-meta text-muted-foreground">
        <Icon name="error-warning" className="mt-0.5 size-3.5 shrink-0 text-[var(--status-error)]" aria-hidden="true" />
        <span className="min-w-0 whitespace-pre-wrap [overflow-wrap:anywhere]">{text}</span>
      </div>
    </div>
  );
};
