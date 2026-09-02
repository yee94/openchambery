import * as React from 'react';
import { useEvent } from '@reactuses/core';

import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { useCurrentSessionEntity } from '@/sync/sync-context';

import { MobileChatHeader } from './MobileChatHeader';
import { MobileContextProgressButton } from './MobileContextProgressButton';
import { useMobileTranscriptSyncHint } from './useMobileTranscriptSyncHint';

export type MobileChatScreenProps = {
  /** Empty string = new-session draft mode (no entity/status lookups). */
  sessionId: string;
  /** Session workspace. Required so the sync hint reads the same transcript as ChatView. */
  directory?: string | null;
  title?: string;
  onBack: () => void;
  onOpenMenu: () => void;
  /** Close the overflow menu without toggling (used when switching to context). */
  onCloseMenu?: () => void;
  menuOpen?: boolean;
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
  directory,
  title,
  onBack,
  onOpenMenu,
  onCloseMenu,
  menuOpen = false,
  children,
  className,
}: MobileChatScreenProps) {
  const { t } = useI18n();
  const isDraft = sessionId.length === 0;
  const session = useCurrentSessionEntity(isDraft ? null : sessionId);
  const resolvedTitle = isDraft
    ? (title?.trim() || t('mobile.menu.newSession'))
    : (title?.trim() || session?.title?.trim() || t('mobile.sessions.untitled'));
  const syncHint = useMobileTranscriptSyncHint(
    isDraft ? '' : sessionId,
    directory || undefined,
  );
  const [contextOpen, setContextOpen] = React.useState(false);

  // Overflow menu and context panel are mutually exclusive. Switching from one
  // trigger to the other closes the first and opens the second in the same tap.
  const handleContextOpenChange = useEvent((open: boolean) => {
    if (open && menuOpen) {
      onCloseMenu?.();
    }
    setContextOpen(open);
  });

  const handleOpenMenu = useEvent(() => {
    if (contextOpen) setContextOpen(false);
    onOpenMenu();
  });

  const headerElevated = menuOpen || contextOpen;

  return (
    <main
      className={cn(
        'relative isolate flex h-full min-h-0 w-full flex-col overflow-hidden bg-background text-foreground',
        className,
      )}
    >
      <MobileChatHeader
        title={resolvedTitle}
        subtitle={syncHint}
        onBack={onBack}
        onOpenMenu={handleOpenMenu}
        menuOpen={menuOpen}
        elevated={headerElevated}
        trailing={(
          <MobileContextProgressButton
            sessionId={sessionId}
            open={contextOpen}
            onOpenChange={handleContextOpenChange}
          />
        )}
      />

      <div
        className={cn(
          // Prompt host stays page-background solid; only a short top fade
          // softens into the message list. The input CARD is elevated solid.
          'mobile-chat-screen__content relative h-full min-h-0 flex-1',
          '[&_[data-scrollbar=chat]>.oc-chat-scroll-content]:pt-[calc(max(0.625rem,var(--oc-safe-area-top,0px))+var(--oc-mobile-detail-navigation-height)+1.25rem)]',
        )}
      >
        {children}
      </div>
    </main>
  );
}
