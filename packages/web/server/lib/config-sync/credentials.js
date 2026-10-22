import { isDeepStrictEqual } from 'node:util';
import { currentClient } from '../opencode/auth.js';

const invalid = () => new Error('Invalid provider credentials sync payload');
const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

function validate(entries) {
  if (!Array.isArray(entries)) throw invalid();
  const ids = new Set();
  const active = new Set();
  for (const entry of entries) {
    if (!record(entry) || typeof entry.id !== 'string' || !entry.id || ids.has(entry.id)
      || typeof entry.integrationID !== 'string' || !entry.integrationID
      || typeof entry.label !== 'string' || typeof entry.active !== 'boolean' || !record(entry.value)) throw invalid();
    ids.add(entry.id);
    if (entry.active && active.has(entry.integrationID)) throw invalid();
    if (entry.active) active.add(entry.integrationID);
    const value = entry.value;
    if (value.type === 'key') {
      if (typeof value.key !== 'string') throw invalid();
    } else if (value.type === 'oauth') {
      if (typeof value.methodID !== 'string' || typeof value.access !== 'string'
        || typeof value.refresh !== 'string' || !Number.isInteger(value.expires) || value.expires < 0) throw invalid();
    } else if (value.type === 'external') {
      if (typeof value.methodID !== 'string') throw invalid();
    } else throw invalid();
    if (value.metadata !== undefined && !record(value.metadata)) throw invalid();
  }
  return entries;
}

// Keep secrets in memory. Preview and run records receive only byte counts.
export function createCredentialSync(resolveClient = currentClient) {
  let importing = false;
  const request = () => ({ signal: AbortSignal.timeout(15000) });
  const read = async (client) => validate(await client.credential.list(request()));
  const encode = (entries) => Buffer.from(JSON.stringify({ format: 'opencode-credentials-v1', entries }));
  return {
    async inventory() {
      try {
        const entries = await read(resolveClient());
        return entries.length ? { bytes: encode(entries).byteLength } : null;
      } catch { throw new Error('Unable to read provider credentials'); }
    },
    async download() {
      try { return encode(await read(resolveClient())); }
      catch { throw new Error('Unable to read provider credentials'); }
    },
    async import(payload) {
      if (importing) throw new Error('Provider credentials sync already in progress');
      importing = true;
      try {
        let entries;
        try {
          const decoded = JSON.parse(Buffer.from(payload).toString('utf8'));
          if (decoded.format !== 'opencode-credentials-v1') throw invalid();
          entries = validate(decoded.entries);
        } catch { throw invalid(); }
        const client = resolveClient();
        let before;
        try { before = await read(client); }
        catch { throw new Error('Unable to read destination provider credentials'); }
        const touched = [];
        const create = (entry) => client.credential.create({
          id: entry.id, integrationID: entry.integrationID, label: entry.label,
          value: entry.value, activate: false,
        }, request());
        try {
          for (const entry of entries) {
            const previous = before.find((item) => item.id === entry.id);
            if (previous && previous.integrationID !== entry.integrationID) throw invalid();
            if (previous && previous.label === entry.label && isDeepStrictEqual(previous.value, entry.value)) continue;
            touched.push({ entry, previous });
            if (previous) await client.credential.remove({ credentialID: entry.id }, request());
            await create(entry);
          }
          for (const entry of entries.filter((item) => item.active)) {
            await client.credential.activate({ credentialID: entry.id }, request());
          }
        } catch {
          let restored = true;
          for (const { entry, previous } of touched.reverse()) {
            try {
              const current = await read(client);
              if (current.some((item) => item.id === entry.id)) await client.credential.remove({ credentialID: entry.id }, request());
              if (previous) await create(previous);
            } catch { restored = false; }
          }
          for (const entry of before.filter((item) => item.active && entries.some((source) => source.integrationID === item.integrationID))) {
            try { await client.credential.activate({ credentialID: entry.id }, request()); }
            catch { restored = false; }
          }
          throw new Error(restored
            ? 'Provider credentials sync failed; previous credentials restored'
            : 'Provider credentials sync failed; rollback incomplete. Retry the sync.');
        }
        return { ok: true };
      } finally { importing = false; }
    },
  };
}
