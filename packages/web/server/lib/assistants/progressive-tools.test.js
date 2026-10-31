import { describe, expect, it, vi } from 'vitest';
import { createProgressiveTools } from './progressive-tools.js';

const tool = (name) => ({ name, description: `${name} operation`, parameters: { type: 'object', properties: {} }, execute: vi.fn() });

describe('shared progressive tool disclosure', () => {
  it('keeps base tools visible and only exposes granted group members without calling their executors', async () => {
    const base = tool('read');
    const granted = tool('search');
    const forbidden = tool('delete');
    const tools = [base, granted];
    const progressive = createProgressiveTools({ tools, groups: [
      { id: 'external.web', description: 'Search online.', tools: [granted, forbidden] },
      { id: 'unavailable', description: 'Not granted.', tools: [forbidden] },
    ] });
    const initial = progressive.getTools();
    expect(initial.map((item) => item.name)).toEqual(['read', 'load_tools']);
    const loader = initial[1];
    expect(loader.parameters.properties.domain.enum).toEqual(['external.web']);
    expect(JSON.stringify(loader)).not.toContain('search operation');
    const result = await loader.execute('load', { domain: 'external.web' });
    expect(result.addedToolNames).toEqual(['search']);
    expect(progressive.getTools()).toEqual([base, loader, granted]);
    for (const item of [base, granted, forbidden]) expect(item.execute).not.toHaveBeenCalled();
    expect(tools).toEqual([base, granted]);
    initial.length = 0;
    expect(progressive.getTools()).toHaveLength(3);
  });

  it('isolates concurrently alive turn states and deduplicates repeat or overlapping group loads', async () => {
    const shared = tool('shared');
    const extra = tool('extra');
    const options = { tools: [shared, extra], groups: [
      { id: 'first', description: 'First.', tools: [shared] },
      { id: 'second', description: 'Second.', tools: [shared, extra] },
    ] };
    const first = createProgressiveTools(options);
    const otherTurn = createProgressiveTools(options);
    const loader = first.getTools()[0];
    const results = await Promise.all([
      loader.execute('one', { domain: 'first' }), loader.execute('two', { domain: 'second' }),
      loader.execute('again', { domain: 'first' }),
    ]);
    expect(results.map((item) => item.addedToolNames)).toEqual([['shared'], ['extra'], []]);
    expect(results[2].details.alreadyLoaded).toBe(true);
    expect(first.getTools().map((item) => item.name)).toEqual(['load_tools', 'shared', 'extra']);
    expect(otherTurn.getTools().map((item) => item.name)).toEqual(['load_tools']);
  });

  it('does not add an entrypoint without an available deferred group', () => {
    const base = tool('read');
    expect(createProgressiveTools({ tools: [base], groups: [] }).getTools()).toEqual([base]);
  });

  it('does not activate any group after cancellation or an invalid load', async () => {
    const member = tool('operation');
    const progressive = createProgressiveTools({ tools: [member], groups: [{ id: 'group', description: 'Example.', tools: [member] }] });
    const loader = progressive.getTools()[0];
    for (const params of [null, [], {}, { domain: 'unknown' }, { domain: 'group', extra: true }]) {
      expect((await loader.execute('bad', params)).isError).toBe(true);
    }
    const controller = new AbortController(); controller.abort(new Error('cancelled'));
    await expect(loader.execute('cancelled', { domain: 'group' }, controller.signal)).rejects.toThrow('cancelled');
    expect(progressive.getTools()).toEqual([loader]);
  });
});
