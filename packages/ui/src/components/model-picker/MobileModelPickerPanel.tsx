import React from 'react';
import { Icon } from '@/components/icon/Icon';
import type { IconName } from '@/components/icon/icons';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { MobileResizableSheet } from '@/components/ui/MobileResizableSheet';
import { ModelLogo } from '@/components/ui/ModelLogo';
import { ProviderLogo } from '@/components/ui/ProviderLogo';
import { getCurrentIntlLocale, useI18n } from '@/lib/i18n';
import { mergeModelMetadataWithLiveModel } from '@/lib/modelMetadata';
import { getModelDisplayName } from '@/lib/modelDisplay';
import { matchesModelSearch } from '@/lib/search/modelSearch';
import { cn } from '@/lib/utils';
import type { ModelMetadata } from '@/types';
import type { ModelPickerEntry, ModelPickerProvider } from './ModelPickerList';

type HiddenModel = { providerID: string; modelID: string };
type PickerView = 'model' | 'variant';
type VariantTarget = { providerID: string; modelID: string };
type MetadataIcon = { key: string; icon: IconName; label: string };

const MAX_INLINE_VARIANT_OPTIONS = 6;

const formatTokens = (value?: number | null) => {
    if (typeof value !== 'number' || Number.isNaN(value)) return '';
    return new Intl.NumberFormat(getCurrentIntlLocale(), {
        notation: 'compact',
        compactDisplay: 'short',
        maximumFractionDigits: 1,
    }).format(value);
};

const getVariantOptions = (providers: ModelPickerProvider[], providerID: string, modelID: string) => {
    const provider = providers.find((entry) => entry.id === providerID);
    const model = provider?.models?.find((entry) => entry.id === modelID) as { variants?: Record<string, unknown> } | undefined;
    return model?.variants ? Object.keys(model.variants) : [];
};

interface MobileModelPickerPanelProps {
    open: boolean;
    onClose: () => void;
    selectedProviderID: string;
    selectedModelID: string;
    resolveSelectedVariant: (providerID: string, modelID: string) => string | undefined;
    onSelect: (providerID: string, modelID: string, variant: string | undefined) => void;
    providers: ModelPickerProvider[];
    favoriteModels: ModelPickerEntry[];
    recentModels: ModelPickerEntry[];
    modelsMetadata: Map<string, ModelMetadata>;
    hiddenModels?: HiddenModel[];
    allowedProviderIds?: string[];
    allowedModelIdsByProvider?: Record<string, readonly string[]>;
    providerOrder?: string[];
    variantSelectionEnabled?: boolean;
    isFavorite: (providerID: string, modelID: string) => boolean;
    onToggleFavorite: (providerID: string, modelID: string) => void;
    getMetadata?: (providerID: string, modelID: string) => ModelMetadata | undefined;
    view?: PickerView;
    onViewChange?: (view: PickerView) => void;
}

