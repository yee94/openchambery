import { MOBILE_SETTINGS_PAGE_SLUGS } from '@/lib/settings/metadata';
import { useI18n } from '@/lib/i18n';
import { SettingsView } from '@/components/views/SettingsView';

import { MobileTabPageScaffold } from '../MobileSurface';

export type MobileSettingsTabProps = {
  className?: string;
  contentClassName?: string;
};

export function MobileSettingsTab({ className, contentClassName }: MobileSettingsTabProps) {
  const { t } = useI18n();

  return (
    <MobileTabPageScaffold
      title={t('mobile.settings.placeholder.title')}
      className={className}
      surface={false}
      scrollsWithPage
      surfaceClassName={contentClassName}
    >
      <SettingsView
        forceMobile
        isWindowed
        hideMobileHeader
        flowMobile
        autoOpenMobilePage={false}
        visiblePageSlugs={[...MOBILE_SETTINGS_PAGE_SLUGS]}
      />
    </MobileTabPageScaffold>
  );
}
