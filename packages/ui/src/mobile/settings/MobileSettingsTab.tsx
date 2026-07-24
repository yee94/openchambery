import type { SettingsPageSlug } from '@/lib/settings/metadata';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { SettingsView } from '@/components/views/SettingsView';

import { MobileTabPageHeader } from '../MobileTabPageHeader';

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

export function MobileSettingsTab({ className, contentClassName }: MobileSettingsTabProps) {
  const { t } = useI18n();

  return (
    <div className={cn('flex h-full min-h-[70dvh] flex-col', className)}>
      <MobileTabPageHeader title={t('mobile.settings.placeholder.title')} />
      <div
        className={cn(
          'min-h-0 flex-1 overflow-hidden rounded-[26px] border border-border/50 bg-background shadow-[0_16px_44px_color-mix(in_srgb,var(--surface-foreground)_7%,transparent)] supports-[corner-shape:squircle]:rounded-[64px]',
          contentClassName,
        )}
      >
        <SettingsView forceMobile isWindowed visiblePageSlugs={[...MOBILE_SETTINGS_PAGE_SLUGS]} />
      </div>
    </div>
  );
}
