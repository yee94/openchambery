import React from 'react';
import { cn } from '@/lib/utils';
import type { DisplayProvider } from '@/lib/modelDisplay';
import { formatEffortLabel, getModelDisplayName } from './mobileControlsUtils';
import { ModelLogo } from '@/components/ui/ModelLogo';
import { useI18n } from '@/lib/i18n';

interface MobileModelButtonProps {
    onOpenModel: () => void;
    className?: string;
    providerID?: string;
    modelID?: string;
    provider?: DisplayProvider;
    /** Non-default thinking variant; default/empty is hidden. */
    variant?: string;
    disabled?: boolean;
}

export const MobileModelButton: React.FC<MobileModelButtonProps> = ({
    onOpenModel,
    className,
    providerID,
    modelID,
    provider,
    variant,
    disabled = false,
}) => {
    const { t } = useI18n();
    const modelLabel = getModelDisplayName(provider, modelID, t('chat.modelControls.selectModel'));
    const variantLabel = variant?.trim() ? formatEffortLabel(variant) : null;
    const accessibleLabel = variantLabel ? `${modelLabel} ${variantLabel}` : modelLabel;

    return (
        <button
            type="button"
            disabled={disabled}
            onClick={onOpenModel}
            // Same guard as PermissionAutoAcceptButton/MobileAgentButton: block
            // the focus transfer so the tap is never treated as focusing the
            // neighbouring textarea (pill expand / IME open). Also keeps the
            // keyboard stable when already open; with resizes-content (Android)
            // a keyboard-close relayout would move this button mid-tap.
            onMouseDown={(event) => event.preventDefault()}
            onPointerDownCapture={(event) => {
                event.preventDefault();
            }}
            className={cn(
                // Keep the footer controls compact on narrow phones. The text
                // itself truncates below, while the full name remains available
                // through the accessible label and native title.
                'inline-flex min-w-0 max-w-36 items-stretch',
                'rounded-lg',
                'focus:outline-none hover:bg-[var(--interactive-hover)] disabled:cursor-not-allowed disabled:opacity-40',
                className
            )}
            style={{ height: '26px', maxHeight: '26px', minHeight: '26px' }}
            title={accessibleLabel}
            aria-label={accessibleLabel}
        >
            <span className="flex h-full w-full min-w-0 items-center gap-1">
                {modelID || providerID ? (
                    <ModelLogo modelId={modelID} providerId={providerID} className="size-4 flex-shrink-0" />
                ) : null}
                <span className="inline-flex min-w-0 items-center gap-1">
                    {/* Slightly under typography-micro (12px) so the label stays quiet without looking tiny. */}
                    <span className="truncate text-[11px] leading-none font-medium text-foreground/80">{modelLabel}</span>
                    {variantLabel ? (
                        <span className="shrink-0 text-[11px] leading-none font-normal text-muted-foreground">{variantLabel}</span>
                    ) : null}
                </span>
            </span>
        </button>
    );
};
