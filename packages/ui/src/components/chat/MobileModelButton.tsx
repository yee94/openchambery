import React from 'react';
import { cn } from '@/lib/utils';
import type { DisplayProvider } from '@/lib/modelDisplay';
import { getModelDisplayName } from './mobileControlsUtils';
import { ModelLogo } from '@/components/ui/ModelLogo';
import { useI18n } from '@/lib/i18n';

interface MobileModelButtonProps {
    onOpenModel: () => void;
    className?: string;
    providerID?: string;
    modelID?: string;
    provider?: DisplayProvider;
    disabled?: boolean;
}

export const MobileModelButton: React.FC<MobileModelButtonProps> = ({ onOpenModel, className, providerID, modelID, provider, disabled = false }) => {
    const { t } = useI18n();
    const modelLabel = getModelDisplayName(provider, modelID, t('chat.modelControls.selectModel'));

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
                'inline-flex min-w-0 items-stretch',
                'rounded-lg',
                'typography-micro font-medium text-foreground/80',
                'focus:outline-none hover:bg-[var(--interactive-hover)] disabled:cursor-not-allowed disabled:opacity-40',
                className
            )}
            style={{ height: '26px', maxHeight: '26px', minHeight: '26px' }}
            title={modelLabel}
            aria-label={modelLabel}
        >
            <span className="flex h-full w-full min-w-0 items-center gap-1">
                {modelID || providerID ? (
                    <ModelLogo modelId={modelID} providerId={providerID} className="size-4 flex-shrink-0" />
                ) : null}
                <span className="truncate">{modelLabel}</span>
            </span>
        </button>
    );
};
