/**
 * Autocomplete Enter/tap only auto-runs this short list.
 *
 * Pure local fire-and-forget actions with no free-form draft:
 * session create/compact/fork, undo/redo, open model picker, arm goal.
 *
 * Everything else inserts into the composer so the user can keep typing
 * (or confirm deliberately with a second Enter): /loop and other custom
 * commands, magic prompts, /timeline, /init, skills.
 */
export const AUTO_SUBMIT_SLASH_COMMANDS = new Set([
  'new',
  'fork',
  'compact',
  'undo',
  'redo',
  // Opens the model selector immediately — never sends a chat message.
  'model',
  // Arm-only local switch — never sends a message, only flips goal mode.
  'goal',
]);

export const shouldSubmitCommandOnSelection = (
  command: {
    name?: string;
    source?: 'openchamber' | 'opencode' | 'skill';
    isBuiltIn?: boolean;
    isSkill?: boolean;
  },
  submitIntent: boolean,
): boolean => {
  if (!submitIntent || command.isSkill) return false;
  const name = command.name?.trim().toLowerCase();
  return Boolean(name && AUTO_SUBMIT_SLASH_COMMANDS.has(name));
};

export const isCommandAllowedForSubmission = (
  commandName: string | undefined,
  policy: (command: { name: string }) => boolean,
): boolean => !commandName || policy({ name: commandName });

/** Em-space reserved for trigger-icon chips; `\s` matches it, but it belongs to the slash token. */
const TRIGGER_ICON_SLOT = '\u2003';

export const getSlashTokenRange = (
  text: string,
  cursorPosition: number,
): { start: number; end: number } | null => {
  const end = Math.max(0, Math.min(cursorPosition, text.length));
  let start = end;
  while (start > 0 && !/\s/.test(text[start - 1])) start -= 1;
  // `/␠name` stops the whitespace walk after the slot glyph; include `/` + slot.
  if (start >= 2 && text[start - 1] === TRIGGER_ICON_SLOT && text[start - 2] === '/') {
    start -= 2;
  }
  return text[start] === '/' ? { start, end } : null;
};
