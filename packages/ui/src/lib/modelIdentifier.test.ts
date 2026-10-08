import { describe, expect, it } from 'vitest';
import { normalizeModelIdentifier, parseModelIdentifier } from './modelIdentifier';

describe('configured model selections', () => {
  it('normalizes both wire shapes, retaining slash-containing model ids and variants', () => {
    const object = { providerID: 'router', model: 'vendor/model', variant: 'high' };
    expect(parseModelIdentifier(object)).toEqual({ providerId: 'router', modelId: 'vendor/model', variant: 'high' });
    expect(normalizeModelIdentifier(object)).toBe('router/vendor/model#high');
    expect(parseModelIdentifier('router/vendor/model#high')).toEqual(parseModelIdentifier(object));
    expect(parseModelIdentifier({ providerID: 'p', model: 'm' })).toEqual({ providerId: 'p', modelId: 'm' });
  });

  it.each([undefined, null, 42, {}, [], { providerID: 'p' }, { model: 'm' },
    { providerID: 'p/x', model: 'm' }, { providerID: 'p', model: 'm', variant: 3 },
    'p/', '/m', 'p/m#', 'p/m#high#low', 'p /m', 'p/m bad'])('rejects malformed references: %j', (input) => {
    expect(parseModelIdentifier(input)).toBeNull();
  });
});
