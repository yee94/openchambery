/**
 * Settings Voice — Cap `/api/dictation/*` only. No invented ASR / mic capture.
 * Routes: GET /api/dictation/status, POST/DELETE /api/dictation/models/:id
 * WS `/api/dictation/ws` stays host/mic-bound and is intentionally not claimed here.
 */
import type { LynxRuntimeFetch } from '../runtime/fetch';

export type LynxDictationStatusResult =
  | { status: 'ok'; payload: Record<string, unknown> }
  | { status: 'no-runtime' }
  | { status: 'unsupported' }
  | { status: 'failed'; error: Error; httpStatus?: number };

export type LynxDictationModelMutationResult =
  | { status: 'ok'; payload: Record<string, unknown> }
  | { status: 'no-runtime' }
  | { status: 'unsupported' }
  | { status: 'failed'; error: Error; httpStatus?: number };

/** Cap `DictationModelState` (+ Lynx STT/TTS kind for VoiceBody rows). */
export type LynxDictationModelState = {
  id: string;
  installed: boolean;
  downloading: boolean;
  downloadProgress: number | null;
  downloadError: string | null;
  kind: 'stt' | 'tts';
};

/** Cap local Kokoro TTS model id (`VoiceSettings.tsx` LOCAL_TTS_MODEL_ID). */
export const LYNX_LOCAL_TTS_MODEL_ID = 'kokoro-en-v0_19' as const;

const asRecord = (data: unknown): Record<string, unknown> => (
  data && typeof data === 'object' && !Array.isArray(data)
    ? data as Record<string, unknown>
    : {}
);

const parseModelEntry = (
  raw: unknown,
  kind: 'stt' | 'tts',
): LynxDictationModelState | null => {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  const id = typeof record.id === 'string' ? record.id.trim() : '';
  if (!id) return null;
  return {
    id,
    installed: Boolean(record.installed),
    downloading: Boolean(record.downloading),
    downloadProgress: typeof record.downloadProgress === 'number'
      ? record.downloadProgress
      : null,
    downloadError: typeof record.downloadError === 'string'
      ? record.downloadError
      : null,
    kind,
  };
};

/**
 * Parse Cap `/api/dictation/status` models + optional Kokoro row from `ttsModels`.
 * Does not invent ASR — display/management only.
 */
export const parseLynxDictationModels = (
  payload: Record<string, unknown>,
): LynxDictationModelState[] => {
  const out: LynxDictationModelState[] = [];
  if (Array.isArray(payload.models)) {
    for (const entry of payload.models) {
      const parsed = parseModelEntry(entry, 'stt');
      if (parsed) out.push(parsed);
    }
  }
  if (Array.isArray(payload.ttsModels)) {
    for (const entry of payload.ttsModels) {
      const parsed = parseModelEntry(entry, 'tts');
      if (parsed && parsed.id === LYNX_LOCAL_TTS_MODEL_ID) out.push(parsed);
    }
  }
  return out;
};

/** Cap `GET /api/dictation/status`. */
export const loadLynxDictationStatus = async (
  runtimeFetch: LynxRuntimeFetch | null | undefined,
  options?: { provider?: string; localModel?: string; signal?: AbortSignal },
): Promise<LynxDictationStatusResult> => {
  if (!runtimeFetch) return { status: 'no-runtime' };
  try {
    const params = new URLSearchParams();
    if (options?.provider) params.set('provider', options.provider);
    if (options?.localModel) params.set('localModel', options.localModel);
    const query = params.toString();
    const path = query ? `/api/dictation/status?${query}` : '/api/dictation/status';
    const response = await runtimeFetch(path, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: options?.signal,
    });
    if (response.status === 0) return { status: 'no-runtime' };
    if (response.status === 404 || response.status === 501) return { status: 'unsupported' };
    if (!response.ok) {
      return {
        status: 'failed',
        error: new Error(`dictation status failed (${response.status})`),
        httpStatus: response.status,
      };
    }
    return { status: 'ok', payload: asRecord(await response.json()) };
  } catch (error) {
    return {
      status: 'failed',
      error: error instanceof Error ? error : new Error(String(error)),
    };
  }
};

/** Cap `POST /api/dictation/models/:modelId/download`. */
export const requestLynxDictationModelDownload = async (
  runtimeFetch: LynxRuntimeFetch | null | undefined,
  modelId: string,
  options?: { signal?: AbortSignal },
): Promise<LynxDictationModelMutationResult> => {
  if (!runtimeFetch) return { status: 'no-runtime' };
  const id = modelId.trim();
  if (!id) return { status: 'failed', error: new Error('model id required') };
  try {
    const response = await runtimeFetch(
      `/api/dictation/models/${encodeURIComponent(id)}/download`,
      {
        method: 'POST',
        headers: { Accept: 'application/json' },
        signal: options?.signal,
      },
    );
    if (response.status === 0) return { status: 'no-runtime' };
    if (response.status === 404 || response.status === 501) return { status: 'unsupported' };
    if (!response.ok) {
      return {
        status: 'failed',
        error: new Error(`dictation download failed (${response.status})`),
        httpStatus: response.status,
      };
    }
    return { status: 'ok', payload: asRecord(await response.json()) };
  } catch (error) {
    return {
      status: 'failed',
      error: error instanceof Error ? error : new Error(String(error)),
    };
  }
};

/** Cap `DELETE /api/dictation/models/:modelId`. */
export const deleteLynxDictationModel = async (
  runtimeFetch: LynxRuntimeFetch | null | undefined,
  modelId: string,
  options?: { signal?: AbortSignal },
): Promise<LynxDictationModelMutationResult> => {
  if (!runtimeFetch) return { status: 'no-runtime' };
  const id = modelId.trim();
  if (!id) return { status: 'failed', error: new Error('model id required') };
  try {
    const response = await runtimeFetch(
      `/api/dictation/models/${encodeURIComponent(id)}`,
      {
        method: 'DELETE',
        headers: { Accept: 'application/json' },
        signal: options?.signal,
      },
    );
    if (response.status === 0) return { status: 'no-runtime' };
    if (response.status === 404 || response.status === 501) return { status: 'unsupported' };
    if (!response.ok) {
      return {
        status: 'failed',
        error: new Error(`dictation delete failed (${response.status})`),
        httpStatus: response.status,
      };
    }
    return { status: 'ok', payload: asRecord(await response.json()) };
  } catch (error) {
    return {
      status: 'failed',
      error: error instanceof Error ? error : new Error(String(error)),
    };
  }
};

/**
 * Cap VoiceSettings download/delete then refresh status (provider=local).
 * Never invents success — mutation + status results stay honest.
 */
export const mutateLynxDictationModelThenRefresh = async (
  runtimeFetch: LynxRuntimeFetch | null | undefined,
  modelId: string,
  action: 'download' | 'delete',
  options?: { signal?: AbortSignal },
): Promise<{
  mutation: LynxDictationModelMutationResult;
  status: LynxDictationStatusResult;
}> => {
  const mutation = action === 'download'
    ? await requestLynxDictationModelDownload(runtimeFetch, modelId, options)
    : await deleteLynxDictationModel(runtimeFetch, modelId, options);
  const status = await loadLynxDictationStatus(runtimeFetch, {
    provider: 'local',
    signal: options?.signal,
  });
  return { mutation, status };
};

/** Honest label: mic / WS ASR is host-bound; this page only lists status + model management. */
export const LYNX_DICTATION_VOICE_POLICY = 'status-and-models-only-no-invented-asr' as const;
