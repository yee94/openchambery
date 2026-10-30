export type Point = [number, number];
export type Vector = [number, number, number];
export type Quaternion = [number, number, number, number];
export type Matrix = number[];
export type Eye = {
  off: Point; tilt: number; wid: number; lidY: number; oval: Point;
  ovalMix: number; pts: Point[]; path: number[]; fillRing: Point[] | null;
};
export type EyeBasis = { M: Vector; T: Vector; C: Vector };
export type PathRing = Array<{ kind: 'line' | 'arc'; to: Point; radii?: Point; sweep?: number }>;
export type Frame = {
  body: string; quat: Quaternion; zoom: number; offset: Point; squash: Point;
  squashAnchor: number; eyes: [Eye, Eye] | null; glow: null;
  inspectWeight: number; bodies: Array<{ body: string; weight: number }>;
  morph: object | null;
};
export type Config = {
  eyeBasis: [EyeBasis, EyeBasis]; eyeMirror: [boolean, boolean]; baseEulerDeg: Vector;
  $n: number; x: number; IT: number; Mx: number;
};
export type Theme = { ink: Vector; spot: Vector; cutout: boolean };
export type SphereModel = {
  mode: 'sphere'; size: number; bodyD: string; eyesD: string; glow: null;
  inkPaint: string; spotPaint: string; cutout: boolean;
};
export type Part = { key: string; opacity: number } & (
  | { type: 'disc'; cx: number; cy: number; r: number }
  | { type: 'ring'; cx: number; cy: number; r: number; width: number }
  | { type: 'shape' | 'stroke'; d: string }
);
export type MorphModel = {
  mode: 'morph'; size: number; center: Point; bodyPts: Point[]; eyesPts: Point[][];
  head: { translate: Point; rotation: number; scale: number; opacity: number } | null;
  parts: Part[]; markScale: number; zoom: number; inkPaint: string; spotPaint: string; cutout: boolean;
};
export type Model = SphereModel | MorphModel;
export type Body = { center: Point; radius: number; body: Point[][]; eyes: Point[][] };
export type BodyBuilder = (frame: Frame, size: number, config: Config, body: string) => Body;
export function makeConfig(recipes: object): Config;
export function makeMorphGenerators(config: Config): object;
export function makeTrail(config: Config): object;
export function createRuntime(config: Config, options?: { body?: string; isGazeAlways?: boolean; isReducedMotion?: boolean }): {
  advance(dt: number): void;
  frame(): Frame;
  pause(): void;
  seek(time: number): void;
  setGaze(gaze: Point | null): void;
  setBody(body: string, options?: { isInstant?: boolean }): void;
  blink(): void;
};
export function createStateMachine(config: Config, runtime: ReturnType<typeof createRuntime>, state: string, options?: {
  seed?: number; isCompact?: boolean; isResting?: boolean; firstPhase?: number;
}): { advance(dt: number): void; setState(state: string): void; setCompact(compact: boolean): void };
export function buildModel(frame: Frame, theme: Theme, size: number, config: Config,
  generators: object, trail: object, warnBody: (body: string) => void, buildBody?: BodyBuilder): Model;
export function createRenderer(document: Document, id: string, size: number, config: Config): {
  svg: SVGSVGElement; render(model: Model): void;
};
export function lb(pitch: number, yaw: number, roll: number): Quaternion;
export function ir(quaternion: Quaternion): Matrix;
export function Et(matrix: Matrix, vector: Vector): Vector;
export function ST(eye: Eye, basis: EyeBasis, mirror: boolean, matrix: Matrix, radius: number): PathRing[];
export function xT(ring: PathRing, step: number): Point[];
export const kT: number;
