const ADDITIONAL_AVATAR_SHAPES = ['square', 'cloud', 'flower', 'star', 'heart', 'clover', 'hexagon', 'diamond', 'triangle', 'shield', 'leaf', 'sparkle'] as const;
export const AVATAR_SHAPES = ['round', ...ADDITIONAL_AVATAR_SHAPES, 'drop', 'soft', 'tall', 'wide', 'compact', 'large'] as const;
export type AvatarShape = typeof AVATAR_SHAPES[number];

// Persisted Yuri names stay stable; runtime names follow the Anatomy registry.
export const AVATAR_BODY_NAMES: Record<AvatarShape, string> = {
  round: 'sphere', square: 'square', cloud: 'cloud', flower: 'starFlower', star: 'star6',
  heart: 'heartChubby', clover: 'clover', hexagon: 'hex', diamond: 'diamond', triangle: 'triangle',
  shield: 'shield', leaf: 'leaf', sparkle: 'sparkle', drop: 'teardrop', soft: 'squircle',
  tall: 'capsule', wide: 'tablet', compact: 'compact', large: 'large',
};
