import { Avatar, Style } from '@dicebear/core';
import gaze from '@dicebear/styles/gaze.json';
import botttsNeutral from '@dicebear/styles/bottts-neutral.json';
import { DualLimitLru } from './dualLimitLru';

export type AvatarKind = 'assistant' | 'agent';

export type AvatarColorSet = {
  /** Avatar plate color. */
  background: string;
};

/** Neutral fallback when theme colors cannot be resolved (SSR, detached DOM). */
const FALLBACK_COLORS: AvatarColorSet = { background: '#c1f2c4' };

const styles = {
  assistant: new Style(gaze),
  agent: new Style(botttsNeutral),
};

const artwork = new DualLimitLru<string, string>({ maxEntries: 128, maxBytes: 1024 * 1024 });

/** Local, version-pinned SVGs. Identity, style, and colors determine the face. */
export function generatedAvatarDataUri(
  kind: AvatarKind,
  seed: string | undefined,
  animated = false,
  colors?: AvatarColorSet,
): string {
  const seedValue = kind === 'agent' ? seed?.trim().toLowerCase() || 'default' : seed || 'default';
  const background = kind === 'agent' ? (colors ?? FALLBACK_COLORS).background.replace('#', '') : '00000000';
  const key = JSON.stringify([kind, seedValue, background, kind === 'assistant' && animated]);
  const cached = artwork.get(key);
  if (cached !== undefined) return cached;
  let uri: string;
  if (kind === 'agent') {
    uri = new Avatar(styles.agent, {
      seed: seedValue,
      size: 128,
      idRandomization: false,
      borderRadius: 0,
      backgroundColor: [background],
    }).toDataUri();
  } else {
    uri = new Avatar(styles.assistant, {
      seed: seedValue,
      size: 128,
      scale: 1.2,
      backgroundColor: ['00000000'],
      idRandomization: false,
      animationVariant: animated ? 'fastest' : 'none',
    }).toDataUri();
  }
  artwork.set(key, uri, (key.length + uri.length) * 2);
  return uri;
}

/**
 * Agent artwork palette. Each Agent already owns an accent token computed by
 * `getAgentColor(name)`, so its plate reuses that same token and stays in step
 * with its Build/Explore badge. Bottts Neutral supplies its own facial contrast.
 */
export const resolveAgentAvatarColors = (
  accentVar: string,
  read: (cssVar: string) => string,
): AvatarColorSet => {
  const accent = read(accentVar);
  return {
    background: accent || FALLBACK_COLORS.background,
  };
};
