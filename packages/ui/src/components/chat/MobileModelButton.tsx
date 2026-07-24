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
            // the focus transfer so the tap doesn't dismiss the keyboard. With
            // interactive-widget=resizes-content (Android), the keyboard-close
            // relayout moves this button mid-tap and the click never lands.
            onMouseDown={(event) => event.preventDefault()}
            onPointerDownCapture={(event) => {
                if (event.pointerType === 'touch') {
                    event.preventDefault();
                }
            }}
            className={cn(
                // Keep the footer controls compact on narrow phones. The text
                // itself truncates below, while the full name remains available
                // through the accessible label and native title.
                'inline-flex min-w-0 max-w-36 items-stretch',
                'rounded-lg',
                'typography-micro font-medium text-foreground/80',
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
                    <span className="truncate">{modelLabel}</span>
                    {variantLabel ? (
                        <span className="shrink-0 font-normal text-muted-foreground">{variantLabel}</span>
                    ) : null}
                </span>
            </span>
        </button>
    );
};
