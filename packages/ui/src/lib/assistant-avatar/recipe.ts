import { AVATAR_SHAPES } from './catalog';
export { AVATAR_SHAPES } from './catalog';

// This order is the original opaque-seed mapping. Never use the expanding
// picker catalog for hashing, or existing Bot identities change on upgrade.
const LEGACY_SHAPES = ['round', 'soft', 'tall', 'wide', 'compact', 'large', 'drop'] as const;
const LEGACY_COLORS = ['mint', 'iris', 'coral', 'sky', 'sand', 'graphite'] as const;
// Retired choices remain valid recipes, but are no longer offered for selection.
export const AVATAR_PICKER_SHAPES = AVATAR_SHAPES.filter((shape) => shape !== 'tall' && shape !== 'compact' && shape !== 'large');
export const AVATAR_EYES = ['capsule', 'oval'] as const;
export const AVATAR_COLORS = ['mint', 'orange', 'iris', 'jade', 'coral', 'blue', 'sky', 'violet', 'sand', 'rose', 'cyan', 'graphite'] as const;
export const AVATAR_EXPRESSIONS = ['neutral', 'curious', 'focused', 'beaming'] as const;
export type AvatarMotion = 'idle' | 'working' | 'thinking' | 'happy';
export type AvatarEyeColor = 'white' | 'black';
export type AssistantAvatarRecipe = {
  shape: typeof AVATAR_SHAPES[number];
  eyes: typeof AVATAR_EYES[number];
  color: typeof AVATAR_COLORS[number];
  expression: typeof AVATAR_EXPRESSIONS[number];
  animate: boolean;
};

const PREFIX = 'yuri-avatar:v1:';
const isChoice = <T extends string>(value: string, choices: readonly T[]): value is T => choices.includes(value as T);
const hashSeed = (seed: string): number => {
  let hash = 2166136261;
  for (let i = 0; i < seed.length; i++) hash = Math.imul(hash ^ seed.charCodeAt(i), 16777619) >>> 0;
  return hash;
};

/** Existing opaque seeds remain valid. Unknown/malformed recipes are hashed,
 * never interpreted as markup, URLs, expressions, or arbitrary engine config. */
export function resolveAssistantAvatar(seed = 'default'): AssistantAvatarRecipe {
  seed = seed || 'default';
  if (seed.startsWith(PREFIX)) {
    const [shape, eyes, color, expression, animate, nonce, ...rest] = seed.slice(PREFIX.length).split(':');
    if (!rest.length && isChoice(shape, AVATAR_SHAPES) && isChoice(eyes, AVATAR_EYES)
      && isChoice(color, AVATAR_COLORS) && isChoice(expression, AVATAR_EXPRESSIONS)
      && (animate === '0' || animate === '1') && /^[a-zA-Z0-9-]{1,64}$/.test(nonce ?? '')) {
      return { shape, eyes, color, expression, animate: animate === '1' };
    }
  }
  const hash = hashSeed(seed);
  return {
    shape: LEGACY_SHAPES[hash % LEGACY_SHAPES.length],
    eyes: 'capsule',
    color: LEGACY_COLORS[(hash >>> 8) % LEGACY_COLORS.length],
    expression: 'neutral',
    animate: true,
  };
}

/** A compact, versioned recipe fits the existing 256-character avatarSeed
 * contract. Reuse the revision-checked save path and native share identity. */
export function encodeAssistantAvatar(recipe: AssistantAvatarRecipe, nonce = 'custom'): string {
  const result = `${PREFIX}${recipe.shape}:${recipe.eyes}:${recipe.color}:${recipe.expression}:${recipe.animate ? 1 : 0}:${nonce}`;
  if (!isChoice(recipe.shape, AVATAR_SHAPES) || !isChoice(recipe.eyes, AVATAR_EYES)
    || !isChoice(recipe.color, AVATAR_COLORS) || !isChoice(recipe.expression, AVATAR_EXPRESSIONS)
    || typeof recipe.animate !== 'boolean' || !/^[a-zA-Z0-9-]{1,64}$/.test(nonce)) {
    throw new Error('Invalid assistant avatar recipe');
  }
  return result;
}

/** New contacts share the round, capsule-eyed rest face; only pigment varies.
 * Explicit custom recipes and existing opaque seeds keep their own appearance. */
export function createDefaultAssistantAvatarSeed(nonce: string): string {
  return encodeAssistantAvatar({
    shape: 'round', eyes: 'capsule', color: AVATAR_COLORS[(hashSeed(nonce) >>> 8) % AVATAR_COLORS.length],
    expression: 'neutral', animate: true,
  }, nonce);
}

/** Persist the expanded palette choice explicitly; old opaque keys keep their six-color mapping. */
export function createRandomAssistantAvatarSeed(nonce: string): string {
  return encodeAssistantAvatar({
    ...resolveAssistantAvatar(nonce),
    color: AVATAR_COLORS[(hashSeed(nonce) >>> 8) % AVATAR_COLORS.length],
  }, nonce);
}
