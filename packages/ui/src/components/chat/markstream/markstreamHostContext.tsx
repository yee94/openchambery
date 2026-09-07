import React from 'react';
import type { Part } from '@opencode-ai/sdk/v2';
import type { ToolPopupContent } from '../message/types';

export type MarkstreamMarkdownVariant = 'assistant' | 'reasoning' | 'tool';

export type MarkstreamHostContextValue = {
  messageId: string;
  part?: Part;
  isStreaming: boolean;
  disableStreamAnimation: boolean;
  variant: MarkstreamMarkdownVariant;
  onShowPopup?: (content: ToolPopupContent) => void;
  enableFileReferences: boolean;
};

const DEFAULT_HOST_CONTEXT: MarkstreamHostContextValue = {
  messageId: 'markstream',
  isStreaming: false,
  disableStreamAnimation: false,
  variant: 'assistant',
  enableFileReferences: true,
};

export const MarkstreamHostContext = React.createContext<MarkstreamHostContextValue>(DEFAULT_HOST_CONTEXT);

export const useMarkstreamHostContext = (): MarkstreamHostContextValue => (
  React.useContext(MarkstreamHostContext)
);
