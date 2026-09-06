import { describe, expect, test } from 'vitest';

import {
  deleteLynxDictationModel,
  loadLynxDictationStatus,
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
});
