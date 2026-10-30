import { Et, ST, ir, kT, xT, type Body, type Config, type Frame, type Matrix, type Point, type Vector } from './vendor/grok-anatomy/player.js';
import recipes from './vendor/grok-anatomy/grok-recipes.json';
import { AVATAR_SHAPES, AVATAR_BODY_NAMES, type AvatarShape } from './catalog';

// Independent implementation of the Anatomy shape chapter: authored 2D outline
// -> solid / beveled extrusion / loft -> quaternion projection -> surface seat.
// The missing shape renderer is not replaced with a CSS tilt or sphere fallback.
const TAU = Math.PI * 2;
const N = 96;
type Kind = 'solid' | 'extrusion' | 'loft';
type Mesh = {
  kind: Kind; vertices: Vector[]; normals: Vector[];
  edges: Array<{ a: number; b: number; faces: number[] }>;
  radial: number[]; depth: number; eyeMetric: { width: number; height: number; gap: number; shiftY: number };
};
const polar = (radius: (a: number) => number): Point[] => Array.from({ length: N }, (_, i) => {
  const a = i / N * TAU, r = radius(a);
  return [Math.cos(a) * r, Math.sin(a) * r];
});
const superellipse = (a: number, b: number, exponent: number): Point[] =>
  Array.from({ length: N }, (_, i) => {
    const t = i / N * TAU, c = Math.cos(t), s = Math.sin(t);
    return [Math.sign(c) * Math.abs(c) ** (2 / exponent) * a, Math.sign(s) * Math.abs(s) ** (2 / exponent) * b];
  });

// ac(): quadratic rounded corners, as documented; sample once in model space.
function rounded(points: Point[], radius: number): Point[] {
  return points.flatMap((p, i) => {
    const prev = points[(i - 1 + points.length) % points.length], next = points[(i + 1) % points.length];
    const near = (q: Point): Point => {
      const length = Math.hypot(q[0] - p[0], q[1] - p[1]);
      const k = Math.min(radius / length, 0.4);
      return [p[0] + (q[0] - p[0]) * k, p[1] + (q[1] - p[1]) * k];
    };
    const a = near(prev), b = near(next);
    return Array.from({ length: 8 }, (_, j): Point => {
      const t = j / 7, u = 1 - t;
      return [u * u * a[0] + 2 * u * t * p[0] + t * t * b[0], u * u * a[1] + 2 * u * t * p[1] + t * t * b[1]];
    });
  });
}
function polygon(sides: number, inner = 114, radius = 20, phase = -Math.PI / 2): Point[] {
  return rounded(Array.from({ length: sides * (inner === 114 ? 1 : 2) }, (_, i): Point => {
    const a = phase + i / (sides * (inner === 114 ? 1 : 2)) * TAU;
    const r = i % 2 ? inner : 114;
    return [Math.cos(a) * r, Math.sin(a) * r];
  }), radius);
}
// th(): ray / circle-union intersections retain the cloud's concave valleys.
function circleUnion(circles: Array<[number, number, number]>): Point[] {
  return polar((a) => {
    let reach = 0;
    for (const [x, y, r] of circles) {
      const d = Math.cos(a) * x + Math.sin(a) * y;
      const h = d * d - x * x - y * y + r * r;
      if (h > 0) reach = Math.max(reach, d + Math.sqrt(h));
    }
    return reach;
  });
}
const outline = (shape: AvatarShape): Point[] => {
  switch (shape) {
    case 'square': return rounded([[-107, -107], [107, -107], [107, 107], [-107, 107]], 28);
    case 'soft': return superellipse(107, 107, 3.2);
    case 'cloud': return circleUnion([[-62, 26, 56], [62, 26, 54], [0, 34, 62], [-24, -30, 62], [38, -26, 54]]);
    case 'flower': return circleUnion(Array.from({ length: 6 }, (_, i) => [Math.cos(i / 6 * TAU) * 58, Math.sin(i / 6 * TAU) * 58, 58]));
    case 'clover': return circleUnion([[-38, -38, 58], [38, -38, 58], [38, 38, 58], [-38, 38, 58]]);
    case 'star': return polygon(6, 62, 12);
    case 'sparkle': return polygon(4, 43, 14);
    case 'hexagon': return polygon(6, 114, 20, Math.PI / 6);
    case 'diamond': return polygon(4, 114, 20);
    case 'triangle': return polygon(3, 114, 26);
    // Independently authored contours where the article only names a generator.
    case 'heart': return Array.from({ length: N }, (_, i) => {
      const t = i / N * TAU;
      return [16 * Math.sin(t) ** 3, -(13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t))];
    });
    case 'shield': return rounded([[-98, -93], [98, -93], [90, 28], [55, 81], [0, 115], [-55, 81], [-90, 28]], 30);
    case 'leaf': return Array.from({ length: N }, (_, i) => {
      const t = i / N * TAU;
      return [Math.sign(Math.cos(t)) * Math.cos(t) ** 2 * 88, Math.sin(t) * 113];
    });
    case 'drop': return Array.from({ length: N }, (_, i) => {
      const t = i / N * TAU;
      return [Math.sin(t) * Math.sqrt((1 - Math.cos(t)) / 2) * 98, -Math.cos(t) * 113];
    });
    case 'tall': return superellipse(72, 113, 2);
    case 'wide': return superellipse(114, 74, 3.2);
    case 'compact': return superellipse(100, 96, 2.4);
    case 'large': return superellipse(110, 114, 2.6);
    case 'round': return superellipse(114, 114, 2);
  }
};

