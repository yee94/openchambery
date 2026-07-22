import React from 'react';
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { ModelLogo } from '@/components/ui/ModelLogo';
import { Icon } from '@/components/icon/Icon';
import { useModelLists } from '@/hooks/useModelLists';
import { useOpenCodeReadiness } from '@/hooks/useOpenCodeReadiness';
import { useDeviceInfo } from '@/lib/device';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { useConfigStore } from '@/stores/useConfigStore';
import { useUIStore } from '@/stores/useUIStore';
import { ModelPickerList, type ModelPickerEntry, type ModelPickerProvider } from '@/components/model-picker/ModelPickerList';
import { MobileModelPickerPanel } from '@/components/model-picker/MobileModelPickerPanel';

interface ModelSelectorProps {
    providerId: string;
    modelId: string;
    variant?: string;
    onChange: (providerId: string, modelId: string, variant?: string) => void;
    className?: string;
    allowedProviderIds?: string[];
    allowedModelIdsByProvider?: Record<string, readonly string[]>;
    placeholder?: string;
    tooltipsEnabled?: boolean;
    dropdownPortalToBody?: boolean;
    showIcon?: boolean;
    providers?: ModelPickerProvider[];
}

export const ModelSelector: React.FC<ModelSelectorProps> = ({
    providerId,
    modelId,
    variant,
    onChange,
    className,
    allowedProviderIds,
    allowedModelIdsByProvider,
    placeholder,
    tooltipsEnabled = true,
    dropdownPortalToBody = false,
    showIcon = true,
    providers: catalogProviders,
}) => {
    const { t } = useI18n();
    const { isReady, isUnavailable } = useOpenCodeReadiness();
    const storedProviders = useConfigStore((state) => state.providers) as ModelPickerProvider[];
    const providers = catalogProviders ?? storedProviders;
    const modelsMetadata = useConfigStore((state) => state.modelsMetadata);
    const isMobile = useUIStore((state) => state.isMobile);
    const hiddenModels = useUIStore((state) => state.hiddenModels);
    const toggleFavoriteModel = useUIStore((state) => state.toggleFavoriteModel);
    const isFavoriteModel = useUIStore((state) => state.isFavoriteModel);
    const addRecentModel = useUIStore((state) => state.addRecentModel);
    const providerOrder = useUIStore((state) => state.providerOrder);
    const { favoriteModelsList, recentModelsList } = useModelLists();
    const { isMobile: deviceIsMobile } = useDeviceInfo();
    const isActuallyMobile = isMobile || deviceIsMobile;

    const [isMobilePanelOpen, setIsMobilePanelOpen] = React.useState(false);
    const [isDropdownOpen, setIsDropdownOpen] = React.useState(false);
    const [searchQuery, setSearchQuery] = React.useState('');
    const [variantTarget, setVariantTarget] = React.useState<ModelPickerEntry | null>(null);
    const variantSelectionEnabled = variant !== undefined;

    const closePicker = React.useCallback(() => {
        setIsMobilePanelOpen(false);
        setIsDropdownOpen(false);
        setSearchQuery('');
        setVariantTarget(null);
    }, []);

    const getVariantOptions = React.useCallback((entry: ModelPickerEntry): string[] => {
        const provider = providers.find((item) => item.id === entry.providerID);
        const model = provider?.models?.find((item) => item.id === entry.modelID) as { variants?: Record<string, unknown> } | undefined;
        return model?.variants ? Object.keys(model.variants) : [];
    }, [providers]);

    const handleSelect = React.useCallback((entry: ModelPickerEntry) => {
        const variantOptions = getVariantOptions(entry);
        const nextVariant = entry.providerID === providerId
            && entry.modelID === modelId
            && variant
            && variantOptions.includes(variant)
            ? variant
            : '';
        onChange(entry.providerID, entry.modelID, variantSelectionEnabled ? nextVariant : undefined);
        addRecentModel(entry.providerID, entry.modelID);
        closePicker();
    }, [addRecentModel, closePicker, getVariantOptions, modelId, onChange, providerId, variant, variantSelectionEnabled]);

    const handleSelectNone = React.useCallback(() => {
        onChange('', '', variantSelectionEnabled ? '' : undefined);
        closePicker();
    }, [closePicker, onChange, variantSelectionEnabled]);

    const handleVariantSelect = React.useCallback((nextVariant: string) => {
        if (!variantTarget) return;
        onChange(variantTarget.providerID, variantTarget.modelID, nextVariant);
        addRecentModel(variantTarget.providerID, variantTarget.modelID);
        closePicker();
    }, [addRecentModel, closePicker, onChange, variantTarget]);

    const labels = React.useMemo(() => ({
        searchPlaceholder: t('settings.agents.modelSelector.searchPlaceholder'),
        noResults: t('settings.agents.modelSelector.state.noModelsFound'),
        favorites: t('settings.agents.modelSelector.section.favorites'),
        recent: t('settings.agents.modelSelector.section.recent'),
        keyboardHint: t('settings.agents.modelSelector.keyboardHints'),
        notSelected: placeholder || t('settings.agents.modelSelector.notSelected'),
        favorite: t('settings.agents.modelSelector.actions.favorite'),
        unfavorite: t('settings.agents.modelSelector.actions.unfavorite'),
        capabilities: t('chat.modelControls.capabilities'),
        capabilityToolCalling: t('chat.modelControls.capability.toolCalling'),
        capabilityReasoning: t('chat.modelControls.capability.reasoning'),
        input: t('chat.modelControls.input'),
        output: t('chat.modelControls.output'),
        costPerMillion: t('chat.modelControls.costPerMillion'),
    }), [placeholder, t]);

    const selectedModel = providerId && modelId ? { providerID: providerId, modelID: modelId } : null;
    const triggerLabel = providerId && modelId ? `${providerId}/${modelId}` : (placeholder || t('settings.agents.modelSelector.notSelected'));
    const variantLabel = variantSelectionEnabled ? (variant || t('chat.modelControls.default')) : null;
    const resolveMobileVariant = React.useCallback((entryProviderId: string, entryModelId: string) => {
        if (!variantSelectionEnabled || entryProviderId !== providerId || entryModelId !== modelId) return undefined;
        return variant || undefined;
    }, [modelId, providerId, variant, variantSelectionEnabled]);
    const handleMobileSelect = React.useCallback((nextProviderId: string, nextModelId: string, nextVariant: string | undefined) => {
        onChange(nextProviderId, nextModelId, variantSelectionEnabled ? (nextVariant ?? '') : undefined);
        addRecentModel(nextProviderId, nextModelId);
        closePicker();
    }, [addRecentModel, closePicker, onChange, variantSelectionEnabled]);

    const renderVariantControl = React.useCallback((entry: ModelPickerEntry, state: { isSelected: boolean }) => {
        if (!variantSelectionEnabled || getVariantOptions(entry).length === 0) return null;
        const selectedVariant = state.isSelected ? variant : '';
        return (
            <button
                type="button"
                className="flex min-h-9 shrink-0 items-center gap-0.5 rounded-md px-1.5 typography-micro font-medium text-muted-foreground hover:bg-interactive-hover hover:text-foreground"
                onClick={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    setVariantTarget(entry);
                }}
                aria-label={t('chat.modelControls.showThinkingModes')}
            >
                <span className="max-w-24 truncate">{selectedVariant || t('chat.modelControls.default')}</span>
                <Icon name="arrow-right-s" className="size-3.5" />
            </button>
        );
    }, [getVariantOptions, t, variant, variantSelectionEnabled]);

    const modelPicker = (
        <ModelPickerList
            providers={providers}
            providerOrder={providerOrder}
            favoriteModels={favoriteModelsList}
            recentModels={recentModelsList}
            modelsMetadata={modelsMetadata}
            searchQuery={searchQuery}
            onSearchQueryChange={setSearchQuery}
            onSelect={handleSelect}
            labels={labels}
            selectedModel={selectedModel}
            hiddenModels={hiddenModels}
            allowedProviderIds={allowedProviderIds}
            allowedModelIdsByProvider={allowedModelIdsByProvider}
            includeNotSelected
            onSelectNone={handleSelectNone}
            onEscape={closePicker}
            maxHeightClassName={isActuallyMobile ? 'max-h-none flex-1' : undefined}
            tooltipsEnabled={tooltipsEnabled && (isActuallyMobile ? isMobilePanelOpen : isDropdownOpen)}
            isFavorite={(entry) => isFavoriteModel(entry.providerID, entry.modelID)}
            onToggleFavorite={(entry) => toggleFavoriteModel(entry.providerID, entry.modelID)}
            renderRowEnd={renderVariantControl}
        />
    );

    const variantPicker = variantTarget ? (
        <div className="flex min-h-0 flex-1 flex-col">
            <button
                type="button"
                className="flex min-h-11 items-center gap-2 border-b border-border/40 px-3 text-left typography-ui-label font-medium text-foreground hover:bg-interactive-hover"
                onClick={() => setVariantTarget(null)}
                aria-label={t('header.actions.backAria')}
            >
                <Icon name="arrow-left" className="size-4" />
                <span className="min-w-0 flex-1 truncate">{variantTarget.modelID}</span>
            </button>
            <div className="space-y-1 p-2" role="listbox" aria-label={t('chat.modelControls.thinking')}>
                {['', ...getVariantOptions(variantTarget)].map((option) => {
                    const selected = variantTarget.providerID === providerId
                        && variantTarget.modelID === modelId
                        && (variant || '') === option;
                    return (
                        <button
                            key={option || '__default'}
                            type="button"
                            role="option"
                            aria-selected={selected}
                            className={cn(
                                'flex min-h-11 w-full items-center justify-between rounded-lg px-3 text-left typography-ui-label transition-colors',
                                selected ? 'bg-interactive-selection text-interactive-selection-foreground' : 'hover:bg-interactive-hover',
                            )}
                            onClick={() => handleVariantSelect(option)}
                        >
                            <span className="truncate">{option || t('chat.modelControls.default')}</span>
                            {selected ? <Icon name="check" className="size-4 shrink-0" /> : null}
                        </button>
                    );
                })}
            </div>
        </div>
    ) : null;
    const picker = variantPicker || modelPicker;

    if (isActuallyMobile) {
        return (
            <>
                <button
                    type="button"
                    onClick={isReady ? () => setIsMobilePanelOpen(true) : undefined}
                    disabled={!isReady}
                    className={cn(
                        'flex w-full items-center justify-between gap-2 rounded-lg border border-border/40 bg-[var(--surface-elevated)] px-2 py-1.5 text-left',
                        !isReady && 'opacity-60 cursor-not-allowed',
                        className,
                    )}
                >
                    <div className="flex min-w-0 flex-1 items-center gap-2">
                        {!isReady ? (
                            <>
                                <Icon name="loader-4" className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
                                <span className="typography-meta text-muted-foreground">{isUnavailable ? t('common.unavailable') : t('common.loading')}</span>
                            </>
                        ) : showIcon && (providerId || modelId) ? (
                            <ModelLogo modelId={modelId} providerId={providerId} className="h-3.5 w-3.5 flex-shrink-0" />
                        ) : showIcon ? (
                            <Icon name="pencil-ai" className="h-3 w-3 text-muted-foreground" />
                        ) : null}
                        {isReady ? <span className="typography-meta font-medium text-foreground truncate">{triggerLabel}</span> : null}
                        {isReady && variantLabel ? <span className="shrink-0 typography-micro text-muted-foreground">{variantLabel}</span> : null}
                    </div>
                    <Icon name="arrow-down-s" className="h-3 w-3 flex-shrink-0 text-muted-foreground" />
                </button>
                <MobileModelPickerPanel
                    open={isMobilePanelOpen}
                    onClose={closePicker}
                    selectedProviderID={providerId}
                    selectedModelID={modelId}
                    resolveSelectedVariant={resolveMobileVariant}
                    onSelect={handleMobileSelect}
                    providers={providers}
                    favoriteModels={favoriteModelsList}
                    recentModels={recentModelsList}
                    modelsMetadata={modelsMetadata}
                    hiddenModels={hiddenModels}
                    allowedProviderIds={allowedProviderIds}
                    allowedModelIdsByProvider={allowedModelIdsByProvider}
                    providerOrder={providerOrder}
                    variantSelectionEnabled={variantSelectionEnabled}
                    isFavorite={isFavoriteModel}
                    onToggleFavorite={toggleFavoriteModel}
                />
            </>
        );
    }

    return (
        <DropdownMenu open={isReady && isDropdownOpen} onOpenChange={isReady ? setIsDropdownOpen : undefined}>
            <DropdownMenuTrigger asChild>
                <div className={cn(
                    'border-input data-[placeholder]:text-muted-foreground flex min-w-0 items-center justify-between gap-2 rounded-lg border bg-transparent px-2 py-2 typography-ui-label whitespace-nowrap shadow-none outline-none hover:bg-interactive-hover data-[popup-open]:bg-interactive-active h-6 w-fit',
                    !isReady && 'opacity-60 cursor-not-allowed',
                    className,
                )}>
                    {!isReady ? (
                        <>
                            <Icon name="loader-4" className="h-3.5 w-3.5 animate-spin text-muted-foreground flex-shrink-0" />
                            <span className="typography-ui-label font-normal whitespace-nowrap text-muted-foreground">
                                {isUnavailable ? t('common.unavailable') : t('common.loading')}
                            </span>
                        </>
                    ) : (
                        <>
                            {showIcon
                                ? (providerId || modelId
                                    ? <ModelLogo modelId={modelId} providerId={providerId} className="h-3.5 w-3.5 flex-shrink-0" />
                                    : <Icon name="pencil-ai" className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" />)
                                : null}
                            <span className="typography-ui-label min-w-0 flex-1 truncate text-left font-normal text-foreground">{triggerLabel}</span>
                            {variantLabel ? <span className="shrink-0 typography-micro text-muted-foreground">{variantLabel}</span> : null}
                        </>
                    )}
                    <Icon name="arrow-down-s" className="h-4 w-4 flex-shrink-0 text-muted-foreground/50" />
                </div>
            </DropdownMenuTrigger>
            <DropdownMenuContent className="w-[min(380px,calc(100vw-2rem))] p-0 flex flex-col" align="start" portalToBody={dropdownPortalToBody}>
                {picker}
            </DropdownMenuContent>
        </DropdownMenu>
    );
};
