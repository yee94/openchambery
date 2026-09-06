import { describe, expect, it } from 'vitest';

import {
  applyPermissionEvent,
  parsePermissionList,
  parsePermissionRequest,
} from '@/lib/permissionApi';

describe('parsePermissionRequest / list', () => {
  it('parses Cap PermissionRequest shape', () => {
    const parsed = parsePermissionRequest({
      id: 'p1',
      sessionID: 'ses_1',
      permission: 'bash',
      patterns: [],
      metadata: {},
      always: [],
      tool: { messageID: "m1", callID: "c1" },
    });
    expect(parsed).toMatchObject({
      id: 'p1',
      sessionID: 'ses_1',
      permission: "bash",
      tool: { messageID: 'm1', callID: 'c1' },
    });
    expect(parsePermissionList([parsed, { id: 'bad' }])).toHaveLength(1);
  });
});

describe('applyPermissionEvent', () => {
  const base = {
    id: 'p1',
    sessionID: 'ses_1',
    permission: "edit",
    patterns: [],
    metadata: {},
    always: [],
  };

  it('upserts permission.asked and removes replied/rejected', () => {
    let pending = applyPermissionEvent([], { type: 'permission.asked', properties: base }, 'ses_1');
    expect(pending).toHaveLength(1);
    pending = applyPermissionEvent(
      pending,
      {
        type: 'permission.asked',
        properties: { ...base, permission: "write" },
      },
      'ses_1',
    );
    expect(pending[0]?.permission).toBe("write");
    pending = applyPermissionEvent(
      pending,
      { type: 'permission.replied', properties: { sessionID: 'ses_1', requestID: 'p1' } },
      'ses_1',
    );
    expect(pending).toHaveLength(0);
  });

  it('ignores other sessions', () => {
    const pending = applyPermissionEvent([], { type: 'permission.asked', properties: base }, 'ses_other');
    expect(pending).toHaveLength(0);
  });
});
