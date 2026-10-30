import { getBlobPreset, hasBlobShape } from './shapes.js'

export const MASCOT_SCHEMA = 'open-mascot/definition'
export const MASCOT_SCHEMA_VERSION = 2

const clone = value => JSON.parse(JSON.stringify(value))
const eyePose = (scaleX = 1, scaleY = 1, x = 0, y = 0, rotation = 0) => ({
  scaleX,
  scaleY,
  x,
  y,
  rotation,
})

const expressionMotion = (body = 'none', eyes = 'none') => ({ body, eyes })

export const createPose = ({
  pitch = 0,
  yaw = 0,
  roll = 0,
  squash = 0,
  lift = 0,
  gazeX = 0,
  gazeY = 0,
  leftEye = eyePose(),
  rightEye = eyePose(),
} = {}) => ({
  blob: { pitch, yaw, roll, squash, lift },
  gaze: { x: gazeX, y: gazeY },
  eyes: { left: leftEye, right: rightEye },
})

const baseDefinition = {
  schema: MASCOT_SCHEMA,
  schemaVersion: MASCOT_SCHEMA_VERSION,
  name: 'New mascot',
  blob: {
    shape: 'soft',
    renderMode: 'projected-3d',
    width: 220,
    height: 270,
    color: '#6fcf97',
  },
  face: {
    eyeShape: 'capsule',
    eyeColor: '#18332a',
    eyeWidth: 23,
    eyeHeight: 56,
    eyeGap: 42,
    eyeY: -10,
  },
  stage: {
    color: '#f3efe7',
  },
  expressions: {
    neutral: {
      label: 'Neutral',
      pose: createPose(),
    },
    focused: {
      label: 'Focused',
      pose: createPose({
        pitch: -3,
        yaw: 10,
        roll: 4,
        gazeX: 3,
        leftEye: eyePose(0.95, 1.13),
        rightEye: eyePose(0.95, 1.13),
      }),
    },
    curious: {
      label: 'Curious',
      pose: createPose({
        pitch: -7,
        yaw: -14,
        roll: -7,
        gazeX: -4,
        gazeY: -2,
        leftEye: eyePose(0.92, 1.06, 0, 0, 17),
        rightEye: eyePose(0.82, 0.88, 0, 1, -13),
      }),
    },
    skyward: {
      label: 'Skyward',
      pose: createPose({
        pitch: 6,
        yaw: 20,
        roll: -10,
        gazeX: 5,
        gazeY: -10,
        leftEye: eyePose(1.02, 0.88),
        rightEye: eyePose(1.02, 0.88),
      }),
    },
    'soft-gaze': {
      label: 'Soft gaze',
      pose: createPose({
        pitch: -10,
        yaw: -6,
        roll: -5,
        gazeY: 5,
        leftEye: eyePose(1.08, 0.82),
        rightEye: eyePose(1.08, 0.82),
      }),
    },
    'side-eye': {
      label: 'Side-eye',
      pose: createPose({
        pitch: -7,
        yaw: 12,
        roll: -6,
        gazeX: 4,
        leftEye: eyePose(1.1, 0.34, 0, -1, -4),
        rightEye: eyePose(0.9, 1.08, 0, 1, 3),
      }),
    },
    beaming: {
      label: 'Beaming',
      pose: createPose({
        pitch: -4,
        yaw: -11,
        roll: 8,
        squash: 0.05,
        lift: -5,
        leftEye: eyePose(1.32, 1.4, 0, -2, -5),
        rightEye: eyePose(1.32, 1.4, 0, -2, 5),
      }),
    },
    cheeky: {
      label: 'Cheeky',
      pose: createPose({
        pitch: 2,
        yaw: 15,
        roll: -12,
        lift: -3,
        gazeX: 3,
        leftEye: eyePose(0.85, 0.86, 0, 0, 22),
        rightEye: eyePose(0.85, 0.86, 0, 0, -18),
      }),
    },
    surprised: {
      label: 'Surprised',
      pose: createPose({
        pitch: -3,
        yaw: -8,
        roll: -5,
        squash: -0.03,
        lift: -4,
        leftEye: eyePose(1.55, 0.72),
        rightEye: eyePose(1.55, 0.72),
      }),
    },
    shy: {
      label: 'Shy',
      pose: createPose({
        pitch: -12,
        yaw: 7,
        roll: 5,
        gazeX: -2,
        gazeY: 10,
        leftEye: eyePose(0.92, 0.66),
        rightEye: eyePose(0.92, 0.66),
      }),
    },
    sad: {
      label: 'Sad',
      pose: createPose({
        pitch: -13,
        yaw: -5,
        roll: -4,
        squash: 0.02,
        gazeY: 8,
        leftEye: eyePose(1.12, 0.48, 0, 2, -8),
        rightEye: eyePose(1.12, 0.48, 0, 2, 8),
      }),
    },
    sleepy: {
      label: 'Sleepy',
      pose: createPose({
        pitch: 5,
        yaw: 3,
        roll: 5,
        squash: 0.03,
        gazeY: 4,
        leftEye: eyePose(1.25, 0.18),
        rightEye: eyePose(1.25, 0.18),
      }),
    },
    confident: {
      label: 'Confident',
      pose: createPose({
        pitch: 8,
        yaw: 17,
        roll: -6,
        lift: -2,
        gazeX: 5,
        gazeY: -5,
        leftEye: eyePose(0.94, 0.82),
        rightEye: eyePose(0.94, 0.82),
      }),
    },
    angry: {
      label: 'Angry',
      pose: createPose({
        pitch: 5,
        yaw: 6,
        roll: 3,
        squash: 0.03,
        gazeY: -1,
        leftEye: eyePose(1.18, 1.22, 0, 0, -31),
        rightEye: eyePose(1.18, 1.22, 0, 0, 31),
      }),
      motion: expressionMotion('tremble'),
    },
    uneasy: {
      label: 'Uneasy',
      pose: createPose({
        pitch: -7,
        yaw: -11,
        roll: 4,
        gazeX: -4,
        gazeY: 2,
        leftEye: eyePose(1.02, 0.96, 0, 0, 19),
        rightEye: eyePose(1.02, 0.96, 0, 0, -21),
      }),
      motion: expressionMotion('slow-drift', 'tremble'),
    },
  },
  animations: {
    idle: {
      label: 'Idle',
      playback: 'loop',
      ambient: 0.42,
      blink: 'normal',
      steps: [
        { expression: 'neutral', holdMs: 4400, transitionMs: 640, easing: 'gentle' },
        { expression: 'curious', holdMs: 3200, transitionMs: 760, easing: 'gentle' },
        { expression: 'neutral', holdMs: 5100, transitionMs: 720, easing: 'gentle' },
      ],
    },
    listening: {
      label: 'Listening',
      playback: 'loop',
      ambient: 0.28,
      blink: 'calm',
      steps: [
        { expression: 'focused', holdMs: 2600, transitionMs: 560, easing: 'gentle' },
        { expression: 'soft-gaze', holdMs: 2200, transitionMs: 680, easing: 'gentle' },
        { expression: 'focused', holdMs: 3100, transitionMs: 610, easing: 'gentle' },
      ],
    },
    thinking: {
      label: 'Thinking',
      playback: 'loop',
      ambient: 0.34,
      blink: 'normal',
      steps: [
        { expression: 'curious', holdMs: 1750, transitionMs: 690, easing: 'gentle' },
        { expression: 'side-eye', holdMs: 2100, transitionMs: 610, easing: 'gentle' },
        { expression: 'skyward', holdMs: 2500, transitionMs: 780, easing: 'gentle' },
        { expression: 'curious', holdMs: 1850, transitionMs: 640, easing: 'gentle' },
      ],
    },
    happy: {
      label: 'Happy',
      playback: 'loop',
      ambient: 0.48,
      blink: 'bright',
      steps: [
        { expression: 'soft-gaze', holdMs: 1300, transitionMs: 520, easing: 'spring' },
        { expression: 'beaming', holdMs: 2100, transitionMs: 620, easing: 'spring' },
        { expression: 'cheeky', holdMs: 1700, transitionMs: 570, easing: 'gentle' },
      ],
    },
    curious: {
      label: 'Curious',
      playback: 'loop',
      ambient: 0.38,
      blink: 'normal',
      steps: [
        { expression: 'curious', holdMs: 2300, transitionMs: 650, easing: 'gentle' },
        { expression: 'skyward', holdMs: 2700, transitionMs: 710, easing: 'gentle' },
        { expression: 'focused', holdMs: 1900, transitionMs: 580, easing: 'gentle' },
      ],
    },
    surprised: {
      label: 'Surprised',
      playback: 'once',
      ambient: 0.22,
      blink: 'bright',
      steps: [
        { expression: 'neutral', holdMs: 180, transitionMs: 120, easing: 'quick' },
        { expression: 'surprised', holdMs: 1450, transitionMs: 360, easing: 'spring' },
        { expression: 'curious', holdMs: 900, transitionMs: 820, easing: 'gentle' },
      ],
    },
    shy: {
      label: 'Shy',
      playback: 'loop',
      ambient: 0.2,
      blink: 'calm',
      steps: [
        { expression: 'soft-gaze', holdMs: 2400, transitionMs: 720, easing: 'gentle' },
        { expression: 'shy', holdMs: 3300, transitionMs: 810, easing: 'gentle' },
      ],
    },
    sad: {
      label: 'Sad',
      playback: 'loop',
      ambient: 0.16,
      blink: 'sleepy',
      steps: [
        { expression: 'sad', holdMs: 3900, transitionMs: 920, easing: 'gentle' },
        { expression: 'sleepy', holdMs: 2800, transitionMs: 980, easing: 'gentle' },
        { expression: 'soft-gaze', holdMs: 3500, transitionMs: 880, easing: 'gentle' },
      ],
    },
    'stand-tall': {
      label: 'Stand tall',
      playback: 'loop',
      ambient: 0.32,
      blink: 'normal',
      steps: [
        { expression: 'focused', holdMs: 1600, transitionMs: 560, easing: 'gentle' },
        { expression: 'confident', holdMs: 2900, transitionMs: 680, easing: 'spring' },
        { expression: 'soft-gaze', holdMs: 1800, transitionMs: 760, easing: 'gentle' },
      ],
    },
    'victory-bounce': {
      label: 'Victory bounce',
      playback: 'once',
      ambient: 0.54,
      blink: 'bright',
      steps: [
        { expression: 'shy', holdMs: 240, transitionMs: 180, easing: 'quick' },
        { expression: 'beaming', holdMs: 1050, transitionMs: 390, easing: 'spring' },
        { expression: 'cheeky', holdMs: 950, transitionMs: 430, easing: 'spring' },
        { expression: 'confident', holdMs: 1500, transitionMs: 760, easing: 'gentle' },
      ],
    },
    sleeping: {
      label: 'Sleeping',
      playback: 'loop',
      ambient: 0.1,
      blink: 'sleepy',
      steps: [
        { expression: 'sleepy', holdMs: 4700, transitionMs: 1100, easing: 'gentle' },
        { expression: 'sad', holdMs: 2100, transitionMs: 1250, easing: 'gentle' },
      ],
    },
  },
}

