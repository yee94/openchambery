export const shouldSubmitCommandOnSelection = (
  command: { source?: 'openchamber' | 'opencode' | 'skill'; isBuiltIn?: boolean; isSkill?: boolean },
  submitIntent: boolean,
): boolean => submitIntent && !command.isSkill && (
  command.source === 'openchamber'
  || (command.source === 'opencode' && command.isBuiltIn === true)
);

export const isCommandAllowedForSubmission = (
  commandName: string | undefined,
  policy: (command: { name: string }) => boolean,
): boolean => !commandName || policy({ name: commandName });

export const getSlashTokenRange = (
  text: string,
  cursorPosition: number,
): { start: number; end: number } | null => {
  const end = Math.max(0, Math.min(cursorPosition, text.length));
  let start = end;
  while (start > 0 && !/\s/.test(text[start - 1])) start -= 1;
  return text[start] === '/' ? { start, end } : null;
};
