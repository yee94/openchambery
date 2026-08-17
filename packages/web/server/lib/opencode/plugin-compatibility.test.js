import { describe, expect, it } from 'vitest';
import {
  PLUGIN_COMPATIBILITY_V1_INCOMPATIBLE,
  pluginCompatibilityForV2,
  withV1PluginIncompatibility,
} from './plugin-compatibility.js';

describe('V1 plugin compatibility (ticket 12)', () => {
  it('marks V1 plugins incompatible instead of a silent load failure', () => {
    expect(pluginCompatibilityForV2()).toEqual({
      compatibility: PLUGIN_COMPATIBILITY_V1_INCOMPATIBLE,
      compatible: false,
    });
    expect(withV1PluginIncompatibility({ id: 'config:user:oh-my-opencode', spec: 'oh-my-opencode' })).toEqual({
      id: 'config:user:oh-my-opencode',
      spec: 'oh-my-opencode',
      compatibility: 'v1-incompatible',
      compatible: false,
    });
  });
});
