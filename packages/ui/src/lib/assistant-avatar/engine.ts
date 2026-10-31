import {
  buildModel, createRenderer, createRuntime, createStateMachine, makeConfig, makeMorphGenerators, makeTrail,
  type Frame, type Model, type MorphModel, type Point, type Theme, type Vector,
} from './vendor/grok-anatomy/player.js';
import recipes from './vendor/grok-anatomy/grok-recipes.json';
import { buildAvatarBody, compactAvatarOutline } from './geometry';
import { AVATAR_PICKER_SHAPES, resolveAssistantAvatar, type AssistantAvatarRecipe, type AvatarMotion, type AvatarEyeColor } from './recipe';
import { AVATAR_BODY_NAMES, type AvatarShape } from './catalog';

const AVATAR_RENDER_SIZE = 256;
const config = makeConfig(recipes);
// Pure, bounded, catalog-level data. Never regenerate the pencil trail or morph
// generators for each contact or each rendered frame.
const generators = makeMorphGenerators(config);
const trail = makeTrail(config);
const pigments = {
  mint: '#9ed8bf', orange: '#f58332', iris: '#c4b9ee', jade: '#35bb81',
  coral: '#edb0a0', blue: '#4b8fe8', sky: '#a5cbe7', violet: '#9469e4',
  sand: '#e2c99b', rose: '#e76b9f', cyan: '#32b6ad', graphite: '#555c67',
} as const satisfies Record<AssistantAvatarRecipe['color'], string>;
export const assistantAvatarPigment = (color: AssistantAvatarRecipe['color']): string => pigments[color];
const rgb = (hex: string): Vector => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255) as Vector;
const themeFor = (recipe: AssistantAvatarRecipe, eyeColor?: AvatarEyeColor): Theme => ({
  ink: rgb(pigments[recipe.color]),
  spot: eyeColor ? (eyeColor === 'white' ? [1, 1, 1] : [0, 0, 0]) : recipe.color === 'graphite' ? rgb('#f2f4f7') : [0, 0, 0],
  cutout: !eyeColor && recipe.color !== 'graphite',
});
const unsupportedBody = (body: string): never => { throw new Error(`Avatar body was not implemented: ${body}`); };
const hex = (color: Vector) => `#${color.map((value) => Math.round(value * 255).toString(16).padStart(2, '0')).join('')}`;
function modelFor(frame: Frame, theme: Theme, compact = false): Model {
  if (compact && !frame.morph && frame.bodies.length === 1 && frame.bodies[0].body !== 'sphere') {
    const body = buildAvatarBody(frame, AVATAR_RENDER_SIZE, config, frame.bodies[0].body);
    return {
      mode: 'morph', size: AVATAR_RENDER_SIZE, center: body.center,
      bodyPts: compactAvatarOutline(body), eyesPts: body.eyes,
      head: null, parts: [], markScale: config.$n * AVATAR_RENDER_SIZE / 2 / config.x,
      zoom: 1, inkPaint: hex(theme.ink), spotPaint: hex(theme.spot), cutout: theme.cutout,
    };
  }
  return buildModel(frame, theme, AVATAR_RENDER_SIZE, config, generators, trail, unsupportedBody, buildAvatarBody);
}
const restModels = new Map<AvatarShape, { frame: Frame; cutout: Model; painted?: Model }>();

export function assistantAvatarStillModel(recipe: AssistantAvatarRecipe, eyeColor?: AvatarEyeColor): Model {
  let rest = restModels.get(recipe.shape);
  if (!rest) {
    const runtime = createRuntime(config, { body: AVATAR_BODY_NAMES[recipe.shape] });
    createStateMachine(config, runtime, 'idle', { isResting: true, seed: 1, firstPhase: 0 });
    // Same deterministic settle sequence as the reference static renderer.
    runtime.pause();
    runtime.seek(0);
    for (let i = 0; i < 60; i++) runtime.advance(0.1);
    const frame = runtime.frame();
    rest = { frame, cutout: modelFor(frame, { ink: [0, 0, 0], spot: [0, 0, 0], cutout: true }) };
    restModels.set(recipe.shape, rest);
  }
  const theme = themeFor(recipe, eyeColor);
  const model = theme.cutout ? rest.cutout : (rest.painted ??= modelFor(rest.frame, { ...theme, ink: [0, 0, 0] }));
  return { ...model, inkPaint: pigments[recipe.color], spotPaint: hex(theme.spot) };
}

