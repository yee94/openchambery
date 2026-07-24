import * as React from 'react';

import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import {
  useCurrentSessionEntity,
  useScopedSessionStatusReader,
  useScopedSessionStatusRevision,
} from '@/sync/sync-context';
import type { ScopedSessionStatusScope } from '@/sync/scoped-session-status';

import { MobileChatHeader } from './MobileChatHeader';

export type MobileChatScreenProps = {
  /** Empty string = new-session draft mode (no entity/status lookups). */
  sessionId: string;
  directory?: string | null;
  title?: string;
  subtitle?: string;
  busy?: boolean;
  onBack: () => void;
  onOpenMenu: () => void;
  children: React.ReactNode;
  headerTrailing?: React.ReactNode;
  className?: string;
};

/**
 * Second-level mobile shell around the existing primary ChatView. The shell
 * owns floating navigation and atmospheric edge chrome while ChatView keeps
 * message, composer, draft, and send behavior.
 */
export function MobileChatScreen({
  sessionId,
  directory,
  title,
  subtitle,
  busy,
  onBack,
  onOpenMenu,
  children,
  headerTrailing,
  className,
}: MobileChatScreenProps) {
  const { t } = useI18n();
  const isDraft = sessionId.length === 0;
  const session = useCurrentSessionEntity(isDraft ? null : sessionId);
  const resolvedDirectory = directory?.trim() || session?.directory?.trim() || null;
  const statusScopes = React.useMemo<ScopedSessionStatusScope[]>(
    () => (!isDraft && resolvedDirectory) ? [{ directory: resolvedDirectory, sessionID: sessionId }] : [],
    [isDraft, resolvedDirectory, sessionId],
  );
  useScopedSessionStatusRevision(statusScopes);
  const readScopedStatus = useScopedSessionStatusReader();
  const scopedStatus = statusScopes[0] ? readScopedStatus(statusScopes[0]) : 'unknown';
  const resolvedStatus = busy === true ? 'busy' : busy === false ? 'idle' : scopedStatus;
  const resolvedTitle = isDraft
    ? (title?.trim() || t('mobile.menu.newSession'))
    : (title?.trim() || session?.title?.trim() || t('mobile.sessions.untitled'));
  const resolvedSubtitle = subtitle?.trim() || (isDraft
    ? undefined
    : resolvedStatus === 'busy'
      ? t('miniChat.status.busy')
      : resolvedStatus === 'retry'
        ? t('miniChat.status.retry')
        : resolvedStatus === 'idle'
          ? t('miniChat.status.idle')
          : undefined
  );

  return (
    <main
      className={cn(
        'relative isolate flex h-full min-h-0 w-full flex-col overflow-hidden bg-background text-foreground',
        className,
      )}
    >
      <MobileChatHeader
        title={resolvedTitle}
        subtitle={resolvedSubtitle}
        busy={resolvedStatus === 'busy' || resolvedStatus === 'retry'}
        onBack={onBack}
        onOpenMenu={onOpenMenu}
        trailing={headerTrailing}
      />

      <div
        className={cn(
          'mobile-chat-screen__content relative h-full min-h-0 flex-1',
          '[&_[data-scrollbar=chat]>div]:pt-[calc(max(0.625rem,var(--safe-area-inset-top,env(safe-area-inset-top,0px)))+4.75rem)]',
          '[&_:has(>.oc-mobile-composer)]:!bg-transparent [&_.oc-mobile-composer]:bg-transparent',
        )}
      >
        {children}
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-x-0 bottom-0 z-[5] h-[calc(7rem+var(--safe-area-inset-bottom,env(safe-area-inset-bottom,0px)))] bg-gradient-to-t from-background via-background/85 to-transparent"
        />
      </div>
    </main>
  );
}