const cross = (a: Vector, b: Vector, c: Vector): Vector => {
  const u = b.map((v, i) => v - a[i]), v = c.map((v, i) => v - a[i]);
  return [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
};
function radialProfile(points: Point[]): number[] {
  return Array.from({ length: 192 }, (_, i) => {
    const a = i / 192 * TAU, dx = Math.cos(a), dy = Math.sin(a);
    let best = 0;
    for (let j = 0; j < points.length; j++) {
      const p = points[j], q = points[(j + 1) % points.length], ex = q[0] - p[0], ey = q[1] - p[1];
      const det = dx * ey - dy * ex;
      if (Math.abs(det) < 1e-9) continue;
      const t = (p[0] * ey - p[1] * ex) / det, u = (p[0] * dy - p[1] * dx) / det;
      if (t >= 0 && u >= -1e-8 && u <= 1 + 1e-8) best = Math.max(best, t);
    }
    return best;
  });
}
function makeMesh(shape: AvatarShape): Mesh {
  const raw = outline(shape);
  const xs = raw.map((p) => p[0]), ys = raw.map((p) => p[1]);
  const cx = (Math.min(...xs) + Math.max(...xs)) / 2, cy = (Math.min(...ys) + Math.max(...ys)) / 2;
  const scale = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)) / 2;
  let points: Point[] = raw.map(([x, y]) => [(x - cx) / scale, -(y - cy) / scale]);
  const area = points.reduce((a, p, i) => a + p[0] * points[(i + 1) % points.length][1] - p[1] * points[(i + 1) % points.length][0], 0);
  if (area < 0) points = points.reverse();
  // Equal-angle sampling bounds mesh cost independently of corner count.
  const radial = radialProfile(points);
  points = Array.from({ length: N }, (_, i) => {
    const a = i / N * TAU, r = radial[i * 2];
    return [Math.cos(a) * r, Math.sin(a) * r];
  });
  const kind: Kind = ['cloud', 'heart'].includes(shape) ? 'loft'
    : ['square', 'flower', 'star', 'clover', 'hexagon', 'diamond', 'triangle', 'sparkle'].includes(shape) ? 'extrusion' : 'solid';
  const depth = kind === 'extrusion' ? 0.36 : 0.72;
  const layers: Array<{ z: number; scale: number }> = [];
  if (kind === 'extrusion') {
    const u = Math.max(0.1, Math.min(Math.max(...points.map((p) => Math.abs(p[0]))), Math.max(...points.map((p) => Math.abs(p[1])))));
    for (const sign of [-1, 1]) for (let j = 0; j <= 4; j++) {
      const i = sign < 0 ? 4 - j : j, a = i / 4 * Math.PI / 2;
      layers.push({ z: sign * (depth - 0.22 + 0.22 * Math.sin(a)), scale: 1 - 0.22 / u * (1 - Math.cos(a)) });
    }
  } else {
    for (let i = 0; i <= 16; i++) {
      const a = -Math.PI / 2 + i / 16 * Math.PI;
      layers.push({ z: depth * Math.sin(a), scale: Math.max(1e-5, Math.cos(a)) ** 0.72 });
    }
  }
  const vertices: Vector[] = layers.flatMap(({ z, scale }) => points.map(([x, y]): Vector => [x * scale, y * scale, z]));
  const faces: number[][] = [];
  for (let ring = 0; ring < layers.length - 1; ring++) for (let i = 0; i < N; i++) {
    const next = (i + 1) % N;
    faces.push([ring * N + i, ring * N + next, (ring + 1) * N + next, (ring + 1) * N + i]);
  }
  faces.push(Array.from({ length: N }, (_, i) => N - 1 - i));
  faces.push(Array.from({ length: N }, (_, i) => (layers.length - 1) * N + i));
  const normals = faces.map((face) => cross(vertices[face[0]], vertices[face[1]], vertices[face[2]]));
  const edges = new Map<string, Mesh['edges'][number]>();
  faces.forEach((face, index) => face.forEach((a, i) => {
    const b = face[(i + 1) % face.length], key = a < b ? `${a}:${b}` : `${b}:${a}`;
    const edge = edges.get(key);
    if (edge) edge.faces.push(index); else edges.set(key, { a, b, faces: [index] });
  }));
  const name = AVATAR_BODY_NAMES[shape];
  const metrics = recipes.shapes.eyeMetrics;
  const eyeMetric = Object.hasOwn(metrics, name) ? metrics[name as keyof typeof metrics] : metrics.squircle;
  return { kind, vertices, normals, edges: [...edges.values()], radial, depth, eyeMetric };
}

