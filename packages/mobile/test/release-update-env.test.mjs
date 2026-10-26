import { expect, test } from 'vitest';
import { verifyReleaseUpdateEnv } from '../../../scripts/verify-release-update-env.mjs';

function fixture() {
  return {
    YURI_UPDATE_ORIGIN: 'https://mirror.example.com',
    YURI_OTA_UPDATE_URL: 'https://mirror.example.com/v1/ota/check',
    VITE_YURI_EDGEONE_UPDATE_CHECK_URL: 'https://mirror.example.com/v1/update/check',
    VITE_YURI_VERCEL_UPDATE_CHECK_URL: 'https://origin.example.com/v1/update/check',
    VITE_YURI_EDGEONE_OTA_CHECK_URL: 'https://mirror.example.com/v1/mobile/update/check',
    VITE_YURI_VERCEL_OTA_CHECK_URL: 'https://origin.example.com/v1/mobile/update/check',
  };
}

test('validates a consistent native and web endpoint pair before packaging', () => {
  expect(verifyReleaseUpdateEnv(fixture())).toEqual({ origin: 'https://origin.example.com', mirror: 'https://mirror.example.com' });
});

test.each(['', '/v1/ota/check', 'https://updates.example.invalid/v1/ota/check', 'http://mirror.example.com/v1/ota/check', 'https://mirror.example.com/v1/mobile/update/check'])('rejects unusable native OTA address %s', value => {
  expect(() => verifyReleaseUpdateEnv({ ...fixture(), YURI_OTA_UPDATE_URL: value })).toThrow();
});

test('rejects mismatched native and UI update deployments', () => {
  expect(() => verifyReleaseUpdateEnv({ ...fixture(), YURI_UPDATE_ORIGIN: 'https://other.example.com' })).toThrow('same distinct');
});
