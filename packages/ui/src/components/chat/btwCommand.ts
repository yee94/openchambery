import { getLocalChatCommand } from './localCommandClassifier';
import type { SessionBtwScope } from '@/stores/useSessionBtwStore';

/** Claims the side question before any main-turn flight, queue or resource mutation. */
export function submitBtwCommand(options: {
  text: string;
  inputMode: 'normal' | 'shell';
  scope: SessionBtwScope | null;
  hasReferences: boolean;
  allowed: boolean;
  ask: (scope: SessionBtwScope, question: string) => Promise<void>;
  open: () => void;
  clearText: () => void;
  notify: (reason: 'questionRequired' | 'sessionRequired' | 'plainTextRequired') => void;
}): boolean {
  if (getLocalChatCommand(options.text, options.inputMode) !== 'btw') return false;
  if (!options.allowed) return true;
  const question = options.text.trimStart().replace(/^\/\u2003?btw(?:\s|$)/i, '').trim();
  if (!question) { options.notify('questionRequired'); return true; }
  if (!options.scope?.sessionId) { options.notify('sessionRequired'); return true; }
  // Keep reference payloads and their resource ownership intact for ordinary send.
  if (options.hasReferences) { options.notify('plainTextRequired'); return true; }
  void options.ask(options.scope, question);
  options.clearText();
  options.open();
  return true;
}
