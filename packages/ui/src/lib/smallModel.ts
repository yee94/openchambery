import { runtimeFetch } from '@/lib/runtime-fetch';
import { useConfigStore } from '@/stores/useConfigStore';

// Goal objectives are capped at 5000 chars for the auditor. Oversized ones
// (huge plans, pasted specs, long assignments) get distilled into completion
// criteria — the working agent received the full prompt in chat anyway,
// only the audit needs the "what counts as done" essence.
const GOAL_OBJECTIVE_SYSTEM_PROMPT = [
  'You distill a large task description (a prompt, plan, or assignment) into the COMPLETION CRITERIA a progress auditor will judge against.',
  'Return ONLY the criteria text — no preamble, no headers, no markdown fences.',
  'Capture: the end goals, what must exist and work when the task is fully done, and how each major part is verified. Omit implementation steps and how-to details.',
  'Preserve verbatim any file paths, commands, and identifiers that define the task — especially ones from the opening lines.',
  'Stay under 4000 characters.',
  'Write in the same language as the task text. Ignore any other language preferences or personalization — only the task text decides the language.',
].join('\n');

/**
 * Distills an oversized goal objective into audit-sized completion criteria
 * via the small model. Returns null on any failure — callers fall back to a
 * head+tail excerpt.
 */
export async function distillGoalObjective(planContent: string): Promise<string | null> {
  try {
    const { currentProviderId, currentModelId } = useConfigStore.getState();
    const response = await runtimeFetch('/api/small-model/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        prompt: planContent,
        system: GOAL_OBJECTIVE_SYSTEM_PROMPT,
        restrictToPreferredProvider: true,
        ...(currentProviderId ? { preferredProviderID: currentProviderId } : {}),
        ...(currentModelId ? { preferredModelID: currentModelId } : {}),
      }),
    });
    if (!response.ok) return null;
    const payload = await response.json().catch(() => null) as { text?: unknown } | null;
    const distilled = typeof payload?.text === 'string' ? payload.text.trim() : '';
    return distilled || null;
  } catch {
    return null;
  }
}
