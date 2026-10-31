import { afterEach, describe, expect, test, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AVATAR_SHAPES, AVATAR_EYES, AVATAR_COLORS, AVATAR_EXPRESSIONS, AVATAR_PICKER_SHAPES, resolveAssistantAvatar, encodeAssistantAvatar, createDefaultAssistantAvatarSeed, createRandomAssistantAvatarSeed } from './recipe';
import { assistantAvatarArtboard, assistantAvatarStillModel, createAssistantAvatarPlayer, assistantAvatarSvg, assistantAvatarPigment, mountAssistantAvatarRenderer } from './engine';
import { buildAvatarBody, compactAvatarOutline } from './geometry';
import { AVATAR_BODY_NAMES } from './catalog';
import { buildModel, createRuntime, createStateMachine, makeConfig, makeMorphGenerators, makeTrail, lb, type Frame, type Model } from './vendor/grok-anatomy/player.js';
import recipes from './vendor/grok-anatomy/grok-recipes.json';

const source = join(dirname(fileURLToPath(import.meta.url)), 'vendor/grok-anatomy');
const geometry = (model: Model) => model.mode === 'sphere' ? model.bodyD + model.eyesD : JSON.stringify([model.bodyPts, model.eyesPts]);
afterEach(() => vi.restoreAllMocks());

