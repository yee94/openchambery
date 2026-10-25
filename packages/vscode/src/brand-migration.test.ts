import { describe, expect, it, vi } from 'vitest';
import type { WorkspaceConfiguration } from 'vscode';
import { importLegacyConfiguration } from './brand-migration';

const levels = [{ field: 'globalValue' as const, target: 1 }, { field: 'workspaceValue' as const, target: 2 }];
function store(values: Record<string, Record<string, unknown>>) {
  const inspect = ((key: string) => values[key]) as WorkspaceConfiguration['inspect'];
  const update = vi.fn(async (key: string, value: unknown, target: number) => {
    values[key] = { [target === 1 ? 'globalValue' : 'workspaceValue']: value };
  });
  return { inspect, update };
}

describe('explicit configuration import', () => {
  it('preserves explicit new values, imports winning legacy scope, and is idempotent', async () => {
    const oldValues = { apiUrl: { globalValue: 'http://localhost:3000', workspaceValue: 'https://host.example' }, opencodeBinary: { globalValue: '/bin/opencode' } };
    const source = store(oldValues);
    const destination = store({ opencodeBinary: { globalValue: '' } });
    expect(await importLegacyConfiguration(source, destination, levels)).toEqual({ imported: 1, skipped: 1, failed: 0 });
    expect(destination.update).toHaveBeenCalledWith('apiUrl', 'https://host.example', 2);
    expect(await importLegacyConfiguration(source, destination, levels)).toEqual({ imported: 0, skipped: 2, failed: 0 });
    expect(source.update).not.toHaveBeenCalled();
    expect(oldValues.apiUrl.globalValue).toBe('http://localhost:3000');
  });

  it('reports invalid values without copying credentials or masking errors', async () => {
    const source = store({ apiUrl: { globalValue: 'https://user:secret@host.example' }, opencodeBinary: { globalValue: 12 } });
    const destination = store({});
    expect(await importLegacyConfiguration(source, destination, levels)).toEqual({ imported: 0, skipped: 0, failed: 2 });
    expect(destination.update).not.toHaveBeenCalled();
  });

  it('retains independent successes and retries failed writes without replacing new values', async () => {
    const source = store({ apiUrl: { globalValue: 'https://host.example' }, opencodeBinary: { globalValue: '/bin/opencode' } });
    const destination = store({});
    destination.update.mockRejectedValueOnce(new Error('disk failure'));
    expect(await importLegacyConfiguration(source, destination, levels)).toEqual({ imported: 1, skipped: 0, failed: 1 });
    expect(await importLegacyConfiguration(source, destination, levels)).toEqual({ imported: 1, skipped: 1, failed: 0 });
    expect(source.update).not.toHaveBeenCalled();
  });
});
