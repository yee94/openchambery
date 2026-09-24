import { Icon } from '@/components/icon/Icon';
import type { AssistantErrorPresentation } from './assistantErrorPresentation';

export function ResponseStatusRow({ presentation }: { presentation: AssistantErrorPresentation }) {
    const { text, icon, variant, rawMessage, detail } = presentation;
    return (
        <div
            role={variant === 'error' ? 'alert' : 'status'}
            data-response-status={variant}
            className="flex w-full min-w-0 items-start gap-1.5 typography-meta leading-5 text-muted-foreground"
        >
            <span className="inline-flex h-5 shrink-0 items-center" aria-hidden="true">
                <Icon name={icon} className="size-3.5" />
            </span>
            <span className="min-w-0 flex-1 whitespace-pre-wrap [overflow-wrap:anywhere]">
                {text}
                {detail ? <span className="ml-1.5 text-muted-foreground/60">{detail}</span> : null}
                {rawMessage && rawMessage !== text ? <span className="block text-muted-foreground/80">{rawMessage}</span> : null}
            </span>
        </div>
    );
}