describe('Assistant avatar recipe', () => {
  test('navigation shape cycling blends between allowed bodies without mutating the saved recipe or replaying time gaps', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const recipe = { ...resolveAssistantAvatar('navigation'), shape: 'round' as const };
    const before = { ...recipe };
    const cycling = createAssistantAvatarPlayer(recipe, 'navigation', 'idle', true, { randomizeShape: true });
    const ordinary = createAssistantAvatarPlayer(recipe, 'navigation', 'idle', true);
    for (let i = 0; i < 38; i++) {
      expect(cycling.advance(0.1).model.mode).toBe('sphere');
      expect(ordinary.advance(0.1).model.mode).toBe('sphere');
    }
    // A long background gap advances at most .1s, not a burst of new bodies.
    expect(cycling.advance(60).model.mode).toBe('sphere');
    for (let i = 0; i < 10; i++) {
      const { model, bounds } = cycling.advance(0.1);
      expect(Object.values(bounds).every(Number.isFinite)).toBe(true);
      expect(ordinary.advance(0.1).model.mode).toBe('sphere');
      if (i === 9) expect(model.mode).toBe('morph');
      if (model.mode === 'morph') expect(model.parts).toHaveLength(0);
    }
    for (let i = 0; i < 45; i++) cycling.advance(0.1);
    expect(cycling.advance(0.1).model.mode).toBe('sphere');
    expect(recipe).toEqual(before);
  });

  test.each(AVATAR_PICKER_SHAPES.filter((shape) => shape !== 'round'))('navigation can blend from round to %s with finite, contained artwork', (shape) => {
    const choices = AVATAR_PICKER_SHAPES.filter((candidate) => candidate !== 'round');
    vi.spyOn(Math, 'random').mockReturnValue(0).mockReturnValueOnce(0)
      .mockReturnValueOnce((choices.indexOf(shape) + 0.5) / choices.length);
    const recipe = { ...resolveAssistantAvatar('cycle'), shape: 'round' as const };
    const player = createAssistantAvatarPlayer(recipe, 'cycle', 'idle', true, { randomizeShape: true });
    const renderer = mountAssistantAvatarRenderer(document, `cycle-${shape}`, recipe);
    const board = assistantAvatarArtboard(recipe);
    player.setGaze([1, -1]);
    let blended = false;
    for (let i = 0; i < 60; i++) {
      const sample = player.advance(0.1);
      renderer.paint(sample);
      expect(Object.values(sample.bounds).every(Number.isFinite)).toBe(true);
      expect(renderer.svg.querySelector(':scope > g')?.getAttribute('transform')).not.toMatch(/NaN|Infinity/);
      const scale = Number(renderer.svg.querySelector(':scope > g')!.getAttribute('transform')!.match(/scale\(([^)]+)\)/)![1]);
      for (const x of [sample.bounds.x0, sample.bounds.x1]) expect(Math.abs((x - board.cx) * scale)).toBeLessThanOrEqual(board.size * 0.49 + 1e-6);
      for (const y of [sample.bounds.y0, sample.bounds.y1]) expect(Math.abs((y - board.cy) * scale)).toBeLessThanOrEqual(board.size * 0.49 + 1e-6);
      if (sample.model.mode === 'morph') {
        blended = true;
        expect(sample.model.bodyPts.length).toBeGreaterThan(2);
        expect(sample.model.parts).toHaveLength(0);
      }
    }
    expect(blended).toBe(true);
  });
  test('round-trips every saved option, including retired shapes, within the seed limit', () => {
    for (const shape of AVATAR_SHAPES) for (const eyes of AVATAR_EYES) for (const color of AVATAR_COLORS) for (const expression of AVATAR_EXPRESSIONS) for (const animate of [true, false]) {
      const recipe = { shape, eyes, color, expression, animate };
      const seed = encodeAssistantAvatar(recipe, 'identity');
      expect(seed.length).toBeLessThanOrEqual(256);
      expect(resolveAssistantAvatar(seed)).toEqual(recipe);
    }
    expect(AVATAR_PICKER_SHAPES).toHaveLength(16);
    expect(AVATAR_PICKER_SHAPES).not.toContain('tall');
    expect(AVATAR_PICKER_SHAPES).not.toContain('compact');
    expect(AVATAR_PICKER_SHAPES).not.toContain('large');
    expect(AVATAR_SHAPES).not.toContain('crystal');
  });

  test('opaque seeds keep their original shape/color assignment without a migration', () => {
    const original = [
      ['legacy-contact-a', { shape: 'round', color: 'mint' }],
      ['legacy-contact-b', { shape: 'drop', color: 'iris' }],
      ['legacy-contact-c', { shape: 'compact', color: 'iris' }],
    ] as const;
    for (const [seed, expected] of original) expect(resolveAssistantAvatar(seed)).toMatchObject(expected);
    expect(resolveAssistantAvatar('')).toEqual(resolveAssistantAvatar(undefined));
    for (const seed of ['same-id', 'Same-ID', '🤖', 'a'.repeat(256)]) expect(assistantAvatarSvg(seed)).toBe(assistantAvatarSvg(seed));
  });

  test('new Bots all use the first round neutral face, varying only pigment', () => {
    const defaults = Array.from({ length: 256 }, (_, i) => createDefaultAssistantAvatarSeed(`bot-${i}`));
    expect(new Set(defaults.map((s) => resolveAssistantAvatar(s).color))).toEqual(new Set(AVATAR_COLORS));
    const first = geometry(assistantAvatarStillModel(resolveAssistantAvatar(defaults[0])));
    for (const seed of defaults) {
      const recipe = resolveAssistantAvatar(seed);
      expect(recipe).toMatchObject({ shape: 'round', eyes: 'capsule', expression: 'neutral', animate: true });
      expect(geometry(assistantAvatarStillModel(recipe))).toBe(first);
    }
  });

  test('randomize can reach every pigment without changing the legacy random shape assignment', () => {
    const colors = new Set<string>();
    for (let i = 0; i < 256; i++) {
      const nonce = `random-${i}`;
      const seed = createRandomAssistantAvatarSeed(nonce);
      const recipe = resolveAssistantAvatar(seed);
      colors.add(recipe.color);
      expect(seed).toBe(createRandomAssistantAvatarSeed(nonce));
      expect(seed).toMatch(/^yuri-avatar:v1:/);
      expect(seed.length).toBeLessThanOrEqual(256);
      expect(recipe).toMatchObject({ ...resolveAssistantAvatar(nonce), color: recipe.color });
    }
    expect(colors).toEqual(new Set(AVATAR_COLORS));
  });

  test('uses the approved mixed palette, preserving all six existing pigments', () => {
    expect(Object.fromEntries(AVATAR_COLORS.map((color) => [color, assistantAvatarPigment(color)]))).toEqual({
      mint: '#9ed8bf', orange: '#f58332', iris: '#c4b9ee', jade: '#35bb81',
      coral: '#edb0a0', blue: '#4b8fe8', sky: '#a5cbe7', violet: '#9469e4',
      sand: '#e2c99b', rose: '#e76b9f', cyan: '#32b6ad', graphite: '#555c67',
    });
  });

  test.each(AVATAR_COLORS)('%s paints the same pigment in static and live SVG without changing geometry', (color) => {
    for (const shape of ['round', 'cloud'] as const) {
      const recipe = { ...resolveAssistantAvatar('palette'), shape, color };
      const pigment = assistantAvatarPigment(color);
      const still = assistantAvatarStillModel(recipe);
      expect(still.inkPaint).toBe(pigment);
      expect(still.cutout).toBe(color !== 'graphite');
      expect(geometry(still)).toBe(geometry(assistantAvatarStillModel({ ...recipe, color: 'mint' })));
      expect(assistantAvatarSvg(encodeAssistantAvatar(recipe))).toContain(`fill="${pigment}"`);
      const renderer = mountAssistantAvatarRenderer(document, `palette-${shape}-${color}`, recipe);
      const sample = createAssistantAvatarPlayer(recipe, 'palette', 'working').advance(1 / 30);
      renderer.paint(sample);
      expect(sample.model.inkPaint).toBe(pigment);
      expect(renderer.svg.outerHTML).toContain(`fill="${pigment}"`);
    }
  });

  test.each(AVATAR_SHAPES)('%s ignores obsolete eye/expression choices without destroying saved metadata', (shape) => {
    const base = { ...resolveAssistantAvatar('test'), shape };
    const expected = assistantAvatarSvg(encodeAssistantAvatar(base));
    for (const eyes of AVATAR_EYES) for (const expression of AVATAR_EXPRESSIONS) {
      const seed = encodeAssistantAvatar({ ...base, eyes, expression });
      expect(assistantAvatarSvg(seed)).toBe(expected);
      expect(resolveAssistantAvatar(seed)).toMatchObject({ eyes, expression });
    }
  });

  test.each(AVATAR_SHAPES)('%s exports finite local SVG and fits the same static/live artboard', (shape) => {
    for (const color of AVATAR_COLORS) {
      const recipe = { ...resolveAssistantAvatar('a'), shape, color };
      const svg = assistantAvatarSvg(encodeAssistantAvatar(recipe));
      expect(svg).not.toMatch(/NaN|Infinity|undefined|<script|<image|<animate|href=|@keyframes|var\(/);
      expect(svg).not.toContain('<metadata');
      expect(svg).toContain(`viewBox="${assistantAvatarArtboard(recipe).viewBox}"`);
      expect(svg).not.toContain('Open Mascot');
      for (const url of svg.matchAll(/url\(([^)]+)\)/g)) expect(['#avatar-holes', '#avatar-body']).toContain(url[1]);
    }
  });

  test.each([
    'yuri-avatar:v2:round:oval:mint:neutral:1:custom',
    'yuri-avatar:v1:round:oval:mint:neutral:1',
    'yuri-avatar:v1:round:oval:mint:neutral:1:custom:extra',
    'yuri-avatar:v1:round:oval:mint:neutral:yes:custom',
    'yuri-avatar:v1:round:oval:<script>:neutral:1:custom',
    'yuri-avatar:v1:unknown:oval:mint:neutral:1:custom',
    'yuri-avatar:v1:round:oval:mint:neutral:1:../../file',
  ])('invalid recipe stays opaque and cannot inject markup: %s', (seed) => {
    expect(AVATAR_SHAPES).toContain(resolveAssistantAvatar(seed).shape);
    expect(assistantAvatarSvg(seed)).not.toMatch(/<script|\.\.\/|href=|undefined|NaN/);
  });
});

