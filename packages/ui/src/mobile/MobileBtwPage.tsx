import { BtwPanel } from '@/components/layout/BtwPanel';
import { useI18n } from '@/lib/i18n';

import { MobileDetailNavigation } from './MobileDetailNavigation';
import { mobileBackNavigationCoordinator } from './mobileBackNavigation';
import type { MobileBtwRoute } from './mobileNavigation';

/** Phone `/btw` page pushed above its chat page; back closes the side conversation. */
export function MobileBtwPage({ route }: { route: MobileBtwRoute }) {
  const { t } = useI18n();
  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <MobileDetailNavigation
        title={t('chat.btw.title')}
        backAriaLabel={t('header.actions.backAria')}
        onBack={() => { mobileBackNavigationCoordinator.requestAnimatedBack('root'); }}
      />
      <div className="min-h-0 flex-1 pb-[var(--oc-safe-area-bottom,env(safe-area-inset-bottom,0px))]">
        <BtwPanel scope={{ sessionId: route.sessionId, directory: route.directory }} />
      </div>
    </div>
  );
}
