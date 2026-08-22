import React from 'react';
import { describe, expect, test } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

import MessageHeader from './MessageHeader';

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
});
