import React from 'react';
import type { Part } from '@opencode-ai/sdk/v2';

const DraftHandoffMessageBodyFixture = ({
  messageId,
  parts = [],
}: {
  messageId?: string;
  parts?: Part[];
}) => {
  const [ready, setReady] = React.useState(false);
  React.useEffect(() => {
    const timer = window.setTimeout(() => setReady(true), 140);
    return () => window.clearTimeout(timer);
  }, []);

  return (
    <div data-markdown-ready={ready ? 'true' : 'false'} data-handoff-body={messageId}>
      <div data-markdown-content>
        {parts
          .filter((part): part is Part & { text: string } => part.type === 'text' && typeof part.text === 'string')
          .map((part) => part.text)
          .join('')}
      </div>
    </div>
  );
};

export default DraftHandoffMessageBodyFixture;