export const createDefinition = (options = {}) => {
  const definition = clone(baseDefinition)
  for (const expression of Object.values(definition.expressions)) {
    expression.motion = { ...expressionMotion(), ...expression.motion }
  }
  const shape = options.shape ?? definition.blob.shape
  const dimensions = hasBlobShape(shape) ? getBlobPreset(shape) : definition.blob
  definition.name = options.name ?? definition.name
  definition.blob.shape = shape
  definition.blob.renderMode = options.renderMode ?? definition.blob.renderMode
  definition.blob.width = options.width ?? dimensions.width
  definition.blob.height = options.height ?? dimensions.height
  definition.blob.color = options.color ?? definition.blob.color
  definition.face.eyeShape = options.eyeShape ?? definition.face.eyeShape
  definition.face.eyeColor = options.eyeColor ?? definition.face.eyeColor
  definition.stage.color = options.stageColor ?? definition.stage.color
  return definition
}

export const cloneDefinition = definition => clone(definition)

const hasFiniteFields = (target, fields) =>
  target && fields.every(field => Number.isFinite(target[field]))

export const validateDefinition = definition => {
  const errors = []
  if (!definition || typeof definition !== 'object') return { ok: false, errors: ['Definition must be an object.'] }
  if (definition.schema !== MASCOT_SCHEMA) errors.push(`schema must be "${MASCOT_SCHEMA}".`)
  if (definition.schemaVersion !== MASCOT_SCHEMA_VERSION) errors.push(`schemaVersion must be ${MASCOT_SCHEMA_VERSION}.`)
  if (!definition.blob || !hasBlobShape(definition.blob.shape)) errors.push('blob.shape is not registered.')
  if (!['projected-3d', 'rigged-2d'].includes(definition.blob?.renderMode)) {
    errors.push('blob.renderMode must be projected-3d or rigged-2d.')
  }
  if (!(definition.blob?.width > 0) || !(definition.blob?.height > 0)) errors.push('blob dimensions must be positive.')
  if (!/^#[0-9a-f]{6}$/i.test(definition.blob?.color ?? '')) errors.push('blob.color must be a six-digit hex color.')
  if (!/^#[0-9a-f]{6}$/i.test(definition.face?.eyeColor ?? '')) errors.push('face.eyeColor must be a six-digit hex color.')
  if (definition.face?.eyeShape != null && !['capsule', 'oval'].includes(definition.face.eyeShape)) {
    errors.push('face.eyeShape must be capsule or oval.')
  }
  if (!hasFiniteFields(definition.face, ['eyeWidth', 'eyeHeight', 'eyeGap', 'eyeY'])) errors.push('face dimensions must be finite numbers.')
  if (!/^#[0-9a-f]{6}$/i.test(definition.stage?.color ?? '')) errors.push('stage.color must be a six-digit hex color.')
  if (!definition.expressions || !Object.keys(definition.expressions).length) errors.push('At least one expression is required.')
  if (!definition.animations || !Object.keys(definition.animations).length) errors.push('At least one animation is required.')

  for (const [key, expression] of Object.entries(definition.expressions ?? {})) {
    const pose = expression?.pose
    if (!hasFiniteFields(pose?.blob, ['pitch', 'yaw', 'roll', 'squash', 'lift'])
      || !hasFiniteFields(pose?.gaze, ['x', 'y'])
      || !hasFiniteFields(pose?.eyes?.left, ['scaleX', 'scaleY', 'x', 'y', 'rotation'])
      || !hasFiniteFields(pose?.eyes?.right, ['scaleX', 'scaleY', 'x', 'y', 'rotation'])) {
      errors.push(`${key} has an invalid pose.`)
    }
    if (expression.motion != null) {
      if (!['none', 'slow-drift', 'tremble', 'boing'].includes(expression.motion.body)) {
        errors.push(`${key}.motion.body has an unknown mode.`)
      }
      if (!['none', 'micro-saccades', 'tremble'].includes(expression.motion.eyes)) {
        errors.push(`${key}.motion.eyes has an unknown mode.`)
      }
    }
  }

  for (const [key, animation] of Object.entries(definition.animations ?? {})) {
    if (!['loop', 'once'].includes(animation.playback)) errors.push(`${key}.playback must be loop or once.`)
    if (![true, false, 'none', 'calm', 'normal', 'bright', 'sleepy'].includes(animation.blink)) {
      errors.push(`${key}.blink has an unknown profile.`)
    }
    if (!Array.isArray(animation.steps) || !animation.steps.length) {
      errors.push(`${key} must have at least one step.`)
      continue
    }
    for (const step of animation.steps) {
      if (!definition.expressions?.[step.expression]) errors.push(`${key} references unknown expression "${step.expression}".`)
      if (step.easing != null && !['gentle', 'quick', 'spring'].includes(step.easing)) {
        errors.push(`${key} step has an unknown easing curve.`)
      }
      if (!Number.isFinite(step.holdMs) || !Number.isFinite(step.transitionMs)
        || step.holdMs < 0 || step.transitionMs < 0) errors.push(`${key} step timings must be finite and non-negative.`)
    }
  }
  return { ok: errors.length === 0, errors }
}
