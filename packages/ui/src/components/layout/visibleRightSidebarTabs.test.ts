import { describe, expect, it } from 'vitest';

import { visibleRightSidebarTabs } from './visibleRightSidebarTabs';

describe('visibleRightSidebarTabs', () => {
  it('hides the browser tab unless a provider is selected', () => {
    expect(visibleRightSidebarTabs({ hideGit: false, showBrowser: false })).toEqual(['git', 'files']);
    expect(visibleRightSidebarTabs({ hideGit: true, showBrowser: true })).toEqual(['files', 'browser']);
  });
});
