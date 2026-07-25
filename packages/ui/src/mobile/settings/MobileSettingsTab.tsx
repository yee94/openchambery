import type { ReactNode } from 'react';

import { MOBILE_SETTINGS_PAGE_SLUGS } from '@/lib/settings/metadata';
import { useI18n } from '@/lib/i18n';
import { SettingsView } from '@/components/views/SettingsView';

import { MobileTabPageScaffold } from '../MobileSurface';

export type MobileSettingsTabProps = {
  className?: string;
  contentClassName?: string;
  instancesPage?: ReactNode;
};

export function MobileSettingsTab({ className, contentClassName, instancesPage }: MobileSettingsTabProps) {
  const { t } = useI18n();

  return (
    <MobileTabPageScaffold
      title={t('mobile.settings.placeholder.title')}
      className={className}
      surface={false}
      scrollsWithPage
      showHeader={false}
      surfaceClassName={contentClassName}
    >
      <SettingsView
        forceMobile
        isWindowed
        hideMobileHeader
        flowMobile
        // Deep links / enable-assistants / MCP create set settingsPage before
        // switching to this tab; auto-open lands on that page instead of nav.
        autoOpenMobilePage
        visiblePageSlugs={[...MOBILE_SETTINGS_PAGE_SLUGS]}
        mobileInstancesPage={instancesPage}
      />
    </MobileTabPageScaffold>
  );
}
