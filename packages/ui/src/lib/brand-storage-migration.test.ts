import { describe, expect, it } from 'vitest';
import { migrateBrandLocalStorage, migratedStorageKey } from './brand-storage-migration';

const storageFor = (entries: Record<string, string>): Storage => {
  const values = new Map(Object.entries(entries));
  return {
    get length() { return values.size; },
    key: (index) => Array.from(values.keys())[index] ?? null,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value); },
    removeItem: (key) => { values.delete(key); },
    clear: () => values.clear(),
  };
};

describe('same-origin brand storage migration', () => {
  it('copies drafts and scoped settings byte-for-byte without rewriting user content', () => {
    const draft = JSON.stringify({ text: 'OpenChamber notes', attachment: 'file:///repo/openchamber.png' });
    const storage = storageFor({ openchamber_input_draft_metadata_v1: draft, 'oc.rt.aG9zdA.openchamber-brand': 'custom' });
    expect(migrateBrandLocalStorage(storage)).toEqual({ copied: 2, preserved: 0, failed: [] });
    expect(storage.getItem('yuri_input_draft_metadata_v1')).toBe(draft);
    expect(storage.getItem('openchamber_input_draft_metadata_v1')).toBe(draft);
    expect(storage.getItem('yuri.rt.aG9zdA.yuri-brand')).toBe('custom');
  });

  it('preserves authoritative Yuri data and does not resurrect intentional deletions', () => {
    const storage = storageFor({ 'openchamber-settings': 'old', 'yuri-settings': 'new' });
    expect(migrateBrandLocalStorage(storage).preserved).toBe(1);
    expect(storage.getItem('yuri-settings')).toBe('new');
    storage.removeItem('yuri-settings');
    expect(migrateBrandLocalStorage(storage).copied).toBe(0);
    expect(storage.getItem('yuri-settings')).toBeNull();
    expect(storage.getItem('openchamber-settings')).toBe('old');
  });

  it('retains old data and retries quota failures without blocking unrelated keys', () => {
    const storage = storageFor({ 'openchamber-draft': '{malformed but recoverable', 'oc.sessions.order': '[1]' });
    const set = storage.setItem;
    storage.setItem = (key, value) => { if (key === 'yuri-draft') throw new DOMException('quota', 'QuotaExceededError'); set(key, value); };
    expect(migrateBrandLocalStorage(storage)).toEqual({ copied: 1, preserved: 0, failed: ['yuri-draft'] });
    expect(storage.getItem('openchamber-draft')).toBe('{malformed but recoverable');
    storage.setItem = set;
    expect(migrateBrandLocalStorage(storage).failed).toEqual([]);
    expect(storage.getItem('yuri-draft')).toBe('{malformed but recoverable');
  });

  it('retries marker failure while preserving already committed data', () => {
    const storage = storageFor({ 'openchamber-brand': 'custom' });
    const set = storage.setItem;
    storage.setItem = (key, value) => { if (key.startsWith('yuri.migration.')) throw new Error('disk'); set(key, value); };
    expect(migrateBrandLocalStorage(storage).failed).toEqual(['yuri-brand']);
    storage.setItem = set;
    storage.setItem('yuri-brand', 'newer');
    expect(migrateBrandLocalStorage(storage).preserved).toBe(1);
    expect(storage.getItem('yuri-brand')).toBe('newer');
  });

  it('leaves third-party namespaces and encoded identities alone', () => {
    expect(migratedStorageKey('opencode.token')).toBe('opencode.token');
    expect(migratedStorageKey('other.openchamber')).toBe('other.openchamber');
    expect(migratedStorageKey('oc.inst.openchamber.projects')).toBe('yuri.inst.openchamber.projects');
    const storage = storageFor({});
    expect(migrateBrandLocalStorage(storage)).toEqual({ copied: 0, preserved: 0, failed: [] });
    expect(storage.length).toBe(0);
  });
});
