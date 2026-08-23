import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import React from 'react';
import { describe, expect, test } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

import MessageHeader from './MessageHeader';

const mobileCss = readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), '../../../styles/mobile.css'),
  'utf8',
);

const renderHeader = (isMobile: boolean) =>
  renderToStaticMarkup(
    <MessageHeader
      isUser={false}
      isMobile={isMobile}
      providerID="zai"
      modelID="glm-5.3"
      agentName="orchestrator"
      modelName="GLM-5.3"
      variant="high"
    />,
  );

describe('MessageHeader', () => {
  test('shows non-default thinking intensity on desktop', () => {
    expect(renderHeader(false)).toContain('High');
  });

  test('hides thinking intensity on mobile', () => {
    expect(renderHeader(true)).not.toContain('High');
  });

  test('mobile model name keeps typography-ui-header so it rides --text-ui-header', () => {
    const html = renderHeader(true);
    expect(html).toContain('GLM-5.3');
    expect(html).toContain('typography-ui-header');
  });

  test('mobile typography unset compat block does not strip ui-header', () => {
    const unsetBlock = mobileCss.match(
      /:root\.mobile-pointer:not\(\.desktop-runtime\) \.typography-markdown,[\s\S]*?font-size:\s*unset\s*!important;/,
    )?.[0];
    expect(unsetBlock).toBeTruthy();
    expect(unsetBlock).not.toMatch(
      /:root\.mobile-pointer:not\(\.desktop-runtime\) \.typography-ui-header,/,
    );
    expect(unsetBlock).toContain('.typography-ui-label');
  });
});
