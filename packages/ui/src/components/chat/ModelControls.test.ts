import { describe, expect, test } from 'bun:test';
import { resolveChatInputSelectionVariantOptions, resolveModelVariantKeys, type ChatInputSelection } from './chatInputSurface';

const selection: ChatInputSelection['value'] = { providerID: 'workspace', modelID: 'model-a', agent: 'build', variant: 'high' };
const catalog: NonNullable<ChatInputSelection['catalog']> = {
        providers: [],
        agents: [],
        variants: ['low', 'high'],
        variantsReady: true,
        ready: true,
    };

describe('ModelControls selection adapter variants', () => {
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
