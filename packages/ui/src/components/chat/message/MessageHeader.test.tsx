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

  test('mobile typography utilities are not stripped back to inherited 16px', () => {
    expect(mobileCss).not.toMatch(
      /:root\.mobile-pointer:not\(\.desktop-runtime\) \.typography-(markdown|code|ui-header|ui-label|meta|micro)[\s\S]{0,240}font-size:\s*unset/,
    );
  });
});
