import React from 'react';
import type { Part } from '@opencode-ai/sdk/v2';

const ChromeMessageBodyFixture = ({
  messageId,
  parts = [],
}: {
  messageId?: string;
  parts?: Part[];
}) => (
  <div data-chrome-message-body={messageId} data-markdown-ready="true">
    {parts
      .filter((part): part is Part & { text: string } => part.type === 'text' && typeof part.text === 'string')
      .map((part) => part.text)
      .join('')}
  </div>
);

export default ChromeMessageBodyFixture;
