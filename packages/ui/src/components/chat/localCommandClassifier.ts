export const LOCAL_CHAT_COMMANDS = new Set([
  'new', 'fork', 'compact', 'undo', 'redo', 'timeline', 'model', 'summary', 'workspace-review', 'handoff-review', 'goal', 'craft-goal', 'catch-up', 'debug', 'weigh', 'explore',
]);

export const IMMEDIATE_LOCAL_CHAT_COMMANDS = new Set([
  'new', 'compact', 'fork', 'undo', 'redo',
]);

/** Optional reserved icon em-space between `/` and the command name. */
const SLASH_COMMAND_HEAD = /^\/\u2003?([^\s]+)/i;
const GOAL_COMMAND_HEAD = /^\/\u2003?goal\b/i;

export const getLocalChatCommand = (text: string, inputMode: 'normal' | 'shell'): string | null => {
  if (inputMode !== 'normal') return null;
  const command = text.trimStart().match(SLASH_COMMAND_HEAD)?.[1]?.toLowerCase();
  return command && LOCAL_CHAT_COMMANDS.has(command) ? command : null;
};

/**
 * Trailing draft after `/goal`. null when the input is not a goal slash command.
 * `/goal` never auto-sends — it arms goal mode and leaves any objective text
 * in the composer for continued editing.
 */
export const getGoalCommandObjective = (text: string, inputMode: 'normal' | 'shell'): string | null => {
  if (getLocalChatCommand(text, inputMode) !== 'goal') return null;
  return text.trimStart().replace(GOAL_COMMAND_HEAD, '').trim();
};

export const preservesComposerResources = (text: string, inputMode: 'normal' | 'shell'): boolean => (
  getLocalChatCommand(text, inputMode) !== null
);

export const consumesImmediateCommandText = (text: string, inputMode: 'normal' | 'shell'): boolean => {
  const command = getLocalChatCommand(text, inputMode);
  return command !== null && IMMEDIATE_LOCAL_CHAT_COMMANDS.has(command);
};
