import { describe, expect, test, beforeEach } from 'vitest';

import {
  applyLynxDeepLinkIntent,
  applyLynxDeepLinkUrl,
  peekLynxPendingDeepLink,
  registerLynxDeepLinkHandlers,
  resetLynxDeepLinkApplyState,
  setLynxDeepLinkConnectReady,
  type LynxDeepLinkNavCommand,
} from './apply';
import { parseDeepLink } from './intents';

describe('applyLynxDeepLink', () => {
  beforeEach(() => {
    resetLynxDeepLinkApplyState();
  });

  test('stashes until connect ready + handlers registered', () => {
    const commands: LynxDeepLinkNavCommand[] = [];
    applyLynxDeepLinkUrl('openchamber://session/ses_1?directory=/tmp/demo');
    expect(peekLynxPendingDeepLink()?.type).toBe('session');

    registerLynxDeepLinkHandlers({
      applyNav: (command) => {
        commands.push(command);
        return true;
      },
    });
    expect(commands).toHaveLength(0);

    setLynxDeepLinkConnectReady(true);
    expect(commands).toEqual([
      { type: 'openChat', sessionId: 'ses_1', directory: '/tmp/demo' },
    ]);
    expect(peekLynxPendingDeepLink()).toBeNull();
  });

  test('maps settings / changes / view sheets', () => {
    const commands: LynxDeepLinkNavCommand[] = [];
    setLynxDeepLinkConnectReady(true);
    registerLynxDeepLinkHandlers({
      applyNav: (command) => {
        commands.push(command);
        return true;
      },
    });

    applyLynxDeepLinkIntent(parseDeepLink('openchamber://settings/instances')!);
    applyLynxDeepLinkIntent(parseDeepLink('openchamber://changes/src/a.ts?staged=true')!);
    applyLynxDeepLinkIntent(parseDeepLink('openchamber://view/files')!);
    applyLynxDeepLinkIntent(parseDeepLink('openchamber://view/mcp')!);
    applyLynxDeepLinkIntent(parseDeepLink('openchamber://new-session?directory=/repo&prompt=hi')!);

    expect(commands).toEqual([
      { type: 'openSettings', section: 'instances' },
      { type: 'openSheet', sheet: 'changes', path: 'src/a.ts', staged: true },
      { type: 'openSheet', sheet: 'files' },
      { type: 'openSheet', sheet: 'mcp' },
      { type: 'openDraft', directory: '/repo', prompt: 'hi' },
    ]);
  });

  test('re-stashes when handler returns false', () => {
    setLynxDeepLinkConnectReady(true);
    registerLynxDeepLinkHandlers({
      applyNav: () => false,
    });
    applyLynxDeepLinkUrl('openchamber://view/files');
    expect(peekLynxPendingDeepLink()?.type).toBe('view');
  });
});
