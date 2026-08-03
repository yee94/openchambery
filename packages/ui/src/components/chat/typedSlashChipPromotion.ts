import { COMPOSER_TRIGGER_ICON_SLOT } from '@/composer/inline-visual';

export type TypedSlashChipToken = {
  /** Absolute start of the `/` token in `text`. */
  start: number;
  /** Absolute end (exclusive) of the full token, including any existing slot. */
  end: number;
  /** Canonical command/skill name without the trigger or slot. */
  name: string;
  /** Whether the source token already reserves the icon em-space. */
  hasSlot: boolean;
};

/**
 * Finds word-boundary slash tokens that exactly match a known command/skill.
 * Optional em-space between `/` and the name is accepted (reserved chips).
 */
export const findTypedSlashChipTokens = (
  text: string,
  knownNames: ReadonlySet<string>,
): TypedSlashChipToken[] => {
  if (!text.includes('/') || knownNames.size === 0) return [];
  const pattern = new RegExp(
    `(^|\\s)/(${COMPOSER_TRIGGER_ICON_SLOT})?([A-Za-z0-9][A-Za-z0-9_-]*)(?=$|\\s)`,
    'g',
  );
  const tokens: TypedSlashChipToken[] = [];
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    const name = match[3] ?? '';
    if (!knownNames.has(name.toLowerCase())) continue;
    const slot = match[2] ?? '';
    const start = match.index + (match[1]?.length ?? 0);
    tokens.push({
      start,
      end: start + 1 + slot.length + name.length,
      name,
      hasSlot: slot.length > 0,
    });
  }
  return tokens;
};

/**
 * Promote hand-typed compact slash chips (`/undo`) to reserved-slot chips
 * (`/\u2003undo`) so icon spacing matches autocomplete selection.
 * Returns null when no rewrite is needed.
 */
export const promoteTypedSlashChipSlots = (
  text: string,
  knownNames: ReadonlySet<string>,
  caret = text.length,
): { text: string; caret: number } | null => {
  const tokens = findTypedSlashChipTokens(text, knownNames).filter((token) => !token.hasSlot);
  if (tokens.length === 0) return null;

  let nextText = text;
  let nextCaret = caret;
  // Right-to-left so earlier indices stay valid after each insertion.
  for (let i = tokens.length - 1; i >= 0; i -= 1) {
    const token = tokens[i];
    const insertAt = token.start + 1;
    nextText = `${nextText.slice(0, insertAt)}${COMPOSER_TRIGGER_ICON_SLOT}${nextText.slice(insertAt)}`;
    if (nextCaret > insertAt) nextCaret += COMPOSER_TRIGGER_ICON_SLOT.length;
  }
  return nextText === text ? null : { text: nextText, caret: nextCaret };
};

/** Strip a leading reserved icon slot from a slash command query body. */
export const stripLeadingSlashCommandSlot = (query: string): string => (
  query.startsWith(COMPOSER_TRIGGER_ICON_SLOT) ? query.slice(COMPOSER_TRIGGER_ICON_SLOT.length) : query
);
