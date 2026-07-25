// Pure helpers for the Add Device transport → pairing-session mapping.
// Kept out of the page component so the classic-relay restore rule is unit-testable.

export type AddDeviceTransportMode = 'local' | 'lan' | 'relay' | 'hapi';

/**
 * Classic private-relay must be restored before createPairingSession whenever the
 * link will include a non-HAPI relay candidate (Anywhere, or LAN + away-relay
 * fallback). Pure LAN (fallback=false), pure local, and HAPI mode skip this —
 * HAPI configures its own hub path instead.
 */
export const shouldConfigureClassicRelayForPairing = (
    transport: AddDeviceTransportMode,
    includeRelay: boolean,
): boolean => includeRelay && transport !== 'hapi';
