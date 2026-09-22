import React from 'react';
import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';
import { useLatestSessionError } from '@/sync/notification-store';
import { useSessionErrorAt } from '@/sync/sync-context';
import { resolveAssistantErrorPresentation } from './message/assistantErrorPresentation';

/** Execution can fail before an assistant message exists to own an inline error. */
export const SessionErrorNotice = ({ sessionId, directory, hasInlineError = false }: {
  sessionId: string;
  directory?: string | null;
  hasInlineError?: boolean;
}) => {
  const { t } = useI18n();
  const notification = useLatestSessionError(sessionId);
  const errorAt = useSessionErrorAt(sessionId, directory ?? undefined);
  if (errorAt === undefined || !notification || hasInlineError) return null;
  if (notification.directory && directory && notification.directory !== directory) return null;
  const presentation = resolveAssistantErrorPresentation(notification.error, t('chat.messageBody.aborted'));
  const text = presentation?.text ?? t('chat.chatInput.toast.messageSendFailed');
  return (
    <div className="chat-column pb-2" data-session-error={sessionId}>
      <div role="alert" className="inline-flex max-w-full items-start gap-1.5 rounded-md border border-[var(--status-error-border)]/45 bg-[var(--status-error-background)]/50 px-2 py-1 typography-meta text-[var(--status-error)]">
        <Icon name="error-warning" className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
        <span className="min-w-0 whitespace-pre-wrap break-words">{text}</span>
      </div>
    </div>
  );
};