describe('Anatomy animation integration', () => {
  test.each(AVATAR_SHAPES)('%s navigation eyes are opaque white or black in static and animated artwork', (shape) => {
    const recipe = { ...resolveAssistantAvatar('solid-eyes'), shape, color: 'sky' as const };
    const original = assistantAvatarStillModel(recipe);
    for (const eyeColor of ['white', 'black'] as const) {
      const paint = eyeColor === 'white' ? '#ffffff' : '#000000';
      const still = assistantAvatarStillModel(recipe, eyeColor);
      expect(still.cutout).toBe(false);
      expect(still.spotPaint).toBe(paint);
      expect(geometry(still)).toBe(geometry(original));
      const svg = assistantAvatarSvg(encodeAssistantAvatar(recipe), eyeColor);
      expect(svg).toContain(`fill="${paint}"`);
      expect(svg).not.toContain('mask="url(');
      const player = createAssistantAvatarPlayer(recipe, 'solid-eyes', 'idle', true, { eyeColor, randomizeShape: true });
      for (let i = 0; i < 60; i++) {
        const { model } = player.advance(0.1);
        expect(model.cutout).toBe(false);
        expect(model.spotPaint).toBe(paint);
      }
    }
    expect(assistantAvatarStillModel(recipe).cutout).toBe(true);
    expect(assistantAvatarStillModel({ ...recipe, color: 'graphite' }).spotPaint).toBe('#f2f4f7');
  });

  test.each(AVATAR_SHAPES)('%s graphite uses light eyes without changing eye geometry or its artboard', (shape) => {
    const base = { ...resolveAssistantAvatar('contrast'), shape, color: 'iris' as const };
    const dark = { ...base, color: 'graphite' as const };
    const cutout = assistantAvatarStillModel(base), painted = assistantAvatarStillModel(dark);
    expect(cutout.cutout).toBe(true);
    expect(painted.cutout).toBe(false);
    expect(painted.spotPaint).toBe('#f2f4f7');
    expect(geometry(painted)).toBe(geometry(cutout));
    expect(assistantAvatarArtboard(dark)).toEqual(assistantAvatarArtboard(base));
    expect(assistantAvatarSvg(encodeAssistantAvatar(dark))).toContain('fill="#f2f4f7"');
    expect(createAssistantAvatarPlayer(dark, 'contrast', 'idle').advance(1 / 30).model.spotPaint).toBe('#f2f4f7');
  });

  test.each(['idle', 'working'] as const)('round %s geometry is the reference output, without hand-tuned eye angles', (motion) => {
    const recipe = { ...resolveAssistantAvatar(createDefaultAssistantAvatarSeed('reference')), color: 'iris' as const };
    const config = makeConfig(recipes), generators = makeMorphGenerators(config), trail = makeTrail(config);
    const runtime = createRuntime(config, { body: 'sphere', isGazeAlways: true });
    let hash = 2166136261;
    for (const c of 'reference') hash = Math.imul(hash ^ c.charCodeAt(0), 16777619) >>> 0;
    const machine = createStateMachine(config, runtime, motion, { seed: hash, firstPhase: 0 });
    const player = createAssistantAvatarPlayer(recipe, 'reference', motion);
    for (let i = 0; i < 120; i++) {
      machine.advance(1 / 60); runtime.advance(1 / 60);
      const expected = buildModel(runtime.frame(), { ink: [0, 0, 0], spot: [0, 0, 0], cutout: true }, 256, config, generators, trail, () => { throw new Error('unexpected fallback'); });
      expect(geometry(player.advance(1 / 60).model)).toBe(geometry(expected));
    }
    const resting = createRuntime(config, { body: 'sphere' });
    createStateMachine(config, resting, 'idle', { isResting: true, seed: 1, firstPhase: 0 });
    resting.pause(); resting.seek(0);
    for (let i = 0; i < 60; i++) resting.advance(0.1);
    const frame = resting.frame();
    expect(frame.eyes?.map((eye) => eye.tilt)).toEqual([0, 0]);
    expect(frame.eyes?.map((eye) => eye.wid)).toEqual([0.13, 0.13]);
    const rest = buildModel(frame, { ink: [0, 0, 0], spot: [0, 0, 0], cutout: true }, 256, config, generators, trail, () => {});
    expect(geometry(assistantAvatarStillModel(recipe))).toBe(geometry(rest));
  });

  test.each(AVATAR_SHAPES)('%s animates all public states and returns from thinking without replacing its identity', (shape) => {
    const recipe = { ...resolveAssistantAvatar('states'), shape };
    const player = createAssistantAvatarPlayer(recipe, 'states', 'idle');
    const idle = player.advance(1 / 30).model;
    player.setMotion('thinking');
    let thinking = idle;
    for (let i = 0; i < 45; i++) thinking = player.advance(1 / 30).model;
    expect(thinking.mode).toBe('morph');
    if (thinking.mode === 'morph') expect(thinking.parts.length).toBeGreaterThan(0);
    for (const motion of ['happy', 'working', 'idle'] as const) {
      player.setMotion(motion);
      for (let i = 0; i < 30; i++) {
        const { model, bounds } = player.advance(1 / 30);
        expect(JSON.stringify(model)).not.toMatch(/NaN|Infinity|undefined/);
        expect(Object.values(bounds).every(Number.isFinite)).toBe(true);
        expect(model.inkPaint).toBe(idle.inkPaint);
      }
    }
    expect(geometry(thinking)).not.toBe(geometry(idle));
  });

  test.each(['round', 'star'] as const)('%s hover sways the head, cannot stack, and returns to the ongoing live pose', (shape) => {
    const recipe = { ...resolveAssistantAvatar('hover'), shape };
    const baseline = createAssistantAvatarPlayer(recipe, 'hover', 'working');
    const once = createAssistantAvatarPlayer(recipe, 'hover', 'working');
    const repeated = createAssistantAvatarPlayer(recipe, 'hover', 'working');
    once.hover(); repeated.hover();
    let differed = false;
    const scales: number[] = [];
    for (let i = 0; i < 60; i++) {
      if (i < 30) repeated.hover();
      const a = baseline.advance(1 / 60), b = once.advance(1 / 60), c = repeated.advance(1 / 60);
      scales.push(b.hoverScale);
      expect(c.hoverScale).toBe(b.hoverScale);
      expect(geometry(c.model)).toBe(geometry(b.model));
      if (geometry(a.model) !== geometry(b.model)) differed = true;
      if (i >= 40) {
        expect(geometry(b.model)).toBe(geometry(a.model));
        expect(b.hoverScale).toBe(1);
      }
      if (c.model.mode === 'morph') expect(c.model.parts).toHaveLength(0);
    }
    expect(differed).toBe(true);
    expect(Math.min(...scales)).toBeLessThan(0.83);
    expect(Math.max(...scales)).toBeGreaterThan(1.03);
  });

  test('whole-avatar hover shrink remains visible even when the pose already needs containment fitting', () => {
    const recipe = resolveAssistantAvatar(createDefaultAssistantAvatarSeed('scale'));
    const renderer = mountAssistantAvatarRenderer(document, 'fit-scale', recipe);
    const sample = createAssistantAvatarPlayer(recipe, 'scale', 'working').advance(0);
    const bounds = { x0: -500, y0: -500, x1: 500, y1: 500 };
    const scale = () => Number(renderer.svg.querySelector(':scope > g')!.getAttribute('transform')!.match(/scale\(([^)]+)\)/)![1]);
    renderer.paint({ ...sample, bounds, hoverScale: 1 });
    const fitted = scale();
    expect(fitted).toBeLessThan(1);
    renderer.paint({ ...sample, bounds, hoverScale: 0.82 });
    expect(scale() / fitted).toBeCloseTo(0.82);
    renderer.paint({ ...sample, bounds, hoverScale: 1.04 });
    expect(scale()).toBeLessThanOrEqual(fitted);
  });

  test('non-sphere mesh projection preserves concave boundaries and hides back-facing eyes', () => {
    const config = makeConfig(recipes), rt = createRuntime(config);
    createStateMachine(config, rt, 'idle', { isResting: true });
    rt.pause(); rt.seek(0); for (let i = 0; i < 60; i++) rt.advance(0.1);
    const frame: Frame = { ...rt.frame(), quat: lb(0, 0, 0) };
    const star = buildAvatarBody(frame, 256, config, 'star');
    const cloud = buildAvatarBody(frame, 256, config, 'cloud');
    expect(star.body.length).toBeGreaterThan(1);
    expect(cloud.body.length).toBeGreaterThan(1);
    expect(star.body).not.toEqual(cloud.body);
    expect(star.eyes.length).toBe(2);
    const back = buildAvatarBody({ ...frame, quat: lb(0, Math.PI, 0) }, 256, config, 'star');
    expect(back.eyes).toEqual([]);
    expect(() => buildAvatarBody(frame, 256, config, 'unknown')).toThrow('Unsupported avatar geometry');
  });

  test.each(AVATAR_SHAPES.filter((shape) => shape !== 'round'))('%s compact outlines retain reference silhouette samples without full morph mixing', (shape) => {
    const config = makeConfig(recipes), rt = createRuntime(config);
    createStateMachine(config, rt, 'idle', { isResting: true });
    rt.pause(); rt.seek(0); for (let i = 0; i < 60; i++) rt.advance(0.1);
    const name = AVATAR_BODY_NAMES[shape], generators = makeMorphGenerators(config), trail = makeTrail(config);
    for (const quat of [rt.frame().quat, lb(0, 0, 0), lb(0, Math.PI / 2, 0)]) {
      const frame: Frame = { ...rt.frame(), quat, body: name, bodies: [{ body: name, weight: 1 }] };
      const body = buildAvatarBody(frame, 256, config, name), compact = compactAvatarOutline(body);
      const full = buildModel(frame, { ink: [0, 0, 0], spot: [0, 0, 0], cutout: true }, 256, config, generators, trail, () => {}, buildAvatarBody);
      expect(full.mode).toBe('morph');
      if (full.mode !== 'morph') throw new Error('Expected non-sphere model');
      expect(compact.length).toBeLessThanOrEqual(192);
      for (const [x, y] of compact) {
        expect(full.bodyPts.some(([a, b]) => Math.hypot(x - a, y - b) < 1e-4)).toBe(true);
      }
    }
  });

  test('vendored data is pinned and the player has only the documented geometry callback patch', () => {
    const hash = (s: string | Buffer) => createHash('sha256').update(s).digest('hex');
    const player = readFileSync(join(source, 'player.js'), 'utf8')
      .replace('function buildModel(e, t, n, G, gE, tE, warnBody, buildBody)', 'function buildModel(e, t, n, G, gE, tE, warnBody)')
      .replace('    if (c !== "sphere" && buildBody) return { shape: buildBody(e, n, G, c), weight: u };\n', '');
    const original = readFileSync(join(source, 'grok-recipes.json'));
    expect(hash(player)).toBe('41d6646094609426fc14324a1cc7082f1f75c5a4659af628880387e508e6bbc7');
    expect(hash(original)).toBe('3af2702c600cbfed18d5b3c99f0e002490e1be2656b08d15255e2731ddc442e0');
  });
});
