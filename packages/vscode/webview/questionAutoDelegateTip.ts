/**
 * VS Code webview host tip for question auto-delegate.
 *
 * Host posts `{ type: 'openchamber:question-auto-delegate-changed', properties }`.
 * Call the shared UI Query refresh once — never re-dispatch a window `message`
 * with the same type (the connection handler would recurse synchronously).
 *
 * Refresh is injected by `main.tsx` (`refreshQuestionAutoDelegate`) so this
 * helper stays free of Query runtime imports for unit tests.
 */

export const QUESTION_AUTO_DELEGATE_HOST_TIP_TYPE = 'openchamber:question-auto-delegate-changed';

export type QuestionAutoDelegateRefresh = () => void | Promise<void>;

/**
 * Consume one host tip envelope. Returns true when handled.
 * Always pass the shared UI `refreshQuestionAutoDelegate` from production.
 */
export function applyQuestionAutoDelegateHostTip(
  msg: unknown,
  refresh: QuestionAutoDelegateRefresh,
): boolean {
  if (!msg || typeof msg !== 'object') return false;
  if ((msg as { type?: unknown }).type !== QUESTION_AUTO_DELEGATE_HOST_TIP_TYPE) return false;
  void refresh();
  return true;
}
