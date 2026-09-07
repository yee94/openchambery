import { describe, expect, test } from 'vitest';

import { assignLynxShareDraftRecipient, isAssignedLynxShareDraft, type LynxShareCatalogEntry } from './shareDraft';
import { assignedLynxShareDraftToEnvelope, createLynxShareInbox } from './shareInbox';

const catalogEntry = (): LynxShareCatalogEntry => ({
  serverInstanceID: 'srv',
  assistantID: 'asst-1',
  name: 'Alpha',
  avatarSeed: 'asst-1',
  serverLabel: 'Home',
  connectionKey: 'conn-1',
  enabled: true,
  isDefaultShareTarget: false,
});

describe('createLynxShareInbox', () => {
  test('accepts host share envelope and dispatches Cap assistants share', async () => {
    const inbox = createLynxShareInbox();
    const envelope = inbox.acceptOpenChamberShareIntent({
      operationID: 'op-1',
      serverInstanceID: 'srv',
      assistantID: 'asst-1',
      text: 'hello from share',
    });
    expect(inbox.listPending()).toHaveLength(1);
    const calls: Array<{ path: string; body?: string }> = [];
    const runtimeFetch = async (path: string, init?: { body?: string }) => {
      calls.push({ path, body: init?.body });
      return { ok: true, status: 200, json: async () => ({ operationID: 'op-1', state: 'completed' }) };
    };
    const result = await inbox.dispatchToAssistant(runtimeFetch, envelope);
    expect(result).toEqual({ status: 'ok', operationID: 'op-1' });
    expect(calls[0]?.path).toBe('/api/openchamber/assistants/asst-1/share');
    const body = JSON.parse(calls[0]!.body!);
    expect(body.operationID).toBe('op-1');
    expect(body.payload.parts).toEqual([{ type: 'text', text: 'hello from share' }]);
    expect(inbox.listPending()).toHaveLength(0);
  });

  test('empty / expired / no-runtime are not fake-success', async () => {
    const inbox = createLynxShareInbox();
    const empty = inbox.acceptOpenChamberShareIntent({
      operationID: 'op-empty',
      serverInstanceID: 'srv',
      assistantID: 'asst',
    });
    expect(await inbox.dispatchToAssistant(async () => ({ ok: true, status: 200, json: async () => ({}) }), empty)).toEqual({
      status: 'empty',
    });
    const expired = inbox.acceptOpenChamberShareIntent({
      operationID: 'op-exp',
      serverInstanceID: 'srv',
      assistantID: 'asst',
      text: 'x',
      expiresAt: Date.now() - 1000,
    });
    expect(await inbox.dispatchToAssistant(async () => ({ ok: true, status: 200, json: async () => ({}) }), expired)).toEqual({
      status: 'expired',
    });
    expect(await inbox.dispatchToAssistant(null, expired)).toEqual({ status: 'no-runtime' });
  });

  test('unassigned android draft stays pending until recipient assign + dispatch', async () => {
    const inbox = createLynxShareInbox();
    inbox.acceptDraft({
      version: 1,
      draftID: 'draft-1',
      text: 'from android share',
      attachments: [],
      source: 'android-share',
      createdAt: Date.now(),
      expiresAt: Date.now() + 60_000,
    });
    expect(inbox.listUnassignedDrafts()).toHaveLength(1);
    expect(isAssignedLynxShareDraft(inbox.listDrafts()[0]!)).toBe(false);

    const assigned = assignLynxShareDraftRecipient(inbox.listDrafts()[0]!, catalogEntry());
    expect(assignedLynxShareDraftToEnvelope(assigned).assistantID).toBe('asst-1');

    const calls: string[] = [];
    const runtimeFetch = async (path: string) => {
      calls.push(path);
      return { ok: true, status: 200, json: async () => ({}) };
    };
    const result = await inbox.dispatchAssignedDraft(runtimeFetch, assigned);
    expect(result).toEqual({ status: 'ok', operationID: 'draft-1' });
    expect(calls[0]).toBe('/api/openchamber/assistants/asst-1/share');
    expect(inbox.listDrafts()).toHaveLength(0);
  });

  test('cancelDraft drops without inventing dispatch success', () => {
    const inbox = createLynxShareInbox();
    inbox.acceptDraft({
      version: 1,
      draftID: 'draft-cancel',
      attachments: [],
      source: 'android-share',
      createdAt: 1,
      expiresAt: 9_999_999_999_999,
    });
    inbox.cancelDraft('draft-cancel');
    expect(inbox.listDrafts()).toHaveLength(0);
    expect(inbox.listPending()).toHaveLength(0);
  });

  test('failed assigned-draft dispatch does not delete the draft', async () => {
    const inbox = createLynxShareInbox();
    inbox.acceptDraft({
      version: 1,
      draftID: 'draft-fail',
      text: 'x',
      attachments: [],
      source: 'android-share',
      createdAt: 1,
      expiresAt: 9_999_999_999_999,
    });
    const assigned = assignLynxShareDraftRecipient(inbox.listDrafts()[0]!, catalogEntry());
    const result = await inbox.dispatchAssignedDraft(
      async () => ({ ok: false, status: 500, json: async () => ({ error: 'boom' }) }),
      assigned,
    );
    expect(result.status).toBe('failed');
    expect(inbox.listDrafts()).toHaveLength(1);
  });
});
