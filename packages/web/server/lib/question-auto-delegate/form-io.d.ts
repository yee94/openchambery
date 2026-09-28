import type { QuestionAutoDelegateIO, QuestionAutoDelegateUpstreamResult } from './core.js';

export function createQuestionFormIO(upstream: (
  path: string,
  options?: { directory?: string | null; method?: string; body?: unknown },
) => Promise<QuestionAutoDelegateUpstreamResult>): Pick<QuestionAutoDelegateIO, 'listQuestions' | 'postReply' | 'postReject'>;