export const MobileModelPickerPanel: React.FC<MobileModelPickerPanelProps> = ({
    open,
    onClose,
    selectedProviderID,
    selectedModelID,
    resolveSelectedVariant,
    onSelect,
    providers,
    favoriteModels,
    recentModels,
    modelsMetadata,
    hiddenModels = [],
    allowedProviderIds,
    allowedModelIdsByProvider,
    providerOrder,
    variantSelectionEnabled = true,
    isFavorite,
    onToggleFavorite,
    getMetadata,
    view,
    onViewChange,
}) => {
    const { t } = useI18n();
    const mobileSheetId = React.useId();
    const [query, setQuery] = React.useState('');
    const [expandedProviders, setExpandedProviders] = React.useState<Set<string>>(() => new Set(selectedProviderID ? [selectedProviderID] : []));
    const [expandedModelKey, setExpandedModelKey] = React.useState<string | null>(null);
    const [internalView, setInternalView] = React.useState<PickerView>('model');
    const [variantTarget, setVariantTarget] = React.useState<VariantTarget | null>(null);
    const previousOpenRef = React.useRef(false);
    const activeView = view ?? internalView;

    React.useEffect(() => {
        if (open && !previousOpenRef.current) {
            setExpandedProviders(new Set(selectedProviderID ? [selectedProviderID] : []));
        }
        if (!open) {
            setQuery('');
            setExpandedModelKey(null);
            setInternalView('model');
            setVariantTarget(null);
        }
        previousOpenRef.current = open;
    }, [open, selectedProviderID]);

    const setView = React.useCallback((nextView: PickerView) => {
        setInternalView(nextView);
        onViewChange?.(nextView);
    }, [onViewChange]);

    const allowedProviderSet = React.useMemo(
        () => allowedProviderIds && allowedProviderIds.length > 0 ? new Set(allowedProviderIds) : null,
        [allowedProviderIds],
    );
    const allowedModelsByProvider = React.useMemo(() => allowedModelIdsByProvider
        ? new Map(Object.entries(allowedModelIdsByProvider).map(([providerID, modelIDs]) => [providerID, new Set(modelIDs)]))
        : null, [allowedModelIdsByProvider]);
    const hiddenModelKeys = React.useMemo(
        () => new Set(hiddenModels.map((entry) => `${entry.providerID}:${entry.modelID}`)),
        [hiddenModels],
    );
    const providerByID = React.useMemo(() => new Map(providers.map((provider) => [provider.id, provider])), [providers]);
    const orderedProviders = React.useMemo(() => {
        if (!providerOrder?.length) return providers;
        const rank = new Map(providerOrder.map((providerID, index) => [providerID, index]));
        return [...providers].sort((left, right) => {
            const leftRank = rank.get(left.id);
            const rightRank = rank.get(right.id);
            if (leftRank === undefined && rightRank === undefined) return 0;
            if (leftRank === undefined) return 1;
            if (rightRank === undefined) return -1;
            return leftRank - rightRank;
        });
    }, [providerOrder, providers]);

    const isAllowed = React.useCallback((providerID: string, modelID: string) => {
        if (allowedProviderSet && !allowedProviderSet.has(providerID)) return false;
        if (allowedModelsByProvider && allowedModelsByProvider.get(providerID)?.has(modelID) !== true) return false;
        return !hiddenModelKeys.has(`${providerID}:${modelID}`);
    }, [allowedModelsByProvider, allowedProviderSet, hiddenModelKeys]);

    const matchesQuery = React.useCallback((entry: ModelPickerEntry) => {
        const normalizedQuery = query.trim();
        if (!normalizedQuery) return true;
        const provider = providerByID.get(entry.providerID);
        const providerName = provider?.name || entry.providerID;
        const modelName = getModelDisplayName(entry.model, entry.modelID, { maxLength: 40 });
        return matchesModelSearch(modelName, normalizedQuery)
            || matchesModelSearch(entry.modelID, normalizedQuery)
            || matchesModelSearch(providerName, normalizedQuery);
    }, [providerByID, query]);

    const filteredFavorites = React.useMemo(
        () => favoriteModels.filter((entry) => isAllowed(entry.providerID, entry.modelID) && matchesQuery(entry)),
        [favoriteModels, isAllowed, matchesQuery],
    );
    const filteredRecents = React.useMemo(
        () => recentModels.filter((entry) => isAllowed(entry.providerID, entry.modelID) && matchesQuery(entry)),
        [isAllowed, matchesQuery, recentModels],
    );
    const filteredProviders = React.useMemo(() => orderedProviders
        .filter((provider) => !allowedProviderSet || allowedProviderSet.has(provider.id))
        .map((provider) => {
            const providerMatches = query.trim().length > 0
                && (matchesModelSearch(provider.name || provider.id, query.trim()) || matchesModelSearch(provider.id, query.trim()));
            const models = (provider.models ?? []).filter((model) => {
                const modelID = typeof model.id === 'string' ? model.id : '';
                if (!modelID || !isAllowed(provider.id, modelID)) return false;
                if (providerMatches || !query.trim()) return true;
                return matchesModelSearch(getModelDisplayName(model, modelID, { maxLength: 40 }), query.trim())
                    || matchesModelSearch(modelID, query.trim());
            });
            return { provider, models };
        })
        .filter((entry) => entry.models.length > 0), [allowedProviderSet, isAllowed, orderedProviders, query]);

    const formatVariantLabel = React.useCallback((variant: string | undefined) => {
        if (!variant?.trim()) return t('chat.modelControls.default');
        const trimmed = variant.trim();
        if (/^\d+(\.\d+)?$/.test(trimmed)) return trimmed;
        return trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
    }, [t]);

    const getMetadataIcons = React.useCallback((metadata?: ModelMetadata): MetadataIcon[] => {
        const icons: MetadataIcon[] = [];
        if (metadata?.tool_call) icons.push({ key: 'tool_call', icon: 'tools', label: t('chat.modelControls.capability.toolCalling') });
        if (metadata?.reasoning) icons.push({ key: 'reasoning', icon: 'brain-ai-3', label: t('chat.modelControls.capability.reasoning') });
        const modalityIcons: Record<string, { icon: IconName; label: string }> = {
            text: { icon: 'text', label: t('chat.modelControls.modality.text') },
            image: { icon: 'file-image', label: t('chat.modelControls.modality.image') },
            video: { icon: 'file-video', label: t('chat.modelControls.modality.video') },
            audio: { icon: 'file-music', label: t('chat.modelControls.modality.audio') },
            pdf: { icon: 'file-pdf', label: t('chat.modelControls.modality.pdf') },
        };
        for (const modality of [...(metadata?.modalities?.input ?? []), ...(metadata?.modalities?.output ?? [])]) {
            const normalized = modality.trim().toLowerCase();
            const definition = modalityIcons[normalized];
            if (definition && !icons.some((entry) => entry.key === normalized)) icons.push({ key: normalized, ...definition });
        }
        return icons;
    }, [t]);

    const openVariantOverflow = (providerID: string, modelID: string) => {
        setVariantTarget({ providerID, modelID });
        setView('variant');
    };

    const renderModelRow = (entry: ModelPickerEntry) => {
        const { model, providerID, modelID } = entry;
        const rowKey = `${providerID}:${modelID}`;
        const selected = providerID === selectedProviderID && modelID === selectedModelID;
        const metadata = mergeModelMetadataWithLiveModel(
            providerID,
            model,
            getMetadata?.(providerID, modelID) ?? modelsMetadata.get(`${providerID}/${modelID}`),
        );
        const variants = variantSelectionEnabled ? getVariantOptions(providers, providerID, modelID) : [];
        const selectedVariant = resolveSelectedVariant(providerID, modelID);
        const inlineVariants = [undefined, ...variants].slice(0, MAX_INLINE_VARIANT_OPTIONS);
        const expanded = expandedModelKey === rowKey;
        const metadataIcons = getMetadataIcons(metadata);
        const contextText = metadata?.limit?.context ? `${formatTokens(metadata.limit.context)} ctx` : null;

        return (
            <div key={`mobile-model-${rowKey}`} className={cn('border-b border-border/30 last:border-b-0', selected && 'bg-interactive-selection/15 text-interactive-selection-foreground')}>
                <div className="flex items-center gap-2 px-2 py-1.5">
                    <button type="button" onClick={() => onSelect(providerID, modelID, selectedVariant)} className="flex min-w-0 flex-1 items-start gap-2 rounded-lg text-left focus:outline-none focus-visible:ring-1 focus-visible:ring-primary">
                        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                            <div className="flex min-w-0 items-center gap-1.5">
                                <ModelLogo modelId={modelID} providerId={providerID} className="size-3.5 flex-shrink-0" />
                                <span className="truncate typography-meta font-medium text-foreground">{getModelDisplayName(model, modelID, { maxLength: 40 })}</span>
                                {selected ? <Icon name="check" className="size-4 flex-shrink-0 text-primary" /> : null}
                            </div>
                            {contextText || metadataIcons.length > 0 ? (
                                <div className="flex min-w-0 items-center gap-1.5 overflow-hidden typography-micro text-muted-foreground">
                                    {contextText ? <span className="flex-shrink-0 whitespace-nowrap">{contextText}</span> : null}
                                    {contextText && metadataIcons.length > 0 ? <span aria-hidden="true" className="h-3 w-px flex-shrink-0 bg-border/50" /> : null}
                                    <div className="flex min-w-0 items-center gap-1 overflow-hidden whitespace-nowrap pl-0.5">
                                        {metadataIcons.map(({ key, icon, label }) => (
                                            <span key={`${rowKey}-${key}`} className="flex size-4 flex-shrink-0 items-center justify-center text-muted-foreground" title={label} aria-label={label}>
                                                <Icon name={icon} className="size-3" />
                                            </span>
                                        ))}
                                    </div>
                                </div>
                            ) : null}
                        </div>
                    </button>
                    {variants.length > 0 ? (
                        <button type="button" onClick={() => setExpandedModelKey((current) => current === rowKey ? null : rowKey)} className="flex flex-shrink-0 items-center gap-0.5 typography-micro font-medium text-muted-foreground hover:text-foreground" aria-expanded={expanded} aria-label={expanded ? t('chat.modelControls.hideThinkingModes') : t('chat.modelControls.showThinkingModes')}>
                            <span className="whitespace-nowrap">{formatVariantLabel(selectedVariant)}</span>
                            <Icon name={expanded ? 'arrow-down-s' : 'arrow-right-s'} className="size-3.5" />
                        </button>
                    ) : null}
                    <button type="button" onClick={(event) => { event.preventDefault(); event.stopPropagation(); onToggleFavorite(providerID, modelID); }} className={cn('model-favorite-button flex size-5 flex-shrink-0 items-center justify-center hover:text-primary/80', isFavorite(providerID, modelID) ? 'text-primary' : 'text-muted-foreground')} aria-label={isFavorite(providerID, modelID) ? t('chat.modelControls.unfavoriteAria') : t('chat.modelControls.favoriteAria')} title={isFavorite(providerID, modelID) ? t('chat.modelControls.removeFromFavorites') : t('chat.modelControls.addToFavorites')}>
                        <Icon name={isFavorite(providerID, modelID) ? 'star-fill' : 'star'} className="size-4" />
                    </button>
                </div>
                {expanded && variants.length > 0 ? (
                    <div className="border-t border-border/30 p-2">
                        <div className="flex flex-wrap gap-2">
                            {inlineVariants.map((variant) => {
                                const variantSelected = variant === selectedVariant || (!variant && !selectedVariant);
                                return <button key={`${rowKey}-${variant ?? 'default'}`} type="button" onClick={() => onSelect(providerID, modelID, variant)} className={cn('inline-flex items-center rounded-full border px-2.5 py-1 typography-meta font-medium', variantSelected ? 'border-primary/30 bg-primary/10 text-foreground' : 'border-border/40 text-muted-foreground hover:bg-interactive-hover/50')} aria-pressed={variantSelected}>{formatVariantLabel(variant)}</button>;
                            })}
                            {inlineVariants.length < variants.length + 1 ? <button type="button" onClick={() => openVariantOverflow(providerID, modelID)} className="inline-flex items-center rounded-full border border-border/40 px-2.5 py-1 typography-meta font-medium text-muted-foreground hover:bg-interactive-hover/50" aria-label={t('chat.modelControls.moreThinkingModes')}>{t('inlineComment.actions.showMore')}</button> : null}
                        </div>
                    </div>
                ) : null}
            </div>
        );
    };

    const activeVariantTarget = variantTarget ?? (activeView === 'variant' && selectedProviderID && selectedModelID
        ? { providerID: selectedProviderID, modelID: selectedModelID }
        : null);
    const targetVariants = activeVariantTarget ? getVariantOptions(providers, activeVariantTarget.providerID, activeVariantTarget.modelID) : [];
    const targetSelectedVariant = activeVariantTarget ? resolveSelectedVariant(activeVariantTarget.providerID, activeVariantTarget.modelID) : undefined;
    const hasResults = filteredFavorites.length > 0 || filteredRecents.length > 0 || filteredProviders.length > 0;
    const isVariantView = activeView === 'variant' && Boolean(activeVariantTarget);

    return (
        <MobileResizableSheet
            id={`mobile-model-picker-sheet-${mobileSheetId}`}
            open={open}
            onOpenChange={(nextOpen) => {
                if (!nextOpen) onClose();
            }}
            leading={isVariantView ? (
                <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    onClick={() => setView('model')}
                    aria-label={t('onboarding.common.actions.back')}
                >
                    <Icon name="arrow-left" className="size-5" />
                </Button>
            ) : undefined}
            ariaLabel={isVariantView ? t('chat.modelControls.thinking') : t('chat.modelControls.selectModel')}
            closeAriaLabel={t('mobile.surface.closeAria')}
            resizeAriaLabel={t('mobile.sessions.sheet.resizeAria')}
            bodyClassName="px-2 pb-[max(0.5rem,var(--safe-area-inset-bottom,env(safe-area-inset-bottom,0px)))]"
        >
            <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto overscroll-contain">
                {isVariantView && activeVariantTarget ? (
                    <div className="flex flex-col gap-1.5">
                    {[undefined, ...targetVariants].map((variant) => {
                        const selected = variant === targetSelectedVariant || (!variant && !targetSelectedVariant);
                        return (
                            <button key={variant ?? 'default'} type="button" className={cn('flex w-full items-center justify-between gap-2 rounded-xl border px-2 py-1.5 text-left focus:outline-none focus-visible:ring-1 focus-visible:ring-primary', selected ? 'border-primary/30 bg-primary/10' : 'border-border/40')} onClick={() => onSelect(activeVariantTarget.providerID, activeVariantTarget.modelID, variant)}>
                                <span className="typography-meta font-medium text-foreground">{formatVariantLabel(variant)}</span>
                                {selected ? <Icon name="check" className="size-4 flex-shrink-0 text-primary" /> : null}
                            </button>
                        );
                    })}
                    </div>
                ) : (
                    <>
                    <div className="relative">
                        <Icon name="search" className="absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
                        <Input value={query} onChange={(event) => { setQuery(event.target.value); setExpandedModelKey(null); }} placeholder={t('chat.modelControls.searchProvidersOrModels')} className="h-9 rounded-xl border-border/40 bg-[var(--surface-elevated)] pl-7 typography-meta" />
                        {query ? <button type="button" onClick={() => { setQuery(''); setExpandedModelKey(null); }} className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground" aria-label={t('chat.modelControls.clearSearch')}><Icon name="close-circle" className="size-4" /></button> : null}
                    </div>
                    {!hasResults ? <div className="px-3 py-8 text-center typography-meta text-muted-foreground">{t('chat.modelControls.noProvidersOrModelsFound')}</div> : null}
                    {filteredFavorites.length > 0 ? (
                        <div className="overflow-hidden rounded-xl border border-border/40 bg-[var(--surface-elevated)]">
                            <div className="px-2 py-1.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground"><Icon name="star-fill" className="mr-1.5 inline-block size-3 text-primary" />{t('chat.modelControls.favorites')}</div>
                            <div className="flex flex-col border-t border-border/30">{filteredFavorites.map(renderModelRow)}</div>
                        </div>
                    ) : null}
                    {filteredRecents.length > 0 ? (
                        <div className="overflow-hidden rounded-xl border border-border/40 bg-[var(--surface-elevated)]">
                            <div className="px-2 py-1.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground"><Icon name="time" className="mr-1.5 inline-block size-3" />{t('chat.modelControls.recent')}</div>
                            <div className="flex flex-col border-t border-border/30">{filteredRecents.map(renderModelRow)}</div>
                        </div>
                    ) : null}
                    {filteredProviders.map(({ provider, models }) => {
                        const expanded = expandedProviders.has(provider.id) || query.trim().length > 0;
                        return (
                            <div key={provider.id} className="overflow-hidden rounded-xl border border-border/40 bg-[var(--surface-elevated)]">
                                <button type="button" onClick={() => { if (query.trim()) return; setExpandedProviders((current) => { const next = new Set(current); if (next.has(provider.id)) next.delete(provider.id); else next.add(provider.id); return next; }); }} className="flex w-full items-center justify-between gap-1.5 px-2 py-1.5 text-left" aria-expanded={expanded}>
                                    <div className="flex items-center gap-2"><ProviderLogo providerId={provider.id} className="size-3.5" /><span className="typography-meta font-medium text-foreground">{provider.name || provider.id}</span>{provider.id === selectedProviderID ? <span className="typography-micro text-primary/80">{t('chat.modelControls.current')}</span> : null}</div>
                                    <Icon name={expanded ? 'arrow-down-s' : 'arrow-right-s'} className="size-3 text-muted-foreground" />
                                </button>
                                {expanded ? <div className="flex flex-col border-t border-border/30">{models.map((model) => renderModelRow({ model, providerID: provider.id, modelID: model.id as string }))}</div> : null}
                            </div>
                        );
                    })}
                    </>
                )}
            </div>
        </MobileResizableSheet>
    );
};
