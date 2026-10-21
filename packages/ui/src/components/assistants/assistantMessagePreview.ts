import type { AssistantLatestMessagePreview } from '@/queries/assistantDTO';

export const ASSISTANT_MESSAGE_PREVIEW_CLASS = 'block min-w-0 max-w-full truncate typography-micro text-muted-foreground';

const fallbackKeys = {
  image: 'assistants.contact.attachment.image',
  file: 'assistants.contact.attachment.file',
  session: 'assistants.contact.card.session.untitled',
  assistant: 'assistants.title',
  schedule: 'assistants.settings.scheduledTasks.title',
} as const;

type PreviewLabelKey = typeof fallbackKeys[keyof typeof fallbackKeys] | 'assistants.contact.empty';

/** Snapshot owns message selection and ordering; this only formats bounded visible text. */
export function getAssistantMessagePreview(
  preview: AssistantLatestMessagePreview | null | undefined,
  t: (key: PreviewLabelKey) => string,
): string {
  const text = preview?.text.replace(/\s+/gu, ' ').trim();
  if (text) return text;
  return t(preview?.fallbackKind ? fallbackKeys[preview.fallbackKind] : 'assistants.contact.empty');
}