// Lazy finite catalog: the default round Bot allocates no non-sphere meshes.
// At most eighteen entries, never keyed by user/contact identity; no DOM sampling.
const meshes = new Map<AvatarShape, Mesh>();
const bodyShapes = new Map(AVATAR_SHAPES.map((shape) => [AVATAR_BODY_NAMES[shape], shape]));
const identity: Matrix = [1, 0, 0, 0, 1, 0, 0, 0, 1];
function radiusAt(mesh: Mesh, x: number, y: number): number {
  const a = (Math.atan2(y, x) + TAU) % TAU / TAU * mesh.radial.length;
  const i = Math.floor(a), f = a - i;
  return mesh.radial[i] * (1 - f) + mesh.radial[(i + 1) % mesh.radial.length] * f;
}
function surfaceZ(mesh: Mesh, x: number, y: number): number {
  if (mesh.kind === 'extrusion') return mesh.depth;
  const r = radiusAt(mesh, x, y), fraction = Math.min(1, Math.hypot(x, y) / Math.max(r, 1e-6));
  return mesh.depth * Math.sqrt(Math.max(0, 1 - fraction ** (2 / 0.72)));
}
function convexHull(points: Point[]): Point[] {
  const sorted = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const side = (a: Point, b: Point, c: Point) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  const half = (input: Point[]) => {
    const out: Point[] = [];
    for (const p of input) {
      while (out.length >= 2 && side(out[out.length - 2], out[out.length - 1], p) <= 0) out.pop();
      out.push(p);
    }
    out.pop();
    return out;
  };
  return [...half(sorted), ...half(sorted.reverse())];
}