type Bounds = { x0: number; y0: number; x1: number; y1: number };
const boundsOf = (points: Point[]): Bounds => ({
  x0: Math.min(...points.map((p) => p[0])), y0: Math.min(...points.map((p) => p[1])),
  x1: Math.max(...points.map((p) => p[0])), y1: Math.max(...points.map((p) => p[1])),
});
const sphereBounds = (frame?: Frame): Bounds => {
  const radius = (frame?.zoom ?? config.$n) * AVATAR_RENDER_SIZE / 2;
  const [sx, sy] = frame?.squash ?? [1, 1], [dx, dy] = frame?.offset ?? [0, 0];
  const cx = AVATAR_RENDER_SIZE / 2 + radius * dx;
  const cy = AVATAR_RENDER_SIZE / 2 - radius * ((frame?.squashAnchor ?? 0) * (1 - sy) + dy);
  return { x0: cx - Math.abs(radius * sx), x1: cx + Math.abs(radius * sx), y0: cy - Math.abs(radius * sy), y1: cy + Math.abs(radius * sy) };
};
function morphBounds(model: MorphModel): Bounds {
  const zoomCenter = model.size / 2 + (config.IT - config.x) * model.markScale;
  const zoom = ([x, y]: Point): Point => [zoomCenter + (x - zoomCenter) * model.zoom, zoomCenter + (y - zoomCenter) * model.zoom];
  const points: Point[] = model.bodyPts.map(([x, y]) => {
    if (!model.head) return zoom([x, y]);
    const h = model.head, a = h.rotation * Math.PI / 180;
    const dx = (x - model.center[0]) * h.scale, dy = (y - model.center[1]) * h.scale;
    return zoom([model.center[0] + h.translate[0] + Math.cos(a) * dx - Math.sin(a) * dy, model.center[1] + h.translate[1] + Math.sin(a) * dx + Math.cos(a) * dy]);
  });
  for (const part of model.parts) {
    // Yuri's exposed thinking state uses the reference disc generator. Other
    // decorative states remain internal, not silently exposed without bounds.
    if (part.type !== 'disc' && part.type !== 'ring') continue;
    const r = part.r + (part.type === 'ring' ? part.width / 2 : 0);
    const x = model.size / 2 + (part.cx - config.x) * model.markScale;
    const y = model.size / 2 + (part.cy - config.x) * model.markScale;
    const extent = r * model.markScale;
    points.push(zoom([x - extent, y - extent]), zoom([x + extent, y + extent]));
  }
  return boundsOf(points);
}

const artboards = new Map<AvatarShape, { cx: number; cy: number; size: number; viewBox: string }>();
export function assistantAvatarArtboard(recipe: AssistantAvatarRecipe) {
  let board = artboards.get(recipe.shape);
  if (!board) {
    const model = assistantAvatarStillModel(recipe);
    const b = model.mode === 'sphere' ? sphereBounds() : boundsOf(model.bodyPts);
    const cx = (b.x0 + b.x1) / 2, cy = (b.y0 + b.y1) / 2;
    const size = Math.max(b.x1 - b.x0, b.y1 - b.y0) / 0.94;
    board = { cx, cy, size, viewBox: [cx - size / 2, cy - size / 2, size, size].map((n) => n.toFixed(3)).join(' ') };
    artboards.set(recipe.shape, board);
  }
  return board;
}

