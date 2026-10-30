import { expect, it } from 'vitest';
import { toHostUpdateDialogModel } from './hostUpdateDialogModel';
import type { HostUpdateSnapshot } from '@/queries/hostUpdateQueries';
import { dict as en } from '@/lib/i18n/messages/en';
const t = (key: keyof typeof en) => en[key];
const snapshot: HostUpdateSnapshot = {
  serverId: 'host', host: 'electron', currentVersion: '2.1.0-beta.2', channel: 'stable', supported: true, reason: null, checkError: null,
  update: { version: '2.0.9', kind: 'installer', releaseNotes: '## Changes\nA fix', planId: 'plan', rollback: true, restartRequired: true }, operation: null,
};
const state = { versionFallback: 'unknown', checking: false as const, submitting: false, failure: null };

it('adapts exact versions, Markdown and rollback warning without a redundant installation method label', () => {
  const model = toHostUpdateDialogModel(snapshot, state, t);
  expect(model).toMatchObject({ currentVersion: '2.1.0-beta.2', version: '2.0.9', body: '## Changes\nA fix', warning: en['settings.yuri.about.hostUpdate.downgrade'] });
  expect(model.methodLabel).toBeUndefined();
  expect(model.actions.find((action) => action.id === 'confirm')?.disabled).toBe(false);
  expect(model.fallbackCommand).toBeUndefined();
  expect(model.releaseLink).toBeUndefined();
});

it('maps Host stages to a monotonic overall progress, keeps the changelog and omits inactive actions', () => {
  const operation = { id: 'operation', planId: 'plan', version: '2.0.9', channel: 'stable' as const, kind: 'installer' as const, status: 'downloading' as const, progress: null, error: null };
  const model = toHostUpdateDialogModel({ ...snapshot, operation }, state, t);
  expect(model.status).toMatchObject({ kind: 'download', progress: 5 });
  expect(model.hideChangelog).not.toBe(true);
  expect(model.body).toBe(snapshot.update?.releaseNotes);
  expect(model.stableLayout).toBe(true);
  expect(model.actions).toEqual([]);
  const halfway = toHostUpdateDialogModel({ ...snapshot, update: null, operation: { ...operation, progress: 100 } }, state, t);
  expect(halfway.status?.progress).toBe(80);
  const reconnecting = toHostUpdateDialogModel({ ...snapshot, update: null, operation: { ...operation, status: 'restarting' } }, { ...state, failure: 'disconnected' }, t);
  expect(reconnecting.status).toMatchObject({ kind: 'activity', progress: 95, label: en['settings.yuri.about.hostUpdate.reconnecting'] });
  expect(reconnecting.status?.detail).toBeUndefined();
  const done = toHostUpdateDialogModel({ ...snapshot, update: null, operation: { ...operation, status: 'succeeded' } }, { ...state, completed: true }, t);
  expect(done.status).toMatchObject({ progress: 100, label: en['settings.yuri.about.hostUpdate.status.succeeded'] });
  expect(done.actions).toEqual([]);
  const submitting = toHostUpdateDialogModel(snapshot, { ...state, submitting: true }, t);
  expect(submitting.actions).toEqual([]);
  expect(submitting.body).toBe(snapshot.update?.releaseNotes);
});

it('retains matching display metadata when busy without turning it into an actionable update plan', () => {
  const operation = { id: 'operation', planId: 'plan', version: '2.0.9', channel: 'stable' as const, kind: 'installer' as const, status: 'installing' as const, progress: null, error: null };
  const busy = { ...snapshot, update: null, operation };
  const model = toHostUpdateDialogModel(busy, { ...state, updateDetails: snapshot.update }, t);
  expect(model.body).toBe(snapshot.update?.releaseNotes);
  expect(model.methodLabel).toBeUndefined();
  expect(model.hideChangelog).not.toBe(true);
  expect(model.actions).toEqual([]);
  for (const change of [{ planId: 'other' }, { version: '2.0.10' }]) {
    const unrelated = toHostUpdateDialogModel({ ...busy, operation: { ...operation, ...change } }, { ...state, updateDetails: snapshot.update }, t);
    expect(unrelated.body).toBe(en['settings.yuri.about.hostUpdate.noNotes']);
  }
});

it('keeps unsupported/error/confirmed-empty states distinct and never enables an old plan after failure', () => {
  const failed = toHostUpdateDialogModel(snapshot, { ...state, failure: 'check' }, t);
  expect(failed.error).toBe(en['settings.yuri.about.toast.checkFailed']);
  expect(failed.actions.find((action) => action.id === 'confirm')?.disabled).toBe(true);
  const unsupported = toHostUpdateDialogModel({ ...snapshot, supported: false, update: null }, state, t);
  expect(unsupported.message).toBe(en['settings.yuri.about.hostUpdate.unsupported']);
  const empty = toHostUpdateDialogModel({ ...snapshot, update: null }, state, t);
  expect(empty.message).toBe(en['settings.yuri.about.toast.latestVersion']);
});
