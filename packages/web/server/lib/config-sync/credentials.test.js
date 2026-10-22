import { describe, expect, it } from 'vitest';
import { OpenCode } from '@opencode/client';
import { createCredentialSync } from './credentials.js';

const key = (id, integrationID = 'openai', active = true) => ({
  id, integrationID, label: id, active, value: { type: 'key', key: `fixture-${id}` },
});

// Exercise the installed SDK's real HTTP serialization, not a second SDK shape.
function service(initial = []) {
  let entries = structuredClone(initial);
  let failCreate = false;
  let failList = false;
  const client = OpenCode.make({ baseUrl: 'http://credentials.invalid', fetch: async (input, init) => {
    const req = new Request(input, init);
    const pathname = new URL(req.url).pathname;
    const parts = pathname.split('/');
    const id = parts[3];
    if (req.method === 'GET') {
      if (failList) return new Response('fixture-private-upstream-error', { status: 500 });
      return Response.json({ data: entries });
    }
    if (req.method === 'DELETE') {
      entries = entries.filter((entry) => entry.id !== id);
      return new Response(null, { status: 204 });
    }
    if (pathname.endsWith('/activate')) {
      const selected = entries.find((entry) => entry.id === id);
      for (const entry of entries) if (entry.integrationID === selected.integrationID) entry.active = entry.id === id;
      return new Response(null, { status: 204 });
    }
    const body = await req.json();
    expect(body.integrationID).toBeTypeOf('string');
    expect(body.value).toBeTruthy();
    if (failCreate) {
      failCreate = false;
      return new Response('fixture-private-upstream-error', { status: 400 });
    }
    if (entries.some((entry) => entry.id === body.id)) return new Response(null, { status: 409 });
    const { activate, ...value } = body;
    const entry = { ...value, active: activate || !entries.some((item) => item.integrationID === body.integrationID && item.active) };
    entries.push(entry);
    return Response.json({ data: entry });
  } });
  return {
    sync: createCredentialSync(() => client),
    entries: () => structuredClone(entries),
    failNextCreate: () => { failCreate = true; },
    failReads: () => { failList = true; },
  };
}

describe('provider credential sync', () => {
  it('round-trips keys, OAuth accounts, metadata and active selection without deleting destination accounts', async () => {
    const oauth = { ...key('oauth'), value: {
      type: 'oauth', methodID: 'oauth', access: 'fixture-access', refresh: 'fixture-refresh', expires: 1000,
      metadata: { accountID: 'fixture-account' },
    } };
    const source = service([key('key', 'openai', false), oauth]);
    const other = key('other', 'anthropic');
    const destination = service([other]);
    const payload = await source.sync.download();
    expect(await source.sync.inventory()).toEqual({ bytes: payload.byteLength });
    expect(JSON.stringify(await source.sync.inventory())).not.toContain('fixture-');
    await destination.sync.import(payload);
    expect(destination.entries()).toEqual([other, key('key', 'openai', false), oauth]);
    await destination.sync.import(payload);
    expect(destination.entries()).toHaveLength(3);
  });

  it('updates matching IDs and rolls back failed replacement without leaking upstream errors', async () => {
    const original = key('same');
    const updated = { ...original, value: { type: 'key', key: 'fixture-updated' } };
    const source = service([updated]);
    const target = service([original, key('other', 'anthropic')]);
    target.failNextCreate();
    await expect(target.sync.import(await source.sync.download())).rejects.toThrow('previous credentials restored');
    expect(target.entries()).toContainEqual(original);
    expect(target.entries()).toContainEqual(key('other', 'anthropic'));
    await target.sync.import(await source.sync.download());
    expect(target.entries()).toContainEqual(updated);
  });

  it('rejects legacy archives and malformed input before changing destination state', async () => {
    const target = service([key('existing')]);
    for (const payload of ['legacy tar', '{"openai":{"key":"fixture"}}', JSON.stringify({ format: 'opencode-credentials-v1', entries: [{}] })]) {
      await expect(target.sync.import(Buffer.from(payload))).rejects.toThrow('Invalid provider credentials');
      expect(target.entries()).toEqual([key('existing')]);
    }
  });

  it('does not turn unavailable credentials into empty inventory', async () => {
    const source = service();
    expect(await source.sync.inventory()).toBeNull();
    source.failReads();
    await expect(source.sync.inventory()).rejects.toThrow('Unable to read provider credentials');
  });
});
