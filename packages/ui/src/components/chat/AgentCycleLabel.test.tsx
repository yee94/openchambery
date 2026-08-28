import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { AgentCycleLabel } from './AgentCycleLabel';

describe('AgentCycleLabel', () => {
  test('vertically centers the revealed name against the avatar slot', () => {
    const markup = renderToStaticMarkup(
      <AgentCycleLabel
        name="build"
        label="Build"
        revealed
        avatarSize={16}
        slotClassName="h-[26px] w-6"
      />,
    );

    expect(markup).toContain('grid min-w-0 items-center');
    expect(markup).toContain('flex min-w-0 items-center overflow-hidden');
    expect(markup).toContain('leading-none');
    expect(markup).toContain('>Build</span>');
  });
});
