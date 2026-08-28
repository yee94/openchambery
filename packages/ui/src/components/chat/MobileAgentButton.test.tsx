import type { Agent } from '@opencode-ai/sdk/v2';
import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { MobileAgentButton } from './MobileAgentButton';

const buildAgent = { name: 'build', description: 'Build' } as Agent;

describe('MobileAgentButton', () => {
  test('locks the composer agent chip to the 26px model-row height', () => {
    const markup = renderToStaticMarkup(
      <MobileAgentButton
        onCycleAgent={() => {}}
        onOpenAgentPanel={() => {}}
        agentName="build"
        agents={[buildAgent]}
      />,
    );

    expect(markup).toContain('height:26px');
    expect(markup).toContain('max-height:26px');
    expect(markup).toContain('min-height:26px');
    expect(markup).toContain('h-[26px] w-6');
    expect(markup).toContain('leading-none');
  });
});
