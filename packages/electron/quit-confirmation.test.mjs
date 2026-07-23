import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveQuitInterception } from './quit-confirmation.mjs';

test('prompts for the first macOS quit request', () => {
  assert.equal(resolveQuitInterception({
    platform: 'darwin',
    quitConfirmed: false,
    quitConfirmationPending: false,
  }), 'prompt');
});

test('confirms a repeated macOS quit request while the prompt is open', () => {
  assert.equal(resolveQuitInterception({
    platform: 'darwin',
    quitConfirmed: false,
    quitConfirmationPending: true,
  }), 'confirm');
});

test('continues an already confirmed quit request', () => {
  assert.equal(resolveQuitInterception({
    platform: 'darwin',
    quitConfirmed: true,
    quitConfirmationPending: false,
  }), 'continue');
});

test('continues quit requests on other platforms', () => {
  assert.equal(resolveQuitInterception({
    platform: 'win32',
    quitConfirmed: false,
    quitConfirmationPending: false,
  }), 'continue');
});
