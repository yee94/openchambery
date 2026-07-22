import { describe, expect, test } from 'bun:test';
import {
  getSettingsBridgeMessageType,
  isSettingsBootstrapRequest,
  projectSettingsBootstrap,
} from './settings-bootstrap-runtime.ts';

describe('VS Code settings bootstrap projector', () => {
  test('projects the allowlist and excludes secret sentinels', () => {
    const result = projectSettingsBootstrap({
      defaultModel: ' provider/model ',
      defaultVariant: 'fast',
      defaultAgent: 'build',
      autoCreateWorktree: true,
      gitmojiEnabled: false,
      defaultFileViewerPreview: true,
      zenModel: 'zen/model',
      messageStreamTransport: 'ws',
      sttProvider: 'local',
      sttServerUrl: ' https://speech.example.test ',
      sttModel: 'whisper',
      sttLocalModel: 'tiny',
      sttLanguage: ' en ',
      responseStyleEnabled: true,
      responseStylePreset: 'concise',
      responseStyleCustomInstructions: 'Be concise.',
      token: 'TOKEN_SENTINEL',
      apiKey: 'API_KEY_SENTINEL',
      password: 'PASSWORD_SENTINEL',
      managedRemoteTunnelToken: 'TUNNEL_SENTINEL',
      summaryCustomAPIToken: 'SUMMARY_SENTINEL',
    });

    expect(result).toEqual({
      schemaVersion: 1,
      defaultModel: 'provider/model',
      defaultVariant: 'fast',
      defaultAgent: 'build',
      autoCreateWorktree: true,
      gitmojiEnabled: false,
      defaultFileViewerPreview: true,
      zenModel: 'zen/model',
      messageStreamTransport: 'ws',
      sttProvider: 'local',
      sttServerUrl: 'https://speech.example.test',
      sttModel: 'whisper',
      sttLocalModel: 'tiny',
      sttLanguage: 'en',
      responseStyleEnabled: true,
      responseStylePreset: 'concise',
      responseStyleCustomInstructions: 'Be concise.',
    });
  });

  test('enforces bootstrap field limits', () => {
    const result = projectSettingsBootstrap({
      defaultModel: 'm'.repeat(513),
      sttServerUrl: 'u'.repeat(4097),
      sttLanguage: 'l'.repeat(65),
      responseStyleCustomInstructions: 'i'.repeat(200001),
    });

    expect(result).toEqual({ schemaVersion: 1 });
  });

  test('rejects URL credentials and unsupported enum values', () => {
    expect(projectSettingsBootstrap({
      sttServerUrl: 'https://user:secret@speech.example.test',
      messageStreamTransport: 'poll',
      sttProvider: 'server',
      responseStylePreset: 'unknown',
    })).toEqual({ schemaVersion: 1 });
  });

  test('selects the bootstrap route only for bootstrap=true', () => {
    expect(isSettingsBootstrapRequest(new URLSearchParams('bootstrap=true'))).toBe(true);
    expect(isSettingsBootstrapRequest(new URLSearchParams('bootstrap=false'))).toBe(false);
    expect(isSettingsBootstrapRequest(new URLSearchParams())).toBe(false);
  });

  test('routes the independent bootstrap path before full settings', () => {
    expect(getSettingsBridgeMessageType(
      '/api/config/settings/bootstrap',
      'GET',
      new URLSearchParams(),
    )).toBe('api:config/settings:bootstrap');
    expect(getSettingsBridgeMessageType(
      '/api/config/settings',
      'GET',
      new URLSearchParams(),
    )).toBe('api:config/settings:get');
  });
});
