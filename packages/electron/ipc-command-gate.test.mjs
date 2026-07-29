import test from 'node:test';
import assert from 'node:assert/strict';
import { isRemoteIpcCommandAllowed } from './ipc-command-gate.mjs';

test('allows remote Electron pages to use the desktop updater', () => {
  assert.equal(isRemoteIpcCommandAllowed('desktop_check_for_updates'), true);
  assert.equal(isRemoteIpcCommandAllowed('desktop_download_and_install_update'), true);
  assert.equal(isRemoteIpcCommandAllowed('desktop_restart', { applyUpdate: true }), true);
});

test('keeps generic desktop restarts local to the packaged UI', () => {
  assert.equal(isRemoteIpcCommandAllowed('desktop_restart'), false);
  assert.equal(isRemoteIpcCommandAllowed('desktop_restart', { applyUpdate: false }), false);
});