export function createAssistantAvatarTimeline(recipe: AssistantAvatarRecipe, seed: string, motion: AvatarMotion, compact = false, { randomizeShape = false, resting = false }: { randomizeShape?: boolean; resting?: boolean } = {}) {
  const runtime = createRuntime(config, { body: AVATAR_BODY_NAMES[recipe.shape], isGazeAlways: true });
  let hash = 2166136261;
  for (let i = 0; i < seed.length; i++) hash = Math.imul(hash ^ seed.charCodeAt(i), 16777619) >>> 0;
  const machine = createStateMachine(config, runtime, motion, { seed: hash, firstPhase: 0, isCompact: compact, isResting: resting });
  if (resting) {
    runtime.pause();
    runtime.seek(0);
    for (let i = 0; i < 60; i++) runtime.advance(0.1);
  }
  let shape = recipe.shape;
  let nextShapeIn = randomizeShape ? 4 + Math.random() * 3 : Infinity;
  return {
    setMotion: (next: AvatarMotion) => machine.setState(next),
    setCompact: (next: boolean) => machine.setCompact(next),
    setGaze: (point: Point | null) => runtime.setGaze(point),
    blink: () => runtime.blink(),
    advance(dt: number) {
      // Bounded fixed substeps keep springs deterministic at 30Hz and prevent
      // a resumed/late frame from replaying an unbounded wall-clock backlog.
      let left = Math.min(0.1, Math.max(0, dt));
      while (left > 1e-8) {
        const step = Math.min(left, 1 / 60);
        if (randomizeShape && (nextShapeIn -= step) <= 0) {
          const choices = AVATAR_PICKER_SHAPES.filter((candidate) => candidate !== shape);
          shape = choices[Math.floor(Math.random() * choices.length)];
          runtime.setBody(AVATAR_BODY_NAMES[shape]);
          nextShapeIn = 4 + Math.random() * 3;
        }
        machine.advance(step);
        runtime.advance(step);
        left -= step;
      }
      return runtime.frame();
    },
  };
}

export function createAssistantAvatarPlayer(recipe: AssistantAvatarRecipe, seed: string, motion: AvatarMotion, compact = false, { randomizeShape = false, eyeColor, resting = false }: { randomizeShape?: boolean; eyeColor?: AvatarEyeColor; resting?: boolean } = {}) {
  const timeline = createAssistantAvatarTimeline(recipe, seed, motion, compact, { randomizeShape, resting });
  const theme = themeFor(recipe, eyeColor);
  let hoverTime: number | null = null;
  return {
    setMotion: timeline.setMotion,
    setCompact: (next: boolean) => { compact = next; timeline.setCompact(next); },
    setGaze: timeline.setGaze,
    blink: timeline.blink,
    hover: () => { hoverTime ??= 0; },
    advance(dt: number, sharedFrame?: Frame) {
      const frame = sharedFrame ? { ...sharedFrame } : timeline.advance(dt);
      if (hoverTime !== null) {
        let left = Math.min(0.1, Math.max(0, dt));
        while (left > 1e-8) {
          const step = Math.min(left, 1 / 60);
          hoverTime += step;
          left -= step;
        }
      }
      let hoverScale = 1;
      if (hoverTime !== null) {
        const phase = hoverTime / 0.65;
        if (phase >= 1) hoverTime = null;
        else {
          hoverScale = phase < 0.55
            ? 1 - 0.18 * Math.sin(phase / 0.55 * Math.PI) ** 2
            : 1 + 0.04 * Math.sin((phase - 0.55) / 0.45 * Math.PI) ** 2;
          // A bounded hover sway rotates the whole head quaternion, never the
          // eye descriptors. Its smooth envelope starts/ends at the live pose.
          const roll = Math.sin(phase * Math.PI * 4) * Math.sin(phase * Math.PI) ** 2 * 0.12;
          const c = Math.cos(roll / 2), s = Math.sin(roll / 2), [w, x, y, z] = frame.quat;
          frame.quat = [c * w - s * z, c * x - s * y, c * y + s * x, c * z + s * w];
        }
      }
      const model = modelFor(frame, theme, compact);
      return { model, bounds: model.mode === 'sphere' ? sphereBounds(frame) : morphBounds(model), hoverScale, hovering: hoverTime !== null };
    },
  };
}

