import { useEvent } from '@reactuses/core';
import { AssistantNavigationUnreadBadge } from '@/components/assistants/AssistantUnreadBadge';

import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { useAssistantUnreadTotal } from '@/queries/assistantQueries';

import { MOBILE_TABS, type MobileTabId } from './mobileTabs';
import { MobileFloatingBottomBar } from './MobileSurface';

export type MobileTabBarProps = {
  activeTab: MobileTabId;
  onTabChange: (tab: MobileTabId) => void;
  className?: string;
  /** Loading marks already exclude tabs with unread. The bar re-checks assistant unread. */
  tabMarks?: Partial<Record<MobileTabId, 'loading' | null>>;
};

/**
 * Floating glass capsule tab bar. Labels use dedicated short `mobile.tabs.*`
 * keys and equal flex slots so Latin/CJK/long locales stay within a phone width.
 */
export function MobileTabBar({ activeTab, onTabChange, className, tabMarks }: MobileTabBarProps) {
  const { t } = useI18n();
  const assistantUnread = useAssistantUnreadTotal();
  const loadingLabel = t('mobile.tabs.activity.loading');

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
    <MobileFloatingBottomBar
      as="nav"
      aria-label={t('mobile.nav.aria')}
      variant="navigation"
      surfaceProps={{ role: 'tablist' }}
      className={className}
    >
      {MOBILE_TABS.map((tab) => {
        const selected = tab.id === activeTab;
        const label = t(tab.labelKey);
        const showAssistantUnread = tab.id === 'assistant' && assistantUnread > 0;
        const showLoading = !showAssistantUnread && tabMarks?.[tab.id] === 'loading';
        const markId = showAssistantUnread
          ? 'mobile-tab-assistant-unread'
          : showLoading
            ? `mobile-tab-${tab.id}-activity`
            : undefined;

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
            aria-describedby={markId}
            aria-selected={selected}
            tabIndex={selected ? 0 : -1}
            title={label}
            onClick={handleTabClick}
            onKeyDown={handleTabKeyDown}
            className={cn(
              // Equal flex slots + min-w-0 so long locale strings truncate on the label only.
              // overflow stays visible so the assistant unread bubble can paint outside the icon.
              'oc-mobile-tab-button min-w-0 flex-1 flex-col overflow-visible',
              'text-xs font-medium leading-none tracking-tight text-muted-foreground',
              // The dock supplies immediate touch-down glass feedback in mobile.css.
              'transition-[background-color,color,box-shadow,transform] duration-100',
              'hover:bg-transparent hover:text-foreground',
              'active:bg-interactive-active',
              'motion-reduce:transition-none',
              selected && [
                // Lighter than full interactive-selection so the pill is soft on glass.
                'bg-interactive-selection/55 text-primary',
                'hover:bg-interactive-selection/55 hover:text-primary',
                'font-semibold',
              ],
            )}
          >
            <span className="relative inline-flex shrink-0 overflow-visible">
              <Icon name={tab.icon} weight="medium" className="size-[23px] shrink-0" />
              {markId ? (
                <span
                  id={markId}
                  role={showLoading ? 'status' : undefined}
                  aria-label={showLoading ? loadingLabel : undefined}
                  data-mobile-tab-activity={showLoading ? 'loading' : undefined}
                  className="pointer-events-none absolute left-full -top-1 ml-0.5 inline-flex z-10"
                >
                  {showAssistantUnread ? (
                    <AssistantNavigationUnreadBadge className="h-[18px] min-w-[18px] bg-foreground px-1 text-[11px] font-bold tracking-normal text-background shadow-none ring-2 ring-background" />
                  ) : (
                    <span className="inline-flex size-[18px] items-center justify-center rounded-full bg-foreground text-background ring-2 ring-background">
                      <Icon name="loader-4" className="size-3 animate-spin" />
                    </span>
                  )}
                </span>
              ) : null}
            </span>
            <span className="oc-mobile-tab-label block max-w-full overflow-hidden text-ellipsis whitespace-nowrap">{label}</span>
          </Button>
        );
      })}
    </MobileFloatingBottomBar>
  );
}
