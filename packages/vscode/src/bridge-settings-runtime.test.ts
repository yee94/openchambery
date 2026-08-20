import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import { formatSettingsResponse } from './settings-visible-runtime';

describe('VS Code visible settings projection', () => {
  test('returns known non-sensitive settings and excludes credential sentinels', () => {
    const credentialSentinel = 'credential-sentinel';
    const settings = formatSettingsResponse({
      defaultModel: 'openai/gpt-5',
      messageStreamTransport: 'sse',
      summaryCustomAPIToken: credentialSentinel,
      desktopUiPassword: credentialSentinel,
      unknownPersistedSetting: credentialSentinel,
    }, { themeVariant: 'dark', lastDirectory: '/workspace' });

    assert.deepEqual(settings, {
      defaultModel: 'openai/gpt-5',
      messageStreamTransport: 'sse',
      hasSummaryCustomAPIToken: true,
      themeVariant: 'dark',
      lastDirectory: '/workspace',
      opencodeBinary: undefined,
    });
    assert.equal(JSON.stringify(settings).includes(credentialSentinel), false);
  });
});
