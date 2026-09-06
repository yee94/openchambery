import { describe, expect, it } from 'vitest';

import {
  buildChatDetailHeaderLabels,
  extractChatDetailSessionMetaFromEvent,
  mergeChatDetailSessionMeta,
  resolveChatDetailSubtitle,
  resolveChatDetailTitle,
  resolveExpoChatSyncHintKind,
} from '@/lib/chatDetailTitle';

describe('resolveChatDetailTitle', () => {
  it('uses draft label when drafting without preferred title', () => {
    expect(
      resolveChatDetailTitle({
        isDraft: true,
        draftLabel: '新会话',
        untitledLabel: '未命名会话',
      }),
    ).toBe('新会话');
  });

  it('prefers preferredTitle on draft', () => {
    expect(
      resolveChatDetailTitle({
        isDraft: true,
        preferredTitle: '  Assist me  ',
        draftLabel: '新会话',
        untitledLabel: '未命名会话',
      }),
    ).toBe('Assist me');
  });

  it('uses live session title for real sessions', () => {
    expect(
      resolveChatDetailTitle({
        isDraft: false,
        sessionTitle: ' Fix mobile search ',
        draftLabel: '新会话',
        untitledLabel: '未命名会话',
      }),
    ).toBe('Fix mobile search');
  });

  it('falls back to assistant display name then untitled', () => {
    expect(
      resolveChatDetailTitle({
        isDraft: false,
        assistantName: '🧭 Navigator',
        draftLabel: '新会话',
        untitledLabel: '未命名会话',
      }),
    ).toBe('Navigator');
    expect(
      resolveChatDetailTitle({
        isDraft: false,
        draftLabel: '新会话',
        untitledLabel: '未命名会话',
      }),
    ).toBe('未命名会话');
  });

  it('preferredTitle beats session and assistant', () => {
    expect(
      resolveChatDetailTitle({
        isDraft: false,
        preferredTitle: 'Override',
        sessionTitle: 'Session',
        assistantName: 'Assistant',
        draftLabel: '新会话',
        untitledLabel: '未命名会话',
      }),
    ).toBe('Override');
  });
});

describe('resolveChatDetailSubtitle', () => {
  it('prefers sync hint over project · branch', () => {
    expect(
      resolveChatDetailSubtitle({
        syncHint: '正在同步消息...',
        directory: '/code/openchamber',
        branch: 'feat/home',
      }),
    ).toBe('正在同步消息...');
  });

  it('formats 项目 · 分支 from directory + branch', () => {
    expect(
      resolveChatDetailSubtitle({
        directory: '/code/openchamber',
        branch: 'feat/home',
      }),
    ).toBe('openchamber · feat/home');
    expect(
      resolveChatDetailSubtitle({
        directory: '/code/openchamber',
        branch: null,
      }),
    ).toBe('openchamber');
  });

  it('returns null when there is no project or sync hint', () => {
    expect(resolveChatDetailSubtitle({})).toBeNull();
    expect(resolveChatDetailSubtitle({ directory: '  ' })).toBeNull();
  });
});

describe('resolveExpoChatSyncHintKind', () => {
  it('shows syncing only for cold loading without transcript', () => {
    expect(
      resolveExpoChatSyncHintKind({
        sessionId: 'ses_1',
        hasTranscript: false,
        loadStatus: 'loading',
      }),
    ).toBe('syncing');
    expect(
      resolveExpoChatSyncHintKind({
        sessionId: 'ses_1',
        hasTranscript: true,
        loadStatus: 'loading',
      }),
    ).toBeNull();
    expect(
      resolveExpoChatSyncHintKind({
        sessionId: '',
        hasTranscript: false,
        loadStatus: 'loading',
      }),
    ).toBeNull();
  });
});

describe('buildChatDetailHeaderLabels', () => {
  it('composes Cap-compatible header labels', () => {
    expect(
      buildChatDetailHeaderLabels(
        {
          isDraft: false,
          sessionTitle: 'Pinned work',
          draftLabel: '新会话',
          untitledLabel: '未命名会话',
        },
        {
          directory: '/code/openchamber',
          branch: 'feat/home',
        },
      ),
    ).toEqual({
      title: 'Pinned work',
      subtitle: 'openchamber · feat/home',
    });
  });
});

describe('extractChatDetailSessionMetaFromEvent', () => {
  it('reads title/directory/branch from session.updated info', () => {
    expect(
      extractChatDetailSessionMetaFromEvent({
        type: 'session.updated',
        properties: {
          info: {
            id: 'ses_1',
            title: ' Renamed chat ',
            directory: '/code/openchamber',
            project: { branch: 'feat/home' },
            time: { created: 1, updated: 42 },
          },
        },
      }),
    ).toEqual({
      id: 'ses_1',
      title: ' Renamed chat ',
      assistantName: undefined,
      directory: '/code/openchamber',
      branch: 'feat/home',
      updatedAt: 42,
    });
  });

  it('ignores unrelated events and missing info.id', () => {
    expect(
      extractChatDetailSessionMetaFromEvent({
        type: 'session.status',
        properties: { sessionID: 'ses_1' },
      }),
    ).toBeNull();
    expect(
      extractChatDetailSessionMetaFromEvent({
        type: 'session.updated',
        properties: { info: { title: 'x' } },
      }),
    ).toBeNull();
  });
});

describe('mergeChatDetailSessionMeta', () => {
  it('applies rename and skips stale echoes', () => {
    const live = mergeChatDetailSessionMeta(
      { title: 'Old', directory: '/a', updatedAt: 10 },
      { title: 'New', updatedAt: 20 },
    );
    expect(live).toEqual({ title: 'New', directory: '/a', updatedAt: 20 });
    expect(
      mergeChatDetailSessionMeta(live, { title: 'Stale', updatedAt: 15 }),
    ).toEqual(live);
  });

  it('fills from null prev on first live event', () => {
    expect(
      mergeChatDetailSessionMeta(null, {
        title: 'Fresh',
        directory: '/code/openchamber',
        branch: 'main',
        updatedAt: 5,
      }),
    ).toEqual({
      title: 'Fresh',
      directory: '/code/openchamber',
      branch: 'main',
      updatedAt: 5,
    });
  });
});
