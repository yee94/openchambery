import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { useAssistantUnreadTotal } from '@/queries/assistantQueries';

export function AssistantUnreadBadge({ count, className }: { count: number; className?: string }) {
  const { t } = useI18n();
  if (!(count > 0)) return null;
  return <span
    className={cn('inline-flex h-[18px] min-w-[18px] shrink-0 items-center justify-center rounded-full bg-[var(--status-info)] px-1.5 typography-micro font-semibold leading-none text-[var(--status-info-foreground)] tabular-nums shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--status-info-foreground)_15%,transparent)]', className)}
    aria-label={t('assistants.unread.label', { count })}
    data-assistant-unread-count={count}
  >{count > 99 ? '99+' : count}</span>;
}

export function AssistantNavigationUnreadBadge({ className }: { className?: string }) {
  const count = useAssistantUnreadTotal();
  return <AssistantUnreadBadge count={count} className={className} />;
}