export function mountAssistantAvatarRenderer(doc: Document, uid: string, recipe: AssistantAvatarRecipe, eyeColor?: AvatarEyeColor) {
  const renderer = createRenderer(doc, uid, AVATAR_RENDER_SIZE, config);
  const board = assistantAvatarArtboard(recipe);
  renderer.svg.setAttribute('viewBox', board.viewBox);
  renderer.svg.setAttribute('width', '100%');
  renderer.svg.setAttribute('height', '100%');
  renderer.svg.classList.add('size-full');
  const fit = doc.createElementNS('http://www.w3.org/2000/svg', 'g');
  const content = renderer.svg.querySelector(':scope > g')!;
  renderer.svg.append(fit);
  fit.append(content);
  const still = () => {
    fit.removeAttribute('transform');
    renderer.render(assistantAvatarStillModel(recipe, eyeColor));
  };
  still();
  return {
    svg: renderer.svg,
    still,
    paint({ model, bounds, hoverScale }: ReturnType<ReturnType<typeof createAssistantAvatarPlayer>['advance']>) {
      // Fit the whole posed scene, never individual eyes. Quiet/rest artwork
      // fills 94%; excursions shrink uniformly only when needed to avoid cuts.
      const extent = Math.max(Math.abs(bounds.x0 - board.cx), Math.abs(bounds.x1 - board.cx), Math.abs(bounds.y0 - board.cy), Math.abs(bounds.y1 - board.cy));
      const maxScale = board.size / 2 * 0.98 / Math.max(extent, 1e-6);
      // Apply hover after fitting, so containment cannot cancel the shrink.
      // The small overshoot uses available room rather than clipping the face.
      const scale = Math.min(Math.min(1, maxScale) * hoverScale, maxScale);
      fit.setAttribute('transform', `translate(${board.cx} ${board.cy}) scale(${scale}) translate(${-board.cx} ${-board.cy})`);
      renderer.render(model);
    },
  };
}

const path = (points: Point[]) => points.length ? `M${points.map(([x, y]) => `${x.toFixed(2)} ${y.toFixed(2)}`).join('L')}Z` : '';

/** Pure export: works in server/SSR as well as browser/native PNG generation. */
export function assistantAvatarSvg(seed: string | undefined, eyeColor?: AvatarEyeColor): string {
  const recipe = resolveAssistantAvatar(seed);
  const model = assistantAvatarStillModel(recipe, eyeColor), board = assistantAvatarArtboard(recipe);
  const start = `<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="${board.viewBox}">`;
  if (model.mode === 'sphere') return `${start}<path d="${model.bodyD}" fill="${model.inkPaint}" fill-rule="evenodd"/>${model.eyesD ? `<path d="${model.eyesD}" fill="${model.spotPaint}"/>` : ''}</svg>`;
  const eyes = model.eyesPts.map(path).join('');
  const body = path(model.bodyPts);
  if (model.cutout) return `${start}<defs><mask id="avatar-holes" maskUnits="userSpaceOnUse" x="0" y="0" width="256" height="256"><rect width="256" height="256" fill="white"/><path d="${eyes}" fill="black"/></mask></defs><path d="${body}" fill="${model.inkPaint}" fill-rule="evenodd" mask="url(#avatar-holes)"/></svg>`;
  return `${start}<defs><clipPath id="avatar-body"><path d="${body}"/></clipPath></defs><path d="${body}" fill="${model.inkPaint}" fill-rule="evenodd"/><path d="${eyes}" fill="${model.spotPaint}" clip-path="url(#avatar-body)"/></svg>`;
}
