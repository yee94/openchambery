import { buildScene, type MascotDefinition, type MascotPose, type MascotScene } from './vendor/open-mascot/index.js';

type Point = readonly [number, number];
const fixed = (value: number) => Number(value.toFixed(3));

// Original, connected geometric outlines. No extracted character paths or
// third-party reference motion data. Paths are constructed once, not per frame.
function roundedPolygon(points: readonly Point[], rounding = 0.16): string {
  const near = (from: Point, to: Point): string =>
    `${fixed(from[0] + (to[0] - from[0]) * rounding)} ${fixed(from[1] + (to[1] - from[1]) * rounding)}`;
  return points.map((point, index) => {
    const previous = points[(index + points.length - 1) % points.length];
    const next = points[(index + 1) % points.length];
    return `${index === 0 ? 'M' : 'L'} ${near(point, previous)} Q ${point[0]} ${point[1]} ${near(point, next)}`;
  }).join(' ') + ' Z';
}

function polygon(sides: number, outer: number, inner = outer): string {
  const vertices = sides * (inner === outer ? 1 : 2);
  return roundedPolygon(Array.from({ length: vertices }, (_, index): Point => {
    const angle = -Math.PI / 2 + index * Math.PI * 2 / vertices;
    const radius = index % 2 === 0 ? outer : inner;
    return [fixed(280 + radius * Math.cos(angle)), fixed(280 + radius * Math.sin(angle))];
  }));
}

function petals(count: number, radius: number, depth: number): string {
  return roundedPolygon(Array.from({ length: 96 }, (_, index): Point => {
    const angle = index * Math.PI * 2 / 96;
    const r = radius + depth * Math.cos(count * angle);
    return [fixed(280 + r * Math.cos(angle)), fixed(280 + r * Math.sin(angle))];
  }), 0.5);
}

const SILHOUETTES = {
  square: { path: 'M 186 136 H 374 Q 424 136 424 186 V 374 Q 424 424 374 424 H 186 Q 136 424 136 374 V 186 Q 136 136 186 136 Z', eyeY: 0 },
  cloud: { path: 'M 172 390 C 105 390 102 292 151 275 C 124 207 184 160 235 185 C 266 113 363 130 377 207 C 449 201 473 282 432 318 C 463 373 410 405 364 390 Z', eyeY: 6 },
  flower: { path: petals(6, 131, 29), eyeY: 0 },
  star: { path: polygon(5, 174, 101), eyeY: 4 },
  heart: { path: 'M 280 422 C 246 391 128 315 132 231 C 136 149 231 124 280 190 C 329 124 424 149 428 231 C 432 315 314 391 280 422 Z', eyeY: 6 },
  clover: { path: petals(4, 123, 39), eyeY: 16 },
  hexagon: { path: polygon(6, 164), eyeY: 0 },
  diamond: { path: polygon(4, 175), eyeY: 0 },
  triangle: { path: roundedPolygon([[280, 114], [449, 419], [111, 419]], 0.12), eyeY: 20 },
  shield: { path: 'M 280 133 C 322 153 364 162 417 166 L 407 298 C 402 358 348 407 280 432 C 212 407 158 358 153 298 L 143 166 C 196 162 238 153 280 133 Z', eyeY: -2 },
  leaf: { path: 'M 420 132 C 441 281 391 419 256 424 C 162 429 122 359 144 275 C 169 186 282 145 420 132 Z', eyeY: 6 },
  sparkle: { path: polygon(4, 181, 82), eyeY: 16 },
} as const;

export type AdditionalAvatarShape = keyof typeof SILHOUETTES;
export const ADDITIONAL_AVATAR_SHAPES = Object.keys(SILHOUETTES) as AdditionalAvatarShape[];

export function silhouetteEyeY(shape: AdditionalAvatarShape): number {
  return SILHOUETTES[shape].eyeY;
}

/** Keep the sampled eye expression/gaze, then deform body and eyes together.
 * The upstream capsule renderer stays untouched and owns legacy silhouettes. */
export function buildSilhouetteScene(definition: MascotDefinition, pose: MascotPose, shape: AdditionalAvatarShape): MascotScene {
  const scene = buildScene(definition, {
    ...pose,
    blob: { pitch: 0, yaw: 0, roll: 0, squash: 0, lift: 0 },
  });
  const roll = pose.blob.roll * Math.PI / 180;
  const scaleX = Math.max(0.8, Math.cos(pose.blob.yaw * Math.PI / 180));
  const scaleY = Math.max(0.65, (1 - pose.blob.squash) * Math.cos(pose.blob.pitch * Math.PI / 180));
  const a = Math.cos(roll) * scaleX;
  const b = Math.sin(roll) * scaleX;
  const c = -Math.sin(roll) * scaleY;
  const d = Math.cos(roll) * scaleY;
  scene.transform = `matrix(${[a, b, c, d, 280 - a * 280 - c * 280, 280 - b * 280 - d * 280 + pose.blob.lift].map(fixed).join(' ')})`;
  scene.blob.path = SILHOUETTES[shape].path;
  return scene;
}
