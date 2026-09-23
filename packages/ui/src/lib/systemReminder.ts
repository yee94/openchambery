const SYSTEM_REMINDER_OPEN = '<system-reminder>';
const SYSTEM_REMINDER_CLOSE = '</system-reminder>';
const SYSTEM_REMINDER_BLOCK = /[ \t]*<system-reminder>[\s\S]*?<\/system-reminder>[ \t]*/g;
const SYSTEM_REMINDER_UNCLOSED = /[ \t]*<system-reminder>[\s\S]*$/;

export const wrapSystemReminder = (text: string): string => {
  const trimmed = text.trim();
  if (!trimmed) {
    return '';
  }

  if (trimmed.startsWith(SYSTEM_REMINDER_OPEN) && trimmed.endsWith(SYSTEM_REMINDER_CLOSE)) {
    return trimmed;
  }

  return `${SYSTEM_REMINDER_OPEN}\n${trimmed}\n${SYSTEM_REMINDER_CLOSE}`;
};

/** Drop injected reminder blocks so a user bubble keeps only authored text. */
export const stripSystemReminders = (text: string): string => {
  if (!text.includes(SYSTEM_REMINDER_OPEN)) {
    return text;
  }

  return text
    .replace(SYSTEM_REMINDER_BLOCK, '')
    .replace(SYSTEM_REMINDER_UNCLOSED, '')
    .trim();
};
