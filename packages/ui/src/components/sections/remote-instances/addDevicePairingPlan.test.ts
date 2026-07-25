import { describe, expect, test } from 'bun:test';

import { shouldConfigureClassicRelayForPairing } from './addDevicePairingPlan';

describe('shouldConfigureClassicRelayForPairing', () => {
    test('LAN + away-relay fallback restores classic (clears leftover HAPI)', () => {
        expect(shouldConfigureClassicRelayForPairing('lan', true)).toBe(true);
    });

    test('pure LAN (fallback=false) does not touch classic relay', () => {
        expect(shouldConfigureClassicRelayForPairing('lan', false)).toBe(false);
    });

    test('Anywhere / relay always restores classic', () => {
        expect(shouldConfigureClassicRelayForPairing('relay', true)).toBe(true);
    });

    test('local and HAPI never call configureClassicRelay via this gate', () => {
        expect(shouldConfigureClassicRelayForPairing('local', false)).toBe(false);
        expect(shouldConfigureClassicRelayForPairing('hapi', true)).toBe(false);
        expect(shouldConfigureClassicRelayForPairing('hapi', false)).toBe(false);
    });
});
