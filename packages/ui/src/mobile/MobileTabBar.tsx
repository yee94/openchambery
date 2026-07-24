import { useEvent } from '@reactuses/core';

import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';

import { MOBILE_TABS, type MobileTabId } from './mobileTabs';
import { MobileFloatingSurface } from './MobileSurface';

export type MobileTabBarProps = {
  activeTab: MobileTabId;
  onTabChange: (tab: MobileTabId) => void;
  className?: string;
};

/**
 * Floating glass capsule tab bar. Labels use dedicated short `mobile.tabs.*`
 * keys and equal flex slots so Latin/CJK/long locales stay within a phone width.
 */
export function MobileTabBar({ activeTab, onTabChange, className }: MobileTabBarProps) {
  const { t } = useI18n();

  const handleTabClick = useEvent((event: React.MouseEvent<HTMLButtonElement>) => {
    onTabChange(event.currentTarget.dataset.tab as MobileTabId);
  });

  const handleTabKeyDown = useEvent((event: React.KeyboardEvent<HTMLButtonElement>) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;

    event.preventDefault();
    const currentIndex = MOBILE_TABS.findIndex((tab) => tab.id === activeTab);
    const nextIndex = event.key === 'Home'
      ? 0
      : event.key === 'End'
        ? MOBILE_TABS.length - 1
        : (currentIndex + (event.key === 'ArrowRight' ? 1 : -1) + MOBILE_TABS.length) % MOBILE_TABS.length;
    const nextTab = MOBILE_TABS[nextIndex];
    onTabChange(nextTab.id);
    document.getElementById(`mobile-tab-${nextTab.id}`)?.focus();
  });

  return (
    <nav
      aria-label={t('mobile.nav.aria')}
      className={cn(
        'pointer-events-none fixed inset-x-0 bottom-0 z-40 flex justify-center pb-[max(1.25rem,var(--safe-area-inset-bottom,env(safe-area-inset-bottom,0px)))]',
        className,
      )}
    >
      <MobileFloatingSurface asChild>
        <div
          role="tablist"
          className="oc-mobile-tab-dock pointer-events-auto"
        >
        {MOBILE_TABS.map((tab) => {
          const selected = tab.id === activeTab;
          const label = t(tab.labelKey);

          return (
            <Button
              key={tab.id}
              id={`mobile-tab-${tab.id}`}
              data-tab={tab.id}
              type="button"
              role="tab"
              variant="ghost"
              size="sm"
              aria-controls={`mobile-tabpanel-${tab.id}`}
              aria-label={label}
              aria-selected={selected}
              tabIndex={selected ? 0 : -1}
              title={label}
              onClick={handleTabClick}
              onKeyDown={handleTabKeyDown}
              className={cn(
                // Equal flex slots + min-w-0 so long locale strings truncate, never overflow.
                'oc-mobile-tab-button min-w-0 flex-1 flex-col overflow-hidden',
                'text-[11px] font-medium leading-none tracking-tight text-muted-foreground',
                // Scale press feedback comes from mobile.css global default (compact).
                'transition-[background-color,color,box-shadow] duration-150',
                'hover:bg-transparent hover:text-foreground',
                'motion-reduce:transition-none',
                selected && [
                  'bg-interactive-selection text-interactive-selection-foreground',
                  'shadow-[0_5px_14px_color-mix(in_srgb,var(--surface-foreground)_8%,transparent),inset_0_1px_0_color-mix(in_srgb,var(--surface-elevated)_82%,transparent)]',
                  'hover:bg-interactive-selection hover:text-interactive-selection-foreground',
                  'font-semibold',
                ],
              )}
            >
              <Icon name={tab.icon} weight="medium" className="size-[21px] shrink-0" />
              <span className="block max-w-full overflow-hidden text-ellipsis whitespace-nowrap">{label}</span>
            </Button>
          );
        })}
        </div>
      </MobileFloatingSurface>
    </nav>
  );
}
