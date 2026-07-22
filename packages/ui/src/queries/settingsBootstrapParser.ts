import type { SettingsBootstrap, SettingsBootstrapPatch } from './settingsBootstrapDto';

const MAX_STRING_LENGTH = 512;
const MAX_URL_LENGTH = 4_096;
const MAX_LANGUAGE_LENGTH = 64;
const MAX_CUSTOM_INSTRUCTIONS_LENGTH = 200_000;
const responseStylePresets = ['concise', 'detailed', 'mentor', 'pushback', 'noFiller', 'matchEnergy', 'warmPeer', 'custom'] as const;

const fieldNames = [
  'defaultModel',
  'defaultVariant',
  'defaultAgent',
  'autoCreateWorktree',
  'gitmojiEnabled',
  'defaultFileViewerPreview',
  'zenModel',
  'messageStreamTransport',
  'sttProvider',
  'sttServerUrl',
  'sttModel',
  'sttLocalModel',
  'sttLanguage',
  'responseStyleEnabled',
  'responseStylePreset',
  'responseStyleCustomInstructions',
] as const;

type SettingsBootstrapField = typeof fieldNames[number];
type RecordValue = Record<string, unknown>;

const isRecord = (value: unknown): value is RecordValue =>
  typeof value === 'object' && value !== null && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;

const hasOwn = (value: RecordValue, key: string): boolean => Object.prototype.hasOwnProperty.call(value, key);

const readString = (value: unknown, maxLength: number): string | undefined => {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim();
  return normalized.length <= maxLength ? normalized : undefined;
};

const readUrl = (value: unknown): string | undefined => {
  const normalized = readString(value, MAX_URL_LENGTH);
  if (normalized === undefined) return undefined;
  try {
    const url = new URL(normalized);
    return (url.protocol === 'http:' || url.protocol === 'https:') && !url.username && !url.password
      ? normalized
      : undefined;
  } catch {
    return undefined;
  }
};

const readEnum = <T extends string>(value: unknown, values: readonly T[]): T | undefined =>
  typeof value === 'string' && values.includes(value as T) ? value as T : undefined;

const readBoolean = (value: unknown): boolean | undefined => typeof value === 'boolean' ? value : undefined;

const readField = (input: RecordValue, field: SettingsBootstrapField): SettingsBootstrap[SettingsBootstrapField] | undefined => {
  const value = input[field];
  switch (field) {
    case 'autoCreateWorktree':
    case 'gitmojiEnabled':
    case 'defaultFileViewerPreview':
    case 'responseStyleEnabled':
      return readBoolean(value);
    case 'messageStreamTransport':
      return readEnum(value, ['auto', 'ws', 'sse']);
    case 'sttProvider':
      return readEnum(value, ['local', 'openai-compatible']);
    case 'sttServerUrl':
      return readUrl(value);
    case 'sttLanguage':
      return readString(value, MAX_LANGUAGE_LENGTH);
    case 'responseStyleCustomInstructions':
      return readString(value, MAX_CUSTOM_INSTRUCTIONS_LENGTH);
    case 'responseStylePreset':
      return readEnum(value, responseStylePresets);
    default:
      return readString(value, MAX_STRING_LENGTH);
  }
};

export const parseSettingsBootstrap = (input: unknown): SettingsBootstrap => {
  if (!isRecord(input)) throw new Error('Invalid settings bootstrap response');
  if (!hasOwn(input, 'schemaVersion') || input.schemaVersion !== 1) {
    throw new Error('Unsupported settings bootstrap schema version');
  }

  const output: SettingsBootstrap = { schemaVersion: 1 };
  for (const field of fieldNames) {
    if (!hasOwn(input, field)) continue;
    const value = readField(input, field);
    if (value !== undefined) {
      Object.assign(output, { [field]: value });
    }
  }
  return output;
};

export const parseSettingsBootstrapPatch = (input: unknown): SettingsBootstrapPatch => {
  if (!isRecord(input)) throw new Error('Invalid settings bootstrap patch');
  for (const key of Object.keys(input)) {
    if (!(fieldNames as readonly string[]).includes(key)) {
      throw new Error('Invalid settings bootstrap patch');
    }
  }

  const parsed = parseSettingsBootstrap({ schemaVersion: 1, ...input });
  const patch: SettingsBootstrapPatch = {};
  for (const field of fieldNames) {
    if (!hasOwn(input, field)) continue;
    if (!hasOwn(parsed, field)) throw new Error('Invalid settings bootstrap patch');
    Object.assign(patch, { [field]: parsed[field] });
  }
  return patch;
};

export const projectSettingsBootstrapPatch = (input: unknown): SettingsBootstrapPatch => {
  if (!isRecord(input)) return {};
  const patch: SettingsBootstrapPatch = {};
  for (const field of fieldNames) {
    if (!hasOwn(input, field)) continue;
    const value = readField(input, field);
    if (value !== undefined) {
      Object.assign(patch, { [field]: value });
    }
  }
  return patch;
};
