import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { getSettingsBridgeMessageType, projectSettingsBootstrap } from './settings-bootstrap-runtime';

describe('VS Code settings bootstrap projection', () => {
  test('accepts credential-free HTTP(S) STT URLs', () => {
    const settings = projectSettingsBootstrap({
      sttServerUrl: 'https://stt.example.test/v1',
      messageStreamTransport: 'sse',
      sttProvider: 'openai-compatible',
      responseStylePreset: 'warmPeer',
    });

    assert.deepEqual(settings, {
      schemaVersion: 1,
      sttServerUrl: 'https://stt.example.test/v1',
      messageStreamTransport: 'sse',
      sttProvider: 'openai-compatible',
      responseStylePreset: 'warmPeer',
    });
  });

  test('omits URL credentials and unsupported enum values', () => {
    const settings = projectSettingsBootstrap({
      sttServerUrl: 'https://token:secret@stt.example.test/v1',
      messageStreamTransport: 'polling',
      sttProvider: 'whisper',
      responseStylePreset: 'verbose',
    });

    assert.deepEqual(settings, { schemaVersion: 1 });
  });

  test('maps the independent bootstrap path before generic settings routes', () => {
    assert.equal(
      getSettingsBridgeMessageType('/api/config/settings/bootstrap', 'GET', new URLSearchParams()),
      'api:config/settings:bootstrap',
    );
    assert.equal(
      getSettingsBridgeMessageType('/api/config/settings', 'GET', new URLSearchParams('bootstrap=true')),
      'api:config/settings:bootstrap',
    );
    assert.equal(
      getSettingsBridgeMessageType('/api/config/settings', 'GET', new URLSearchParams()),
      'api:config/settings:get',
    );
  });
});
