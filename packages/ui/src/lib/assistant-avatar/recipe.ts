import { buildScene, createDefinition, sampleExpression, type MascotDefinition, type MascotPose, type MascotScene } from './vendor/open-mascot/index.js';
import { ADDITIONAL_AVATAR_SHAPES, buildSilhouetteScene, silhouetteEyeY, type AdditionalAvatarShape } from './silhouettes';
import license from './vendor/open-mascot/LICENSE?raw';

// Keep the complete MIT permission/copyright notice in distributed bundles and
// standalone SVG exports, not just in the source checkout beside the engine.
export const ASSISTANT_AVATAR_LICENSE = license;

// This order is the original opaque-seed mapping. Never use the expanding
// picker catalog for hashing, or existing Bot identities change on upgrade.
const LEGACY_SHAPES = ['round', 'soft', 'tall', 'wide', 'compact', 'large', 'drop'] as const;
export const AVATAR_SHAPES = ['round', ...ADDITIONAL_AVATAR_SHAPES, 'drop', 'soft', 'tall', 'wide', 'compact', 'large'] as const;
// Retired choices remain valid recipes, but are no longer offered for selection.
export const AVATAR_PICKER_SHAPES = AVATAR_SHAPES.filter((shape) => shape !== 'tall' && shape !== 'compact' && shape !== 'large');
export const AVATAR_EYES = ['capsule', 'oval'] as const;
export const AVATAR_COLORS = ['mint', 'iris', 'coral', 'sky', 'sand', 'graphite'] as const;
export const AVATAR_EXPRESSIONS = ['neutral', 'curious', 'focused', 'beaming'] as const;
// One capsule pair for every Bot: fuller eyes, close spacing and a staggered
// three-quarter gaze, informed by DS-Bot's rendered characters rather than an
// isolated aspect ratio. Stored style/expression never randomizes this geometry.
export const AVATAR_EYE_SPEC = {
  width: 24, height: 58, gap: 38, rotation: -10,
  offsetX: 16, offsetY: -6, staggerY: 7,
} as const;
export type AvatarMotion = 'idle' | 'thinking' | 'happy';
export type AssistantAvatarRecipe = {
  shape: typeof AVATAR_SHAPES[number];
  eyes: typeof AVATAR_EYES[number];
  color: typeof AVATAR_COLORS[number];
  expression: typeof AVATAR_EXPRESSIONS[number];
  animate: boolean;
};

// Artwork pigments, not UI chrome or status colors. Fixed pigments also keep
// native PNGs and SVG faces identical across clients and light/dark themes.
const PIGMENTS: Record<AssistantAvatarRecipe['color'], { body: string; eyes: string }> = {
  mint: { body: '#9ed8bf', eyes: '#193c37' },
  iris: { body: '#c4b9ee', eyes: '#352c53' },
  coral: { body: '#edb0a0', eyes: '#56352f' },
  sky: { body: '#a5cbe7', eyes: '#253e55' },
  sand: { body: '#e2c99b', eyes: '#51432d' },
  graphite: { body: '#555c67', eyes: '#f2f4f7' },
};

/** Swatches represent the character's pigment, never the application's chrome. */
export const assistantAvatarPigment = (color: AssistantAvatarRecipe['color']): string => PIGMENTS[color].body;

const PREFIX = 'yuri-avatar:v1:';
const isChoice = <T extends string>(value: string, choices: readonly T[]): value is T => choices.includes(value as T);

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
  let hash = 2166136261;
  for (let i = 0; i < seed.length; i++) hash = Math.imul(hash ^ seed.charCodeAt(i), 16777619) >>> 0;
  return {
    shape: LEGACY_SHAPES[hash % LEGACY_SHAPES.length],
    eyes: 'capsule',
    color: AVATAR_COLORS[(hash >>> 8) % AVATAR_COLORS.length],
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
    shape: 'round', eyes: 'capsule', color: resolveAssistantAvatar(nonce).color,
    expression: 'neutral', animate: true,
  }, nonce);
}

type AssistantAvatarDefinition = MascotDefinition & { silhouette?: AdditionalAvatarShape };

export function createAssistantAvatarDefinition(seed: string | undefined): AssistantAvatarDefinition {
  const recipe = resolveAssistantAvatar(seed);
  const pigment = PIGMENTS[recipe.color];
  const legacyShape = LEGACY_SHAPES.find((shape) => shape === recipe.shape);
  const definition: AssistantAvatarDefinition = createDefinition({
    name: 'Yuri', shape: legacyShape ?? 'round', eyeShape: 'capsule',
    color: pigment.body, eyeColor: pigment.eyes, stageColor: pigment.body,
  });
  // Yuri uses one quiet rest pose. Legacy preference fields remain readable,
  // but cannot reintroduce random eye size/style through saved recipes.
  definition.animations.idle.steps[0].expression = 'neutral';
  definition.face.eyeWidth = AVATAR_EYE_SPEC.width;
  definition.face.eyeHeight = AVATAR_EYE_SPEC.height;
  definition.face.eyeGap = AVATAR_EYE_SPEC.gap;
  if (recipe.shape === 'drop') {
    // The drop body already uses the upstream 2D rig; its eyes must use that
    // same projection instead of drifting off a different 3D surface on turns.
    definition.blob.renderMode = 'rigged-2d';
    definition.face.eyeY = 10;
  }
  for (const expression of Object.values(definition.expressions)) {
    for (const side of ['left', 'right'] as const) {
      Object.assign(expression.pose.eyes[side], {
        scaleX: 1, scaleY: 1, x: AVATAR_EYE_SPEC.offsetX,
        y: AVATAR_EYE_SPEC.offsetY + (side === 'left' ? 1 : -1) * AVATAR_EYE_SPEC.staggerY,
        rotation: AVATAR_EYE_SPEC.rotation,
      });
    }
  }
  if (!legacyShape && isChoice(recipe.shape, ADDITIONAL_AVATAR_SHAPES)) {
    definition.silhouette = recipe.shape;
    definition.blob.renderMode = 'rigged-2d';
    definition.face.eyeY = silhouetteEyeY(recipe.shape);
  }
  return definition;
}

export function buildAssistantAvatarScene(definition: AssistantAvatarDefinition, pose: MascotPose): MascotScene {
  return definition.silhouette
    ? buildSilhouetteScene(definition, pose, definition.silhouette)
    : buildScene(definition, pose);
}

export function assistantAvatarStillScene(seed: string | undefined): MascotScene {
  const definition = createAssistantAvatarDefinition(seed);
  return buildAssistantAvatarScene(definition, sampleExpression(definition, 'neutral', 0, { reducedMotion: true }));
}

/** No definitions/IDs, external assets, scripts, animation, or theme variables:
 * the same neutral pose can be rasterized by the existing native PNG bridge. */
export function assistantAvatarSvg(seed: string | undefined): string {
  const scene = assistantAvatarStillScene(seed);
  const notice = ASSISTANT_AVATAR_LICENSE.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="64 64 432 432" width="128" height="128"><metadata>Yuri avatar; Open Mascot Studio (MIT)\n${notice}</metadata><g transform="${scene.transform}"><path d="${scene.blob.path}" fill="${scene.blob.fill}"/>${scene.eyes.map((eye) => `<path d="${eye.path}" fill="${eye.fill}"/>`).join('')}</g></svg>`;
}