export function buildAvatarBody(frame: Frame, size: number, config: Config, shape: string): Body {
  const key = bodyShapes.get(shape) ?? (AVATAR_SHAPES.includes(shape as AvatarShape) ? shape as AvatarShape : undefined);
  if (!key || key === 'round') throw new Error(`Unsupported avatar geometry: ${shape}`);
  let mesh = meshes.get(key);
  if (!mesh) { mesh = makeMesh(key); meshes.set(key, mesh); }
  const matrix = ir(frame.quat), radius = frame.zoom * size / 2;
  const center: Point = [size / 2 + radius * frame.offset[0], size / 2 - radius * (frame.squashAnchor * (1 - frame.squash[1]) + frame.offset[1])];
  const project = (v: Vector): Point => {
    const p = Et(matrix, v);
    return [center[0] + p[0] * radius * frame.squash[0], center[1] - p[1] * radius * frame.squash[1]];
  };
  // Interior mesh vertices cannot contribute to the projected silhouette. Find
  // its edges in model space first, then project only their referenced vertices.
  const projected: Array<Point | undefined> = new Array(mesh.vertices.length);
  const vertex = (i: number): Point => projected[i] ??= project(mesh.vertices[i]);
  const front = mesh.normals.map((n) => matrix[6] * n[0] + matrix[7] * n[1] + matrix[8] * n[2] >= 0);
  let body: Point[][] = mesh.edges.filter((edge) => edge.faces.length === 1 || front[edge.faces[0]] !== front[edge.faces[1]])
    .map(({ a, b }) => [vertex(a), vertex(b)]);
  if (mesh.kind === 'solid') body = [convexHull(body.flat())];
  const eyes: Point[][] = [];
  frame.eyes?.forEach((eye, side) => {
    const metric = mesh.eyeMetric;
    for (const ring of ST(eye, config.eyeBasis[side], config.eyeMirror[side], identity, radius)) {
      const seated = xT(ring, kT).map(([sx, sy]) => {
        const x = (sx - (side === 0 ? -0.31 : 0.31)) * metric.width / 0.25 + (side === 0 ? -1 : 1) * metric.gap / 2;
        const y = sy * metric.height / 0.562 - metric.shiftY;
        const point: Vector = [x, y, surfaceZ(mesh, x, y)];
        const d = 1e-3;
        const normal: Vector = mesh.kind === 'extrusion' ? [0, 0, 1] : [
          (surfaceZ(mesh, x - d, y) - surfaceZ(mesh, x + d, y)) / (2 * d),
          (surfaceZ(mesh, x, y - d) - surfaceZ(mesh, x, y + d)) / (2 * d), 1,
        ];
        return { point, visibility: Et(matrix, normal)[2] };
      });
      // Clip in model space at the surface horizon, before SVG body clipping.
      const clipped: Vector[] = [];
      seated.forEach((p, i) => {
        const q = seated[(i + 1) % seated.length];
        if (p.visibility >= 0) clipped.push(p.point);
        if ((p.visibility >= 0) !== (q.visibility >= 0)) {
          const t = p.visibility / (p.visibility - q.visibility);
          clipped.push(p.point.map((v, j) => v + (q.point[j] - v) * t) as Vector);
        }
      });
      if (clipped.length >= 3) eyes.push(clipped.map(project));
    }
  });
  return { center, radius: Math.abs(radius), body, eyes };
}

const compactRays: Point[] = Array.from({ length: 192 }, (_, i) => [Math.cos(i / 192 * TAU), Math.sin(i / 192 * TAU)]);

/** A single compact body needs no cross-body/morph mixing or per-frame angle
 * sorting. Retain solid hull vertices exactly; concave bodies use the reference
 * 192 base rays, without duplicating each silhouette segment in both directions. */
export function compactAvatarOutline({ center, body }: Body): Point[] {
  if (body.length === 1) return body[0];
  const buckets: Array<Array<[Point, Point]>> = Array.from({ length: compactRays.length }, () => []);
  const angle = ([x, y]: Point) => (Math.atan2(y - center[1], x - center[0]) + TAU) % TAU;
  for (const ring of body) for (let i = 0; i < (ring.length === 2 ? 1 : ring.length); i++) {
    const a = ring[i], b = ring[(i + 1) % ring.length], start = angle(a);
    let sweep = angle(b) - start;
    if (sweep > Math.PI) sweep -= TAU;
    if (sweep < -Math.PI) sweep += TAU;
    const lo = Math.floor(Math.min(start, start + sweep) / TAU * buckets.length) - 1;
    const hi = Math.ceil(Math.max(start, start + sweep) / TAU * buckets.length) + 1;
    const edge: [Point, Point] = [a, b];
    for (let j = lo; j <= hi; j++) buckets[(j % buckets.length + buckets.length) % buckets.length].push(edge);
  }
  return compactRays.map(([dx, dy], i): Point => {
    let reach = 0;
    for (const [a, b] of buckets[i]) {
      const ex = b[0] - a[0], ey = b[1] - a[1], det = dx * ey - dy * ex;
      if (Math.abs(det) < 1e-12) continue;
      const px = a[0] - center[0], py = a[1] - center[1];
      const t = (px * ey - py * ex) / det, u = (px * dy - py * dx) / det;
      if (t >= 0 && u >= -1e-9 && u <= 1 + 1e-9) reach = Math.max(reach, t);
    }
    return [center[0] + dx * reach, center[1] + dy * reach];
  });
}
