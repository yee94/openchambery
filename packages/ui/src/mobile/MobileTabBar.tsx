import { useEvent } from '@reactuses/core';

import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';

import { MOBILE_TABS, type MobileTabId } from './mobileTabs';

export type MobileTabBarProps = {
  activeTab: MobileTabId;
  onTabChange: (tab: MobileTabId) => void;
  className?: string;
};

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
        'pointer-events-none fixed inset-x-0 bottom-0 z-40 px-3 pb-[max(0.75rem,var(--safe-area-inset-bottom,env(safe-area-inset-bottom,0px)))]',
        className,
      )}
    >
      <div
        role="tablist"
        className="pointer-events-auto mx-auto flex w-full max-w-md items-center gap-1 rounded-[26px] border border-border/60 bg-[color:color-mix(in_srgb,var(--surface-elevated)_88%,transparent)] p-1.5 shadow-[0_18px_48px_color-mix(in_srgb,var(--surface-foreground)_14%,transparent)] backdrop-blur-2xl supports-[corner-shape:squircle]:rounded-[64px]"
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
              size="lg"
              aria-controls={`mobile-tabpanel-${tab.id}`}
              aria-label={label}
              aria-selected={selected}
              tabIndex={selected ? 0 : -1}
              onClick={handleTabClick}
              onKeyDown={handleTabKeyDown}
              className={cn(
                'min-h-11 min-w-0 flex-1 flex-col gap-0.5 rounded-[20px] px-1 typography-micro text-muted-foreground transition-[background-color,color,transform] duration-200 active:scale-[0.96] supports-[corner-shape:squircle]:rounded-[48px] motion-reduce:transition-none',
                selected && 'bg-interactive-selection text-interactive-selection-foreground hover:bg-interactive-selection hover:text-interactive-selection-foreground',
              )}
            >
              <Icon name={tab.icon} weight="medium" className={cn('size-5 transition-transform duration-200 motion-reduce:transition-none', selected && '-translate-y-px')} />
              <span className="max-w-full truncate leading-none">{label}</span>
            </Button>
          );
        })}
      </div>
    </nav>
  );
}
