import { expect, test } from 'bun:test';
import { parseDraftRecord } from '@/sync/input-draft-types';
import { createAssistantRevertDraftSnapshot } from './assistantRevertDraft';

test('builds a persistable Assistant revert draft with data URL attachments', async () => {
  const result = await createAssistantRevertDraftSnapshot({ text: 'restore', attachments: [{ url: 'data:text/plain;base64,eA==', mimeType: 'text/plain', filename: 'a.txt' }] }, () => 'attachment-a');
  expect(parseDraftRecord({ version: 1, key: { transportIdentity: 'runtime', owner: { kind: 'surface', ownerID: 'assistant:a' } }, revision: 1, ...result.snapshot })).toBeTruthy();
  expect(result.snapshot.attachments[0]?.locator.kind).toBe('blob');
  expect(result.values.get('["root","attachment-a"]')).toBeInstanceOf(Blob);
});
