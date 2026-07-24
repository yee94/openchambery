import { useEvent } from '@reactuses/core';

import { useI18n } from '@/lib/i18n';
import { MobileDetailNavigation } from '@/mobile/MobileDetailNavigation';

export type MobileChatHeaderProps = {
  title: string;
  onBack: () => void;
  onOpenMenu: () => void;
};

/** Safe-area-aware navigation bar for the mobile chat page. */
export function MobileChatHeader({
  title,
  onBack,
  onOpenMenu,
}: MobileChatHeaderProps) {
  const { t } = useI18n();
  const handleBack = useEvent(onBack);
  const handleOpenMenu = useEvent(onOpenMenu);

  return (
    <MobileDetailNavigation
      title={title}
      backAriaLabel={t('header.actions.backAria')}
      onBack={handleBack}
      overlay
      actions={[{
        icon: 'more-2',
        ariaLabel: t('mobile.menu.titleAria'),
        onClick: handleOpenMenu,
      }]}
    />
  );
}
