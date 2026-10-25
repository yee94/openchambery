import { postAbortMessage, sendBridgeMessageWithOptions } from './bridge';
import type {
  ConversationsAPI,
  ConversationCreateWithPromptInput,
  ConversationCreateWithPromptResult,
} from '@yuriai/ui/lib/api/types';

export const createVSCodeConversationsAPI = (): ConversationsAPI => ({
  async createWithPrompt(
    input: ConversationCreateWithPromptInput,
    signal?: AbortSignal,
  ): Promise<ConversationCreateWithPromptResult> {
    return sendBridgeMessageWithOptions<ConversationCreateWithPromptResult>(
      'api:conversations:createWithPrompt',
      input,
      {
        timeoutMs: 0,
        signal,
        onAbort: (requestID: string) => {
          postAbortMessage('api:conversations:abort', requestID);
        },
      },
    );
  },
});
