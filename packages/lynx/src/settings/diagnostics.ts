/**
 * About diagnostics export — Cap `openchamber.client-diagnostics.v1` spirit.
 * Local ring buffer only; no invented server log fetch. Host may optionally
 * save via OpenChamberMedia.saveFile — without host, export returns JSON text.
 */

export const LYNX_CLIENT_DIAGNOSTICS_SCHEMA = 'openchamber.client-diagnostics.v1';
export const LYNX_CLIENT_DIAGNOSTICS_LIMIT = 200;
export const LYNX_CLIENT_DIAGNOSTICS_PREF_KEY = 'openchamber.client-diagnostics.enabled';

export type LynxDiagnosticsFeat = 'transcript' | 'task' | 'perf' | 'shell' | 'connect';

export type LynxDiagnosticsEvent = {
  ts: number;
  feat: LynxDiagnosticsFeat;
  kind: string;
  sessionID?: string;
  detail?: Record<string, unknown>;
};

export type LynxDiagnosticsReport = {
  schema: typeof LYNX_CLIENT_DIAGNOSTICS_SCHEMA;
  exportedAt: number;
  lynxClientVersion: string;
  enabled: boolean;
  events: LynxDiagnosticsEvent[];
};

export type LynxDiagnosticsRecorder = {
  setEnabled: (enabled: boolean) => void;
  isEnabled: () => boolean;
  record: (event: Omit<LynxDiagnosticsEvent, 'ts'> & { ts?: number }) => void;
  clear: () => void;
  exportReport: (lynxClientVersion: string) => LynxDiagnosticsReport;
  exportJson: (lynxClientVersion: string) => string;
};

export const createLynxDiagnosticsRecorder = (
  options?: { limit?: number; enabled?: boolean },
): LynxDiagnosticsRecorder => {
  const limit = options?.limit ?? LYNX_CLIENT_DIAGNOSTICS_LIMIT;
  let enabled = options?.enabled ?? false;
  const events: LynxDiagnosticsEvent[] = [];

  return {
    setEnabled: (next) => {
      enabled = next;
    },
    isEnabled: () => enabled,
    record: (event) => {
      if (!enabled) return;
      events.push({
        ts: event.ts ?? Date.now(),
        feat: event.feat,
        kind: event.kind,
        sessionID: event.sessionID,
        detail: event.detail,
      });
      while (events.length > limit) events.shift();
    },
    clear: () => {
      events.length = 0;
    },
    exportReport: (lynxClientVersion) => ({
      schema: LYNX_CLIENT_DIAGNOSTICS_SCHEMA,
      exportedAt: Date.now(),
      lynxClientVersion,
      enabled,
      events: [...events],
    }),
    exportJson: (lynxClientVersion) => JSON.stringify(
      {
        schema: LYNX_CLIENT_DIAGNOSTICS_SCHEMA,
        exportedAt: Date.now(),
        lynxClientVersion,
        enabled,
        events: [...events],
      },
      null,
      2,
    ),
  };
};

export type LynxDiagnosticsSaveBinder = {
  /** Cap OpenChamberMedia.saveFile spirit — host document picker. */
  saveFile: (options: { name: string; mime: string; dataBase64: string }) => Promise<void>;
};

export type LynxDiagnosticsExportResult =
  | { status: 'saved' }
  | { status: 'json'; json: string }
  | { status: 'disabled' }
  | { status: 'failed'; error: string };

export const exportLynxDiagnostics = async (
  recorder: LynxDiagnosticsRecorder,
  lynxClientVersion: string,
  saveBinder?: LynxDiagnosticsSaveBinder | null,
): Promise<LynxDiagnosticsExportResult> => {
  if (!recorder.isEnabled()) return { status: 'disabled' };
  const json = recorder.exportJson(lynxClientVersion);
  if (!saveBinder) return { status: 'json', json };
  try {
    const dataBase64 = typeof btoa === 'function'
      ? btoa(unescape(encodeURIComponent(json)))
      : Buffer.from(json, 'utf8').toString('base64');
    await saveBinder.saveFile({
      name: `openchamber-lynx-diagnostics-${Date.now()}.json`,
      mime: 'application/octet-stream',
      dataBase64,
    });
    return { status: 'saved' };
  } catch (error) {
    return {
      status: 'failed',
      error: error instanceof Error ? error.message : String(error),
    };
  }
};
