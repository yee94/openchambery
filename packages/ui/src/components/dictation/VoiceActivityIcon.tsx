import { Icon } from '@/components/icon/Icon';
import { cn } from '@/lib/utils';

export function VoiceActivityIcon({ kind, active, className }: {
    kind: 'mic' | 'speaker';
    active: boolean;
    className?: string;
}) {
    return <span aria-hidden="true" className={cn('relative inline-flex shrink-0 items-center justify-center', className)}>
        {active && <>
            <span className="pointer-events-none absolute -inset-1.5 rounded-full bg-[var(--voice-active-fill)]/15 motion-safe:animate-pulse motion-safe:[animation-duration:2.4s]" />
            <span className="pointer-events-none absolute -inset-1 rounded-full bg-[var(--voice-active-fill)]/25 motion-safe:animate-pulse motion-safe:[animation-delay:300ms] motion-safe:[animation-duration:2.4s]" />
            <span className="pointer-events-none absolute -inset-0.5 rounded-full bg-[var(--voice-active-fill)]" />
        </>}
        {kind === 'mic'
            ? active ? <Icon name="mic-fill" className="relative size-full p-0.5 text-[var(--primary-foreground)]" /> : <Icon name="mic" className="relative size-full" />
            : active ? <Icon name="volume-up-fill" className="relative size-full p-0.5 text-[var(--primary-foreground)]" /> : <Icon name="volume-up" weight="medium" className="relative size-full" />}
    </span>;
}
