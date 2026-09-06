import { describe, expect, test } from 'vitest';

import {
  deleteLynxDictationModel,
  loadLynxDictationStatus,
  LYNX_DICTATION_VOICE_POLICY,
  LYNX_LOCAL_TTS_MODEL_ID,
  mutateLynxDictationModelThenRefresh,
  parseLynxDictationModels,
  requestLynxDictationModelDownload,
} from './dictation';

describe('dictation settings (no invented ASR)', () => {
  test('status hits Cap route', async () => {
    const result = await loadLynxDictationStatus(async (path) => {
      expect(path).toBe('/api/dictation/status');
      return {
        ok: true,
        status: 200,
        json: async () => ({ ready: true, models: [] }),
        text: async () => '',
      } as never;
    });
    expect(result.status).toBe('ok');
  });

  test('status with provider=local matches Cap VoiceSettings query', async () => {
    const result = await loadLynxDictationStatus(async (path) => {
      expect(path).toBe('/api/dictation/status?provider=local');
      return {
        ok: true,
        status: 200,
        json: async () => ({ ready: false, models: [] }),
        text: async () => '',
      } as never;
    }, { provider: 'local' });
    expect(result.status).toBe('ok');
  });

  test('download / delete hit Cap model routes', async () => {
    const download = await requestLynxDictationModelDownload(async (path, init) => {
      expect(path).toBe('/api/dictation/models/sherpa/download');
      expect(init?.method).toBe('POST');
      return { ok: true, status: 200, json: async () => ({ ok: true }), text: async () => '' } as never;
    }, 'sherpa');
    expect(download.status).toBe('ok');
    const deleted = await deleteLynxDictationModel(async (path, init) => {
      expect(path).toBe('/api/dictation/models/sherpa');
      expect(init?.method).toBe('DELETE');
      return { ok: true, status: 200, json: async () => ({ ok: true }), text: async () => '' } as never;
    }, 'sherpa');
    expect(deleted.status).toBe('ok');
  });

  test('no-runtime honest', async () => {
    expect(await loadLynxDictationStatus(null)).toEqual({ status: 'no-runtime' });
  });

  test('parse models + Kokoro ttsModels row', () => {
    const parsed = parseLynxDictationModels({
      ready: true,
      models: [
        {
          id: 'whisper-tiny-int8',
          installed: false,
          downloading: true,
          downloadProgress: 42,
          downloadError: null,
        },
        { id: '  ', installed: true },
      ],
      ttsModels: [
        {
          id: LYNX_LOCAL_TTS_MODEL_ID,
          installed: true,
          downloading: false,
          downloadProgress: null,
          downloadError: null,
        },
        { id: 'other-tts', installed: true },
      ],
    });
    expect(parsed).toEqual([
      {
        id: 'whisper-tiny-int8',
        installed: false,
        downloading: true,
        downloadProgress: 42,
        downloadError: null,
        kind: 'stt',
      },
      {
        id: LYNX_LOCAL_TTS_MODEL_ID,
        installed: true,
        downloading: false,
        downloadProgress: null,
        downloadError: null,
        kind: 'tts',
      },
    ]);
  });

  test('VoiceBody wiring: download then refresh status (honest, no fake-success)', async () => {
    const calls: Array<{ path: string; method?: string }> = [];
    const fetch = async (path: string, init?: { method?: string }) => {
      calls.push({ path, method: init?.method });
      if (path.endsWith('/download')) {
        return { ok: true, status: 200, json: async () => ({ ok: true }), text: async () => '' } as never;
      }
      if (path.startsWith('/api/dictation/status')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            ready: true,
            models: [{
              id: 'whisper-tiny-int8',
              installed: false,
              downloading: true,
              downloadProgress: 10,
              downloadError: null,
            }],
            ttsModels: [],
          }),
          text: async () => '',
        } as never;
      }
      throw new Error(`unexpected ${path}`);
    };
    const { mutation, status } = await mutateLynxDictationModelThenRefresh(
      fetch,
      'whisper-tiny-int8',
      'download',
    );
    expect(mutation.status).toBe('ok');
    expect(status.status).toBe('ok');
    if (status.status === 'ok') {
      expect(parseLynxDictationModels(status.payload)[0]?.downloading).toBe(true);
    }
    expect(calls).toEqual([
      { path: '/api/dictation/models/whisper-tiny-int8/download', method: 'POST' },
      { path: '/api/dictation/status?provider=local', method: 'GET' },
    ]);
  });

  test('VoiceBody wiring: delete failure stays honest (no fake-success)', async () => {
    const { mutation, status } = await mutateLynxDictationModelThenRefresh(
      async (path, init) => {
        if (init?.method === 'DELETE') {
          return { ok: false, status: 500, json: async () => ({}), text: async () => '' } as never;
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({
            ready: true,
            models: [{
              id: 'whisper-tiny-int8',
              installed: true,
              downloading: false,
              downloadProgress: null,
              downloadError: 'still present',
            }],
          }),
          text: async () => '',
        } as never;
      },
      'whisper-tiny-int8',
      'delete',
    );
    expect(mutation.status).toBe('failed');
    expect(status.status).toBe('ok');
  });

  test('policy forbids invented ASR', () => {
    expect(LYNX_DICTATION_VOICE_POLICY).toBe('status-and-models-only-no-invented-asr');
  });
});
