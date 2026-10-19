import { afterEach, expect, test } from 'vitest';
import { createContentSearchService } from './service.js';

const services = [];
afterEach(() => services.splice(0).forEach((service) => service.close()));

test('indexes only admitted text and replaces FTS entries atomically', () => {
  const service = createContentSearchService({ dbPath: ':memory:' });
  services.push(service);
  const session = { id: 's', title: 'Title', directory: '/project', time: { updated: 1 } };
  service.replaceSession('host', session, [
    { info: { id: 'u', role: 'user' }, parts: [{ type: 'text', text: 'visible needle' }, { type: 'text', text: 'synthetic-secret', synthetic: true }, { type: 'reasoning', text: 'reasoning-secret' }, { type: 'tool', text: 'tool-secret' }] },
    { info: { id: 'a', role: 'assistant' }, parts: [{ type: 'text', text: 'streaming-secret' }] },
    { info: { id: 'done', role: 'assistant', time: { completed: 1 } }, parts: [{ type: 'text', text: 'head-needle' + 'x'.repeat(3000) + 'tail-needle' }] },
  ]);
  expect(service.search('host', 'secret')).toEqual([]);
  expect(service.search('host', 'tail-needle')).toHaveLength(1);
  expect(service.stats('host').textBytes).toBe(2048 + 'visible needle'.length);
  expect(() => service.replaceSession('host', session, [{ info: { id: 'bad', role: 'user' }, parts: null }])).toThrow();
  expect(service.search('host', 'visible')).toHaveLength(1);
  service.replaceSession('host', session, [{ info: { id: 'new', role: 'user' }, parts: [{ type: 'text', text: 'replacement' }] }]);
  expect(service.search('host', 'needle')).toEqual([]);
  expect(service.search('host', 'replacement')).toHaveLength(1);
});

test('finds unvisited messages across projects with authoritative titles and isolates runtimes', () => {
  const service = createContentSearchService({ dbPath: ':memory:' });
  services.push(service);
  service.replaceSession('host-a', { id: 's1', title: 'Alpha', directory: '/alpha', time: { updated: 10 } }, [
    { info: { id: 'm1', role: 'user', time: { created: 1 } }, parts: [{ type: 'text', text: '跨项目验收 orchard' }] },
  ]);
  service.replaceSession('host-a', { id: 's2', title: 'Beta', directory: '/beta', time: { updated: 20 } }, [
    { info: { id: 'm2', role: 'assistant', finish: 'stop', time: { created: 2 } }, parts: [{ type: 'text', text: '跨项目验收 garden' }] },
  ]);
  expect(service.search('host-a', '跨项目验收').map((hit) => [hit.sessionID, hit.directory, hit.title])).toEqual([
    ['s2', '/beta', 'Beta'], ['s1', '/alpha', 'Alpha'],
  ]);
  expect(service.search('host-b', '跨项目验收')).toEqual([]);
  expect(service.search('host-a', '跨项')).toHaveLength(2);
  service.removeSession('host-a', 's1');
  expect(service.search('host-a', 'orchard')).toEqual([]);
});
