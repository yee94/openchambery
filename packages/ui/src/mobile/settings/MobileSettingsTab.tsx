import * as React from 'react';
import { useEvent } from '@reactuses/core';

import type { SettingsPageSlug } from '@/lib/settings/metadata';
import { useI18n } from '@/lib/i18n';
import { SettingsView } from '@/components/views/SettingsView';

import { MobileTabPageScaffold } from '../MobileSurface';

// Keep this list aligned with the dedicated-mobile surface in MobileApp.
const MOBILE_SETTINGS_PAGE_SLUGS = [
  'appearance',
  'chat',
  'notifications',
  'sessions',
  'git',
  'magic-prompts',
  'behavior',
  'mcp',
  'providers',
  'usage',
  'voice',
  'about',
  'assistants',
] as const satisfies readonly SettingsPageSlug[];

export type MobileSettingsTabProps = {
  className?: string;
  contentClassName?: string;
};

type MobileSettingsStage = 'nav' | 'page-sidebar' | 'page-content';

export function MobileSettingsTab({ className, contentClassName }: MobileSettingsTabProps) {
  const { t } = useI18n();
  const [mobileStage, setMobileStage] = React.useState<MobileSettingsStage>('nav');
  const handleMobileStageChange = useEvent((nextStage: MobileSettingsStage) => {
    setMobileStage(nextStage);
  });
  const isRootSettingsPage = mobileStage === 'nav';

  return (
    <MobileTabPageScaffold
      title={t('mobile.settings.placeholder.title')}
      className={className}
      surface={false}
      scrollsWithPage
      showHeader={isRootSettingsPage}
      surfaceClassName={contentClassName}
    >
      <SettingsView
        forceMobile
        isWindowed
        hideMobileHeader={isRootSettingsPage}
        flowMobile
        autoOpenMobilePage={false}
        onMobileStageChange={handleMobileStageChange}
        visiblePageSlugs={[...MOBILE_SETTINGS_PAGE_SLUGS]}
      />
    </MobileTabPageScaffold>
  );
}
