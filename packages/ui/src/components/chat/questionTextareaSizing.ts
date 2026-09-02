const QUESTION_TEXTAREA_LINE_HEIGHT = 20;
const QUESTION_TEXTAREA_MIN_LINES = 2;
const QUESTION_TEXTAREA_MAX_LINES = 10;

export const QUESTION_CUSTOM_TEXTAREA_MIN_HEIGHT = QUESTION_TEXTAREA_LINE_HEIGHT * QUESTION_TEXTAREA_MIN_LINES;
const QUESTION_CUSTOM_TEXTAREA_MAX_HEIGHT = QUESTION_TEXTAREA_LINE_HEIGHT * QUESTION_TEXTAREA_MAX_LINES;

export function clampQuestionCustomTextareaHeight(scrollHeight: number): number {
  return Math.min(Math.max(scrollHeight, QUESTION_CUSTOM_TEXTAREA_MIN_HEIGHT), QUESTION_CUSTOM_TEXTAREA_MAX_HEIGHT);
}

export function getQuestionCustomTextareaHeight({
  scrollHeight,
  currentHeight,
}: {
  scrollHeight: number;
  currentHeight: number | null | undefined;
}): number | null {
  const nextHeight = clampQuestionCustomTextareaHeight(scrollHeight);

  return currentHeight === nextHeight ? null : nextHeight;
}
