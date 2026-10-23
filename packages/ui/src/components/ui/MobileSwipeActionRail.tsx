import { Icon } from '@/components/icon/Icon';
import type { IconName } from '@/components/icon/icons';
import { Button } from './button';
import { cn } from '@/lib/utils';
import type { useMobileSwipeActions } from './useMobileSwipeActions';

export function MobileSwipeActionRail({ swipe, actions }: {
  swipe: ReturnType<typeof useMobileSwipeActions>;
  actions: readonly { label: string; icon: IconName; destructive?: boolean; onClick: () => void }[];
}) {
  const { offset, dragging, actionRailRef, closeActions } = swipe;
  const revealed = offset !== 0;
  return <div
    ref={actionRailRef}
    data-session-drag-ignore
    className={cn('oc-mobile-session-actions absolute inset-y-0 right-0 z-0 flex items-stretch',
      dragging ? 'transition-none' : 'transition-transform duration-150 ease-out',
      !revealed && 'invisible pointer-events-none')}
    style={{ transform: `translate3d(calc(var(--oc-mobile-session-actions-width) + ${offset}px), 0, 0)`, willChange: revealed ? 'transform' : undefined }}
    aria-hidden={!revealed}
  >
    {actions.map((action) => <Button
      key={action.label} type="button" variant={action.destructive ? 'destructive' : 'secondary'}
      className={cn('oc-mobile-session-action h-full flex-col rounded-none border-0 px-1',
        !action.destructive && 'bg-interactive-selection text-interactive-selection-foreground hover:bg-interactive-active')}
      aria-label={action.label} tabIndex={revealed ? 0 : -1}
      onClick={() => { closeActions(); action.onClick(); }}
    >
      <Icon name={action.icon} className="size-[18px]" />
      <span className="oc-mobile-session-action-label font-medium">{action.label}</span>
    </Button>)}
  </div>;
}
