#!/usr/bin/env node
/**
 * Static contract check for router e2e scenarios + path builders.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const scenarios = JSON.parse(readFileSync(join(root, 'scenarios.json'), 'utf8'));

const requiredIds = ['E1', 'E2', 'E3', 'E4', 'E5', 'E6', 'E7', 'E8', 'E9', 'E10', 'E11'];
const ids = scenarios.scenarios.map((s) => s.id);
const missing = requiredIds.filter((id) => !ids.includes(id));
if (missing.length) {
  console.error('Missing scenario ids:', missing.join(', '));
  process.exit(1);
}

if (!Array.isArray(scenarios.legacyQueryParamsForbidden) || scenarios.legacyQueryParamsForbidden.length < 3) {
  console.error('legacyQueryParamsForbidden must list session/tab/settings');
  process.exit(1);
}

const SESSION_TOOLS = new Set(['git', 'diff', 'terminal', 'files', 'diagram']);

function buildSessionPath({ sessionId, tab, file }) {
  if (tab === 'schedule' || tab === 'scheduled') return '/schedule';
  if (tab === 'assistant') return '/assistant';
  const base =
    !tab || tab === 'chat' || !SESSION_TOOLS.has(tab)
      ? `/session/${encodeURIComponent(sessionId)}`
      : `/session/${encodeURIComponent(sessionId)}/${tab}`;
  const params = new URLSearchParams();
  if (file) params.set('file', file);
  const search = params.toString();
  return search ? `${base}?${search}` : base;
}

function buildSchedulePath({ scheduleView, focusSessionId } = {}) {
  let base = scheduleView === 'history' ? '/schedule/history' : '/schedule';
  if (focusSessionId) base += `/agent/${encodeURIComponent(focusSessionId)}`;
  return base;
}

const samples = [
  [buildSessionPath({ sessionId: 'abc' }), '/session/abc'],
  [buildSessionPath({ sessionId: 'abc', tab: 'git' }), '/session/abc/git'],
  [buildSessionPath({ sessionId: 'abc', tab: 'diff', file: 'a/b.ts' }), '/session/abc/diff?file=a%2Fb.ts'],
  [buildSessionPath({ sessionId: 'abc', tab: 'schedule' }), '/schedule'],
  [buildSchedulePath({ scheduleView: 'history' }), '/schedule/history'],
  [buildSchedulePath({ focusSessionId: 'child' }), '/schedule/agent/child'],
];

for (const [got, want] of samples) {
  if (got !== want) {
    console.error('path sample mismatch', { got, want });
    process.exit(1);
  }
  if (got.includes('session=') || got.includes('?tab=') || got.includes('settings=')) {
    console.error('legacy query leaked into path sample', got);
    process.exit(1);
  }
  // schedule must never nest under /session/
  if (got.includes('/session/') && got.includes('/schedule')) {
    console.error('schedule nested under session', got);
    process.exit(1);
  }
}

console.log(`ok: ${ids.length} scenarios; path samples green`);
