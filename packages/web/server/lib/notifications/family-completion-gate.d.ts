export type CompletionEvent = { kind: 'running' | 'complete' | 'cancel' | 'changed'; sessionId: string };
export function completionEvent(payload: unknown): CompletionEvent | null;
export function createFamilyCompletionGate<T>(options: {
  loadActiveSessionIds: () => Promise<Iterable<string>>;
  loadParent: (sessionId: string) => Promise<string | null>;
  onReady: (payload: T, isCurrent: () => boolean) => Promise<boolean | void>;
  retryMs?: number;
}): {
  observe(event: CompletionEvent | null, payload: T): Promise<void>;
  reset(): void;
  dispose(): void;
};
