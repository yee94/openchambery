import { describe, expect, test } from 'vitest';

import {
  createLynxDiagnosticsRecorder,
  exportLynxDiagnostics,
  LYNX_CLIENT_DIAGNOSTICS_SCHEMA,
} from './diagnostics';

describe('about diagnostics export', () => {
  test('export gated by enabled switch', async () => {
    const recorder = createLynxDiagnosticsRecorder({ enabled: false });
    recorder.record({ feat: 'shell', kind: 'boot' });
    expect(await exportLynxDiagnostics(recorder, '1.0.0')).toEqual({ status: 'disabled' });
    recorder.setEnabled(true);
    recorder.record({ feat: 'shell', kind: 'boot' });
    const result = await exportLynxDiagnostics(recorder, '1.0.0');
    expect(result.status).toBe('json');
    if (result.status === 'json') {
      const parsed = JSON.parse(result.json);
      expect(parsed.schema).toBe(LYNX_CLIENT_DIAGNOSTICS_SCHEMA);
      expect(parsed.events).toHaveLength(1);
    }
  });
});
