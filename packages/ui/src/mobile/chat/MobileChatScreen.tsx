import * as React from 'react';

import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { useCurrentSessionEntity } from '@/sync/sync-context';

import { MobileChatHeader } from './MobileChatHeader';

export type MobileChatScreenProps = {
  /** Empty string = new-session draft mode (no entity/status lookups). */
  sessionId: string;
  title?: string;
  onBack: () => void;
  onOpenMenu: () => void;
  children: React.ReactNode;
  className?: string;
};

/**
 * Second-level mobile shell around the existing primary ChatView. The shell
 * owns floating navigation and atmospheric edge chrome while ChatView keeps
 * message, composer, draft, and send behavior.
 */
export function MobileChatScreen({
  sessionId,
  title,
  onBack,
  onOpenMenu,
  children,
  className,
}: MobileChatScreenProps) {
  const { t } = useI18n();
  const isDraft = sessionId.length === 0;
  const session = useCurrentSessionEntity(isDraft ? null : sessionId);
  const resolvedTitle = isDraft
    ? (title?.trim() || t('mobile.menu.newSession'))
    : (title?.trim() || session?.title?.trim() || t('mobile.sessions.untitled'));

  return (
    <main
      className={cn(
        'relative isolate flex h-full min-h-0 w-full flex-col overflow-hidden bg-background text-foreground',
        className,
      )}
    >
      <MobileChatHeader
        title={resolvedTitle}
        onBack={onBack}
        onOpenMenu={onOpenMenu}
      />

      <div
        className={cn(
          'mobile-chat-screen__content relative h-full min-h-0 flex-1',
          '[&_[data-scrollbar=chat]>div]:pt-[calc(max(0.625rem,var(--oc-safe-area-top,0px))+var(--oc-mobile-detail-navigation-height)+1.25rem)]',
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
