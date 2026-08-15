import type { ReactNode } from 'react';
import { useEvent } from '@reactuses/core';

import { useI18n } from '@/lib/i18n';
import { MobileDetailNavigation } from '@/mobile/MobileDetailNavigation';

export type MobileChatHeaderProps = {
  title: string;
  subtitle?: string | null;
  onBack: () => void;
  onOpenMenu: () => void;
  /** Whether the overflow menu is open — elevates the more button for re-tap close. */
  menuOpen?: boolean;
  /** Raise the whole header above modal backdrops (menu or context panel). */
  elevated?: boolean;
  /** Extra floating actions before the overflow menu (e.g. context ring). */
  trailing?: ReactNode;
};

/** Safe-area-aware navigation bar for the mobile chat page. */
export function MobileChatHeader({
  title,
  subtitle,
  onBack,
  onOpenMenu,
  menuOpen = false,
  elevated = false,
  trailing,
}: MobileChatHeaderProps) {
  const { t } = useI18n();
  const handleBack = useEvent(onBack);
  const handleOpenMenu = useEvent(onOpenMenu);

  return (
    <MobileDetailNavigation
      title={title}
      subtitle={subtitle}
      backAriaLabel={t('header.actions.backAria')}
      onBack={handleBack}
      overlay
      elevated={elevated || menuOpen}
      trailing={trailing}
      actions={[{
        icon: 'more-2',
        ariaLabel: t('mobile.menu.titleAria'),
        onClick: handleOpenMenu,
        pressed: menuOpen,
      }]}
    />
  );
}
