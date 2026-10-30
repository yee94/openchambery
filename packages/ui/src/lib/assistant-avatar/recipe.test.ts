import { describe, expect, test } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  AVATAR_SHAPES, AVATAR_EYES, AVATAR_COLORS, AVATAR_EXPRESSIONS, AVATAR_EYE_SPEC,
  resolveAssistantAvatar, encodeAssistantAvatar, createDefaultAssistantAvatarSeed, assistantAvatarSvg, createAssistantAvatarDefinition, assistantAvatarStillScene, buildAssistantAvatarScene,
} from './recipe';
import { ADDITIONAL_AVATAR_SHAPES } from './silhouettes';
import { buildScene, sampleAnimation, sampleExpression, validateDefinition } from './vendor/open-mascot/index.js';

describe('Assistant avatar recipe', () => {
  test('round-trips every shape, color, eye style, expression and motion option within the existing seed limit', () => {
    for (const shape of AVATAR_SHAPES) for (const eyes of AVATAR_EYES) for (const color of AVATAR_COLORS) for (const expression of AVATAR_EXPRESSIONS) for (const animate of [true, false]) {
      const recipe = { shape, eyes, color, expression, animate };
      const seed = encodeAssistantAvatar(recipe, 'test-identity');
      expect(seed.length).toBeLessThanOrEqual(256);
      expect(resolveAssistantAvatar(seed)).toEqual(recipe);
      const definition = createAssistantAvatarDefinition(seed);
      expect(validateDefinition(definition).errors).toEqual([]);
      const svg = assistantAvatarSvg(seed);
      expect(svg).not.toMatch(/NaN|Infinity|undefined|<script|<image|<animate|href=|url\(|@keyframes|var\(/);
      expect(svg.match(/<path /g)).toHaveLength(3);
      expect(svg).toContain('Permission is hereby granted, free of charge');
    }
  });

  test('legacy IDs and random seeds need no migration and are deterministic', () => {
    expect(resolveAssistantAvatar('')).toEqual(resolveAssistantAvatar(undefined));
    for (const seed of ['assistant-1', 'Same-ID', 'same-id', '🤖', 'a'.repeat(256)]) {
      expect(resolveAssistantAvatar(seed)).toEqual(resolveAssistantAvatar(seed));
      expect(assistantAvatarSvg(seed)).toBe(assistantAvatarSvg(seed));
    }
    expect(resolveAssistantAvatar('Same-ID')).not.toEqual(resolveAssistantAvatar('same-id'));
  });

  test('expanding the picker does not reassign existing opaque seeds or saved v1 recipes', () => {
    const originals = [
      ['legacy-contact-a', { shape: 'round', eyes: 'capsule', color: 'mint', expression: 'neutral', animate: true }],
      ['legacy-contact-b', { shape: 'drop', eyes: 'capsule', color: 'iris', expression: 'neutral', animate: true }],
      ['legacy-contact-c', { shape: 'compact', eyes: 'capsule', color: 'iris', expression: 'neutral', animate: true }],
    ] as const;
    for (const [seed, original] of originals) {
      expect(resolveAssistantAvatar(seed)).toEqual(original);
      expect(resolveAssistantAvatar(encodeAssistantAvatar(original))).toEqual(original);
      const definition = createAssistantAvatarDefinition(seed);
      const pose = sampleExpression(definition, original.expression, 0, { reducedMotion: true });
      expect(assistantAvatarStillScene(seed)).toEqual(buildScene(definition, pose));
    }
  });

  test('new Bot defaults change only pigment and nonce, never shape or eye geometry', () => {
    const defaults = Array.from({ length: 64 }, (_, index) => createDefaultAssistantAvatarSeed(`new-bot-${index}`));
    const colors = new Set(defaults.map((seed) => resolveAssistantAvatar(seed).color));
    expect(colors.size).toBe(AVATAR_COLORS.length);
    const first = assistantAvatarStillScene(defaults[0]);
    for (const seed of defaults) {
      const recipe = resolveAssistantAvatar(seed);
      expect(recipe).toMatchObject({ shape: 'round', eyes: 'capsule', expression: 'neutral', animate: true });
      const scene = assistantAvatarStillScene(seed);
      expect(scene.blob.path).toBe(first.blob.path);
      expect(scene.eyes.map((eye) => eye.path)).toEqual(first.eyes.map((eye) => eye.path));
      expect(scene.transform).toBe(first.transform);
    }
  });

  test('all shapes and legacy eye/expression preferences render one fixed rest-eye specification', () => {
    for (const shape of AVATAR_SHAPES) {
      let expected: ReturnType<typeof assistantAvatarStillScene> | undefined;
      for (const eyes of AVATAR_EYES) for (const expression of AVATAR_EXPRESSIONS) {
        const seed = encodeAssistantAvatar({ shape, eyes, expression, color: 'iris', animate: true });
        const definition = createAssistantAvatarDefinition(seed);
        expect(definition.face).toMatchObject({ eyeShape: 'capsule', eyeWidth: AVATAR_EYE_SPEC.width, eyeHeight: AVATAR_EYE_SPEC.height, eyeGap: AVATAR_EYE_SPEC.gap });
        for (const value of Object.values(definition.expressions)) {
          for (const side of ['left', 'right'] as const) {
            expect(value.pose.eyes[side]).toEqual({
              scaleX: 1, scaleY: 1, x: AVATAR_EYE_SPEC.offsetX,
              y: AVATAR_EYE_SPEC.offsetY + (side === 'left' ? 1 : -1) * AVATAR_EYE_SPEC.staggerY,
              rotation: AVATAR_EYE_SPEC.rotation,
            });
          }
        }
        const scene = assistantAvatarStillScene(seed);
        expected ??= scene;
        expect(scene).toEqual(expected);
      }
    }
  });

  test('rest capsules lean down-right on screen, not in the mirrored direction', () => {
    for (const shape of AVATAR_SHAPES) {
      const scene = assistantAvatarStillScene(encodeAssistantAvatar({ ...resolveAssistantAvatar('a'), shape }));
      for (const eye of scene.eyes) {
        const values = eye.path.match(/-?\d+(?:\.\d+)?/g)!.map(Number);
        const points = Array.from({ length: values.length / 2 }, (_, index) => [values[index * 2], values[index * 2 + 1]]);
        const meanX = points.reduce((sum, point) => sum + point[0], 0) / points.length;
        const meanY = points.reduce((sum, point) => sum + point[1], 0) / points.length;
        expect(points.reduce((sum, point) => sum + (point[0] - meanX) * (point[1] - meanY), 0)).toBeGreaterThan(0);
      }
    }
  });

  test('rest eyes retain a close, staggered pair rather than two small parallel slashes', () => {
    const definition = createAssistantAvatarDefinition(createDefaultAssistantAvatarSeed('rest-gaze'));
    expect(definition.face.eyeHeight / definition.blob.height).toBeGreaterThan(0.25);
    expect(definition.face.eyeGap / definition.blob.width).toBeLessThan(0.2);
    const { left, right } = definition.expressions.neutral.pose.eyes;
    expect(right.y).toBeLessThan(left.y);
    expect(left.x).toBe(right.x);
    expect(left.scaleX).toBe(right.scaleX);
    expect(left.scaleY).toBe(right.scaleY);
    const baseline = structuredClone(definition.expressions.neutral.pose.eyes);
    const blinking = sampleAnimation(definition, 'idle', 3385).pose.eyes;
    expect(blinking.left.scaleY).toBeLessThan(0.1);
    expect(blinking.right.scaleY).toBeLessThan(0.1);
    expect(definition.expressions.neutral.pose.eyes).toEqual(baseline);
  });

  test('the drop attaches its fixed-size eyes to the same rig as its body', () => {
    const definition = createAssistantAvatarDefinition(encodeAssistantAvatar({ ...resolveAssistantAvatar('a'), shape: 'drop' }));
    expect(definition.blob.renderMode).toBe('rigged-2d');
    expect(definition.face).toMatchObject({ eyeY: 10, eyeWidth: AVATAR_EYE_SPEC.width, eyeHeight: AVATAR_EYE_SPEC.height });
  });

  test('offers twelve distinct connected silhouettes, never crystal or scattered dots', () => {
    expect(AVATAR_SHAPES).toHaveLength(19);
    expect(ADDITIONAL_AVATAR_SHAPES).toHaveLength(12);
    expect(AVATAR_SHAPES).not.toContain('crystal');
    const paths = ADDITIONAL_AVATAR_SHAPES.map((shape) => {
      const seed = encodeAssistantAvatar({ ...resolveAssistantAvatar('a'), shape });
      const scene = assistantAvatarStillScene(seed);
      expect(scene.blob.path.match(/M/g)).toHaveLength(1);
      expect(scene.blob.path.match(/Z/g)).toHaveLength(1);
      expect(scene.transform).not.toMatch(/NaN|undefined|Infinity/);
      return scene.blob.path;
    });
    expect(new Set(paths).size).toBe(12);
  });

  test.each(ADDITIONAL_AVATAR_SHAPES)('%s shares static/live geometry and deforms body and eyes together without rebuilding its outline', (shape) => {
    const seed = encodeAssistantAvatar({ ...resolveAssistantAvatar('a'), shape });
    const definition = createAssistantAvatarDefinition(seed);
    const rest = sampleExpression(definition, resolveAssistantAvatar(seed).expression, 0, { reducedMotion: true });
    expect(buildAssistantAvatarScene(definition, rest)).toEqual(assistantAvatarStillScene(seed));
    const idle = buildAssistantAvatarScene(definition, sampleAnimation(definition, 'idle', 1000).pose);
    const working = buildAssistantAvatarScene(definition, sampleAnimation(definition, 'thinking', 3000).pose);
    expect(idle.blob.path).toBe(working.blob.path);
    expect(idle.blob.fill).toBe(working.blob.fill);
    expect(idle.transform).not.toBe(working.transform);
    expect(idle.eyes[0].path).not.toBe(working.eyes[0].path);
  });

  test.each([
    'yuri-avatar:v2:round:oval:mint:neutral:1:custom',
    'yuri-avatar:v1:round:oval:mint:neutral:1',
    'yuri-avatar:v1:round:oval:mint:neutral:1:custom:extra',
    'yuri-avatar:v1:round:oval:mint:neutral:yes:custom',
    'yuri-avatar:v1:round:oval:<script>:neutral:1:custom',
    'yuri-avatar:v1:unknown:oval:mint:neutral:1:custom',
    'yuri-avatar:v1:round:oval:mint:neutral:1:../../file',
  ])('treats an invalid or future recipe as opaque seed, never markup: %s', (seed) => {
    expect(AVATAR_SHAPES).toContain(resolveAssistantAvatar(seed).shape);
    expect(assistantAvatarSvg(seed)).not.toMatch(/<script|\.\.\/|href=|undefined|NaN/);
  });

  test('working and idle animations move geometry without changing identity pigments', () => {
    const definition = createAssistantAvatarDefinition('assistant-1');
    const idle = buildScene(definition, sampleAnimation(definition, 'idle', 1000).pose);
    const busy = buildScene(definition, sampleAnimation(definition, 'thinking', 3000).pose);
    expect(idle.blob.fill).toBe(busy.blob.fill);
    expect(idle.eyes[0].fill).toBe(busy.eyes[0].fill);
    expect(idle.eyes[0].path).not.toBe(busy.eyes[0].path);
  });

  test('vendored source and declarations match the pinned MIT upstream bytes', () => {
    const source = join(dirname(fileURLToPath(import.meta.url)), 'vendor/open-mascot');
    const hashes = {
      'index.js': '45b3b68bab1e377ac2d97e8d2f0c56392aeaa3a1029e7cf6ce7f13293e04ab39',
      'index.d.ts': '15b94552fa1c6c560d6a032017adbcfab9dd551468d4cae0174af0e42e9dcf2f',
      'definition.js': 'efeaf50d0ac83c83144c9bfef88c125c8d2e81d6cfa71be633fe556d47cbdc25',
      'shapes.js': 'e3e70b2ce2184c709576d5308c33b225a6a3f3ffc82c2701eea8fa9bab456e95',
      'motion.js': '3f2a3b3b1b2129f95cf28fbf1026d20adc5c1cf0ee78537f916d3c28705d5f35',
      'scene.js': '7cb177ed0baecea1af6735ca2018f62dea0d639566a13f007eeeaa01446087e4',
    };
    for (const [name, hash] of Object.entries(hashes)) {
      expect(createHash('sha256').update(readFileSync(join(source, name))).digest('hex')).toBe(hash);
    }
    expect(readFileSync(join(source, 'LICENSE'), 'utf8')).toContain('MIT License');
  });
});
