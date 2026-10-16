import { describe, expect, test } from 'vitest';
import { resolveChatInputCatalogReadiness, resolveChatInputSelectionVariantOptions, resolveModelVariantKeys, type ChatInputSelection } from './chatInputSurface';
import { shouldCancelSearchableSelectorHoverDismiss } from './searchableSelectorDismiss';

const selection: ChatInputSelection['value'] = { providerID: 'workspace', modelID: 'model-a', agent: 'build', variant: 'high' };
const catalog: NonNullable<ChatInputSelection['catalog']> = {
        providers: [],
        agents: [],
        variants: ['low', 'high'],
        variantsReady: true,
        ready: true,
    };

describe('shouldCancelSearchableSelectorHoverDismiss', () => {
    test('cancels only hover-driven closes on searchable model/agent menus', () => {
        expect(shouldCancelSearchableSelectorHoverDismiss(false, 'trigger-hover')).toBe(true);
        expect(shouldCancelSearchableSelectorHoverDismiss(false, 'outside-press')).toBe(false);
        expect(shouldCancelSearchableSelectorHoverDismiss(false, 'escape-key')).toBe(false);
        expect(shouldCancelSearchableSelectorHoverDismiss(false, 'focus-out')).toBe(false);
        expect(shouldCancelSearchableSelectorHoverDismiss(true, 'trigger-hover')).toBe(false);
        expect(shouldCancelSearchableSelectorHoverDismiss(false, undefined)).toBe(false);
    });
});

describe('ModelControls selection adapter variants', () => {
    test('a pending agent catalog cannot hide already-loaded models and variants', () => {
        const pendingAgents = { ...catalog, ready: false, loading: true, modelsReady: true, agentsReady: false };
        expect(resolveChatInputCatalogReadiness(pendingAgents, { modelsReady: false, agentsReady: false })).toEqual({ modelsReady: true, agentsReady: false });
        expect(resolveChatInputSelectionVariantOptions(selection, pendingAgents, 'workspace', 'model-a')).toEqual(['low', 'high']);
        expect(resolveChatInputCatalogReadiness({ ...pendingAgents, modelsReady: false, agentsReady: true }, { modelsReady: true, agentsReady: true })).toEqual({ modelsReady: false, agentsReady: true });
    });

    test('secondary catalogs retain their own readiness and errors rather than borrowing global readiness', () => {
        const fallback = { modelsReady: true, agentsReady: true };
        expect(resolveChatInputCatalogReadiness({ ...catalog, ready: false, loading: true }, fallback)).toEqual({ modelsReady: false, agentsReady: false });
        expect(resolveChatInputCatalogReadiness({ ...catalog, error: true, modelsReady: true, agentsReady: true }, fallback)).toEqual({ modelsReady: false, agentsReady: false });
        expect(resolveChatInputCatalogReadiness(catalog, { modelsReady: false, agentsReady: false })).toEqual(fallback);
    });

    test('reads variants only for the adapter selection', () => {
        expect(resolveChatInputSelectionVariantOptions(selection, catalog, 'workspace', 'model-a')).toEqual(['low', 'high']);
        expect(resolveChatInputSelectionVariantOptions(selection, catalog, 'global', 'model-a')).toEqual([]);
        expect(resolveChatInputSelectionVariantOptions(selection, catalog, 'workspace', 'model-b')).toEqual([]);
    });

    test('keeps variants unavailable until the adapter catalog is ready', () => {
        expect(resolveChatInputSelectionVariantOptions(selection, { ...catalog, variantsReady: false }, 'workspace', 'model-a')).toEqual([]);
    });

    test('derives variant keys from Record-shaped provider model variants', () => {
        expect(resolveModelVariantKeys({ variants: { low: {}, high: {} } })).toEqual(['low', 'high']);
        expect(resolveModelVariantKeys({ variants: ['low', 'high'] })).toEqual(['low', 'high']);
        expect(resolveModelVariantKeys({ variants: [{ id: 'low', settings: { reasoningEffort: 'low' } }, { id: 'high' }, { id: 'low' }, { settings: {} }] })).toEqual(['low', 'high']);
        expect(resolveModelVariantKeys({ variants: undefined })).toEqual([]);
    });

    test('falls back to catalog providers when variants array is omitted', () => {
        const providerCatalog: NonNullable<ChatInputSelection['catalog']> = {
            providers: [{
                id: 'workspace',
                models: [{ id: 'model-a', variants: { low: {}, high: {} } }],
            }],
            agents: [],
            variantsReady: true,
            ready: true,
        };
        expect(resolveChatInputSelectionVariantOptions(selection, providerCatalog, 'workspace', 'model-a')).toEqual(['low', 'high']);
    });
});
