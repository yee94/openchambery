import { describe, expect, test } from 'vitest';

import { runLynxNavigationScenario } from './navigationScenario';

describe('Lynx navigation harness', () => {
  test('projects → chat hides dock, back restores it (Mode A Android)', () => {
    const results = runLynxNavigationScenario({ platform: 'android' }, [
      { action: { type: 'setActiveTab', tab: 'projects' }, expectDockHidden: false },
      { action: { type: 'openChat', sessionId: 'ses_1' }, expectDockHidden: true },
      { action: { type: 'closeSecondary' }, expectDockHidden: false },
    ]);
    expect(results[0]?.lynxDockPainted).toBe(true);
    expect(results[1]?.lynxDockPainted).toBe(false);
    expect(results[1]?.hostTabChromeVisible).toBe(false);
    expect(results[2]?.lynxDockPainted).toBe(true);
  });

  test('Mode B iOS 26 hides the system tab bar on chat push', () => {
    const results = runLynxNavigationScenario(
      { platform: 'ios', iosMajorVersion: 26 },
      [
        { action: { type: 'setActiveTab', tab: 'assistant' }, expectDockHidden: false },
        { action: { type: 'openAssistant', assistantId: 'asst_1' }, expectDockHidden: true },
      ],
    );
    expect(results[0]?.lynxDockPainted).toBe(false);
    expect(results[0]?.hostTabChromeVisible).toBe(true);
    expect(results[1]?.hostTabChromeVisible).toBe(false);
  });
});
