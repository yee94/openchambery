import { ensureSettingsBootstrapQuery } from '@/queries/settingsBootstrapQueries';
import { getRuntimeTransportIdentity } from '@/lib/runtime-switch';

export const RESPONSE_STYLE_PRESETS = ['concise', 'detailed', 'mentor', 'pushback', 'noFiller', 'matchEnergy', 'warmPeer'] as const;
export type ResponseStylePreset = typeof RESPONSE_STYLE_PRESETS[number];

export const isResponseStylePreset = (value: unknown): value is ResponseStylePreset => (
  typeof value === 'string' && RESPONSE_STYLE_PRESETS.includes(value as ResponseStylePreset)
);

export const getResponseStylePresetInstructions = (preset: ResponseStylePreset): string => {
  switch (preset) {
    case 'concise':
      return "Keep replies short. Answer first, no preamble or recap of the question. Write like you're texting a colleague who already has the context — plain sentences, not headings or bullets. Reach for a list only when the content is genuinely a list; never use one to look organised.";
    case 'detailed':
      return "Take the space you need to actually explain things. Walk through what's going on, why it matters, and where the real tradeoffs are. Prefer flowing prose over bullet points and headings — structure the answer with paragraphs and let the reasoning carry it. Lists are fine when something really is enumerable, but don't fragment a normal explanation into bullets.";
    case 'mentor':
      return "Talk like a patient senior engineer pairing with someone less experienced. Explain the underlying idea before the answer, think out loud about how you'd approach it, and drop in a small concrete example when it actually helps. Keep it conversational — no lecture format, no checklists, no numbered steps unless the task literally is a sequence.";
    case 'pushback':
      return "Don't agree automatically. If something I say sounds off — a wrong assumption, a flawed approach, a request that won't actually do what I think it will — push back first. Explain what you disagree with and why, and only proceed once I've responded. Disagreement is welcome; sycophancy is not. Don't soften it with 'you might want to consider' — just say it.";
    case 'noFiller':
      return "Cut the filler. No 'Great question', no 'Certainly', no 'I'll help you with that', no restating what I just asked. No closing summary of what you did when the diff or output already shows it. No trailing 'let me know if you need anything else'. Open with the actual content and stop when you're done.";
    case 'matchEnergy':
      return "Mirror the size and register of my message. A one-line question gets a one-line answer. A casual aside gets a casual reply, not a structured breakdown. If I write three words, don't respond with three paragraphs. Match the tone too — informal stays informal, technical stays technical. Don't inflate small asks into full essays.";
    case 'warmPeer':
      return "Talk like a colleague, not an assistant. First person is fine and encouraged — 'I'd do this', 'I don't love that approach', 'that was sloppy of me'. Have actual opinions and share them. Push back when you disagree. Admit when you screwed up without grovelling. Skip the corporate helpfulness and performative politeness — just be a person.";
  }
};

type ResponseStyleSettingsSnapshot = {
  enabled: boolean;
  preset: unknown;
  customInstructions: unknown;
};

const responseStyleSettingsCache = new Map<string, ResponseStyleSettingsSnapshot>();
const responseStyleFetchInFlight = new Map<string, Promise<string | null>>();

export const buildResponseStyleInstruction = ({
  enabled,
  preset,
  customInstructions,
}: {
  enabled?: boolean;
  preset?: unknown;
  customInstructions?: unknown;
}): string | null => {
  if (!enabled) return null;
  if (preset === 'custom') {
    const custom = typeof customInstructions === 'string' ? customInstructions.trim() : '';
    return custom || null;
  }
  if (!isResponseStylePreset(preset)) return null;
  return getResponseStylePresetInstructions(preset);
};

/**
 * Warm / refresh the send-path cache when settings are loaded or saved elsewhere
 * (defaults bootstrap, Behavior page). Avoids settings bootstrap reads on every
 * first message while the browser connection pool is saturated.
 */
export const rememberResponseStyleSettings = (settings: {
  enabled?: unknown;
  preset?: unknown;
  customInstructions?: unknown;
}, transport = getRuntimeTransportIdentity()): void => {
  responseStyleSettingsCache.set(transport, {
    enabled: settings.enabled === true,
    preset: settings.preset,
    customInstructions: settings.customInstructions,
  });
};

/** Test helper — clears the in-memory send-path cache. */
export const clearResponseStyleSettingsCache = (): void => {
  responseStyleSettingsCache.clear();
  responseStyleFetchInFlight.clear();
};

export const getCachedResponseStyleInstruction = (transport = getRuntimeTransportIdentity()): string | null | undefined => {
  const cached = responseStyleSettingsCache.get(transport);
  if (!cached) return undefined;
  return buildResponseStyleInstruction(cached);
};

export const fetchResponseStyleInstruction = async (): Promise<string | null> => {
  const transport = getRuntimeTransportIdentity();
  const cached = getCachedResponseStyleInstruction(transport);
  if (cached !== undefined) return cached;

  const inFlight = responseStyleFetchInFlight.get(transport);
  if (inFlight) return inFlight;

  const request = (async () => {
    const settings = await ensureSettingsBootstrapQuery(transport);
    rememberResponseStyleSettings({
      enabled: settings.responseStyleEnabled,
      preset: settings.responseStylePreset,
      customInstructions: settings.responseStyleCustomInstructions,
    }, transport);
    return getCachedResponseStyleInstruction(transport) ?? null;
  })();
  responseStyleFetchInFlight.set(transport, request);

  try {
    return await request;
  } finally {
    if (responseStyleFetchInFlight.get(transport) === request) {
      responseStyleFetchInFlight.delete(transport);
    }
  }
};
