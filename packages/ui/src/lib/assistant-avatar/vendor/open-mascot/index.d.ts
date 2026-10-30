export type BuiltInBlobShape = 'round' | 'soft' | 'tall' | 'wide' | 'compact' | 'large' | 'drop'
export type BlobShape = BuiltInBlobShape
export type EyeShape = 'capsule' | 'oval'
export type RenderMode = 'projected-3d' | 'rigged-2d'
export type BodyExpressionMotion = 'none' | 'slow-drift' | 'tremble' | 'boing'
export type EyeExpressionMotion = 'none' | 'micro-saccades' | 'tremble'

export interface EyePose {
  scaleX: number
  scaleY: number
  x: number
  y: number
  rotation: number
}

export interface MascotPose {
  blob: { pitch: number; yaw: number; roll: number; squash: number; lift: number }
  gaze: { x: number; y: number }
  eyes: { left: EyePose; right: EyePose }
}

export interface MascotDefinition {
  schema: 'open-mascot/definition'
  schemaVersion: 2
  name: string
  blob: { shape: BlobShape; renderMode: RenderMode; width: number; height: number; color: string }
  face: { eyeShape?: EyeShape; eyeColor: string; eyeWidth: number; eyeHeight: number; eyeGap: number; eyeY: number }
  stage: { color: string }
  expressions: Record<string, {
    label: string
    pose: MascotPose
    motion?: { body: BodyExpressionMotion; eyes: EyeExpressionMotion }
  }>
  animations: Record<string, {
    label: string
    playback: 'loop' | 'once'
    ambient: number
    blink: boolean | 'none' | 'calm' | 'normal' | 'bright' | 'sleepy'
    steps: Array<{ expression: string; holdMs: number; transitionMs: number; easing?: 'gentle' | 'quick' | 'spring' }>
  }>
}

export interface CreatePoseOptions {
  pitch?: number
  yaw?: number
  roll?: number
  squash?: number
  lift?: number
  gazeX?: number
  gazeY?: number
  leftEye?: EyePose
  rightEye?: EyePose
}

export interface MascotScene {
  viewBox: string
  width: number
  height: number
  background: string
  transform: string
  shadow: { cx: number; cy: number; rx: number; ry: number; fill: string; opacity: number }
  blob: { path: string; fill: string }
  eyes: Array<{ shape: EyeShape; cx: number; cy: number; rx: number; ry: number; path: string; rotation: number; fill: string }>
}

export const MASCOT_SCHEMA: 'open-mascot/definition'
export const MASCOT_SCHEMA_VERSION: 2
export const VIEWBOX: { width: 560; height: 560 }
export function createDefinition(options?: Partial<{ name: string; shape: BlobShape; renderMode: RenderMode; width: number; height: number; color: string; eyeShape: EyeShape; eyeColor: string; stageColor: string }>): MascotDefinition
export function cloneDefinition(definition: MascotDefinition): MascotDefinition
export function createPose(options?: CreatePoseOptions): MascotPose
export function validateDefinition(definition: unknown): { ok: boolean; errors: string[] }
export function listBlobShapes(): BlobShape[]
export function hasBlobShape(name: string): boolean
export function getBlobPreset(name: BlobShape): { width: number; height: number }
export function hasExpressionMotion(expression: MascotDefinition['expressions'][string]): boolean
export function applyExpressionMotion(pose: MascotPose, motion: { body?: BodyExpressionMotion; eyes?: EyeExpressionMotion }, elapsedMs: number, strength?: number): MascotPose
export function interpolatePose(from: MascotPose, to: MascotPose, amount: number, curve?: 'gentle' | 'quick' | 'spring'): MascotPose
export function getAnimationDuration(animation: MascotDefinition['animations'][string]): number
export function sampleAnimation(definition: MascotDefinition, animationKey: string, elapsedMs: number, options?: { reducedMotion?: boolean }): { pose: MascotPose; blink: number; done: boolean; duration: number; index: number; phase: 'hold' | 'transition'; progress: number; animationKey: string }
export function sampleExpression(definition: MascotDefinition, expressionKey: string, elapsedMs?: number, options?: { reducedMotion?: boolean }): MascotPose
export function buildScene(definition: MascotDefinition, pose: MascotPose): MascotScene
