const clamp = (value, minimum = 0, maximum = 1) =>
  Math.min(maximum, Math.max(minimum, value))

const easing = {
  gentle(value) {
    const t = clamp(value)
    return t * t * t * (t * (t * 6 - 15) + 10)
  },
  quick(value) {
    return 1 - (1 - clamp(value)) ** 4
  },
  spring(value) {
    const t = clamp(value)
    const settled = 1 - (1 - t) ** 4
    return clamp(settled + Math.sin(t * Math.PI * 2.45) * (1 - t) ** 3 * 0.13)
  },
}

const interpolateValue = (from, to, amount) => {
  if (typeof from === 'number' && typeof to === 'number') return from + (to - from) * amount
  if (from && to && typeof from === 'object' && typeof to === 'object') {
    return Object.fromEntries(
      Object.keys(from).map(key => [key, interpolateValue(from[key], to[key], amount)]),
    )
  }
  return amount < 1 ? from : to
}

export const interpolatePose = (from, to, amount, curve = 'gentle') =>
  interpolateValue(from, to, (easing[curve] ?? easing.gentle)(amount))

const noExpressionMotion = { body: 'none', eyes: 'none' }
const motionFor = expression => ({ ...noExpressionMotion, ...expression?.motion })

export const hasExpressionMotion = expression => {
  const motion = motionFor(expression)
  return motion.body !== 'none' || motion.eyes !== 'none'
}

const saccadeTargets = [
  [0, 0],
  [0.72, -0.28],
  [-0.34, 0.54],
  [0.28, 0.18],
  [-0.62, -0.12],
  [0.12, -0.48],
]

const microSaccadeAt = elapsedMs => {
  const intervalMs = 1240
  const travelMs = 125
  const step = Math.floor(Math.max(0, elapsedMs) / intervalMs)
  const local = Math.max(0, elapsedMs) - step * intervalMs
  const amount = easing.gentle(Math.min(1, local / travelMs))
  const from = saccadeTargets[step % saccadeTargets.length]
  const to = saccadeTargets[(step + 1) % saccadeTargets.length]
  return {
    x: from[0] + (to[0] - from[0]) * amount,
    y: from[1] + (to[1] - from[1]) * amount,
  }
}

const sampleLoop = (frames, position) => {
  const wrapped = ((position % frames.length) + frames.length) % frames.length
  const currentIndex = Math.floor(wrapped)
  const nextIndex = (currentIndex + 1) % frames.length
  const amount = easing.gentle(wrapped - currentIndex)
  return Object.fromEntries(
    Object.keys(frames[currentIndex]).map(key => [
      key,
      frames[currentIndex][key] + (frames[nextIndex][key] - frames[currentIndex][key]) * amount,
    ]),
  )
}

const bodyTrembleFrames = [
  { yaw: -0.82, pitch: 0.38, roll: -0.28, lift: 0.62 },
  { yaw: 0.54, pitch: -0.66, roll: 0.43, lift: -0.44 },
  { yaw: 1.08, pitch: 0.2, roll: -0.24, lift: 0.86 },
  { yaw: -0.46, pitch: 0.72, roll: 0.34, lift: -0.58 },
  { yaw: 0.16, pitch: -0.31, roll: -0.49, lift: 0.22 },
]

const eyeTrembleFrames = [
  { x: -1.12, y: 0.44 },
  { x: 0.67, y: -0.74 },
  { x: 1.28, y: 0.2 },
  { x: -0.48, y: 0.8 },
  { x: 0.2, y: -0.36 },
]

export const applyExpressionMotion = (sourcePose, motion, elapsedMs, strength = 1) => {
  const pose = JSON.parse(JSON.stringify(sourcePose))
  const resolved = { ...noExpressionMotion, ...motion }
  const seconds = Math.max(0, elapsedMs) / 1000
  const amount = clamp(strength)

  if (resolved.body === 'slow-drift') {
    pose.blob.yaw += Math.sin(seconds * 0.73) * 1.4 * amount
    pose.blob.pitch += Math.sin(seconds * 0.51) * 0.85 * amount
    pose.blob.roll += Math.sin(seconds * 0.39) * 0.72 * amount
    pose.blob.lift += Math.sin(seconds * 0.88) * 1.9 * amount
  } else if (resolved.body === 'tremble') {
    const frame = sampleLoop(bodyTrembleFrames, seconds * 8.4)
    pose.blob.yaw += frame.yaw * amount
    pose.blob.pitch += frame.pitch * amount
    pose.blob.roll += frame.roll * amount
    pose.blob.lift += frame.lift * amount
  } else if (resolved.body === 'boing') {
    const phase = seconds * Math.PI * 2 * 1.25
    const bounce = Math.sin(phase)
    const rebound = Math.sin(phase * 2) * 0.18
    pose.blob.squash += (bounce + rebound) * 0.075 * amount
    pose.blob.lift += bounce * 5.4 * amount
  }

  if (resolved.eyes === 'micro-saccades') {
    const target = microSaccadeAt(elapsedMs)
    pose.gaze.x += target.x * 2.1 * amount
    pose.gaze.y += target.y * 1.5 * amount
  } else if (resolved.eyes === 'tremble') {
    const frame = sampleLoop(eyeTrembleFrames, seconds * 10.6)
    pose.gaze.x += frame.x * amount
    pose.gaze.y += frame.y * amount
  }

  return pose
}

export const getAnimationDuration = animation =>
  animation.steps.reduce((total, step, index) => {
    const hasTransition = animation.playback === 'loop' || index < animation.steps.length - 1
    return total + step.holdMs + (hasTransition ? step.transitionMs : 0)
  }, 0)

const locateStep = (animation, elapsedMs) => {
  const duration = getAnimationDuration(animation)
  const done = animation.playback === 'once' && elapsedMs >= duration
  const local = animation.playback === 'loop' && duration > 0
    ? ((elapsedMs % duration) + duration) % duration
    : clamp(elapsedMs, 0, duration)
  let cursor = 0

  for (let index = 0; index < animation.steps.length; index += 1) {
    const step = animation.steps[index]
    const hasTransition = animation.playback === 'loop' || index < animation.steps.length - 1
    const holdEnd = cursor + step.holdMs
    const transitionEnd = holdEnd + (hasTransition ? step.transitionMs : 0)
    if (local <= holdEnd || !hasTransition) return { index, phase: 'hold', progress: 0, done, duration }
    if (local <= transitionEnd) {
      return {
        index,
        phase: 'transition',
        progress: step.transitionMs ? (local - holdEnd) / step.transitionMs : 1,
        done,
        duration,
      }
    }
    cursor = transitionEnd
  }
  return { index: animation.steps.length - 1, phase: 'hold', progress: 0, done, duration }
}

const blinkIntervals = {
  calm: [6800, 5300, 7900, 6100],
  normal: [5100, 7200, 4300, 6400, 5600],
  bright: [3900, 5700, 4500, 6900],
  sleepy: [7600, 9100, 6800],
  none: [],
}

const blinkShape = progress => {
  if (progress < 0.23) return easing.quick(progress / 0.23)
  if (progress < 0.39) return 1
  return 1 - easing.gentle((progress - 0.39) / 0.61)
}

const blinkAmountAt = (elapsedMs, selectedProfile) => {
  const profile = selectedProfile === false ? 'none' : selectedProfile === true ? 'normal' : selectedProfile
  const intervals = blinkIntervals[profile] ?? blinkIntervals.normal
  if (!intervals.length || elapsedMs < 0) return 0
  let cursor = 1700 + intervals[0] * 0.32
  let index = 0
  while (cursor <= elapsedMs && index < 10000) {
    const duration = profile === 'sleepy' ? 320 : index % 7 === 4 ? 250 : 205
    const within = elapsedMs - cursor
    if (within >= 0 && within <= duration) return blinkShape(within / duration)
    if (profile === 'bright' && index % 5 === 2) {
      const echoWithin = elapsedMs - (cursor + duration + 118)
      if (echoWithin >= 0 && echoWithin <= 170) return blinkShape(echoWithin / 170) * 0.88
    }
    cursor += intervals[index % intervals.length]
    index += 1
  }
  return 0
}

const addAmbientMotion = (pose, elapsedMs, amount, blink) => {
  const next = JSON.parse(JSON.stringify(pose))
  const seconds = elapsedMs / 1000
  const strength = clamp(amount ?? 0)
  next.blob.lift += Math.sin(seconds * 0.79 + 0.4) * 2.1 * strength
  next.blob.roll += Math.sin(seconds * 0.53 + 1.1) * 0.72 * strength
  next.blob.pitch += Math.sin(seconds * 0.41 + 2.3) * 0.5 * strength
  next.blob.squash += Math.sin(seconds * 1.06) * 0.006 * strength
  next.gaze.x += Math.sin(seconds * 0.29 + 0.7) * 0.42 * strength
  next.gaze.y += Math.sin(seconds * 0.23 + 2.7) * 0.3 * strength

  const blinkAmount = blinkAmountAt(elapsedMs, blink)
  const leftDelay = blink === 'bright' ? 0.04 : 0
  next.eyes.left.scaleY *= Math.max(0.055, 1 - blinkAmount * (0.95 - leftDelay))
  next.eyes.right.scaleY *= Math.max(0.055, 1 - blinkAmount * 0.96)
  next.eyes.left.y += blinkAmount * 1.25
  next.eyes.right.y += blinkAmount * 1.05
  return { pose: next, blink: blinkAmount }
}

export const sampleAnimation = (definition, animationKey, elapsedMs, options = {}) => {
  const animation = definition.animations[animationKey]
  if (!animation) throw new Error(`Unknown animation: ${animationKey}`)
  const location = locateStep(animation, Math.max(0, elapsedMs))
  const currentStep = animation.steps[location.index]
  const currentExpression = definition.expressions[currentStep.expression]
  const current = currentExpression.pose
  let pose = current
  let expressionLayers = [{ expression: currentExpression, strength: 1 }]

  if (location.phase === 'transition') {
    const nextIndex = (location.index + 1) % animation.steps.length
    const nextStep = animation.steps[nextIndex]
    const nextExpression = definition.expressions[nextStep.expression]
    const transitionAmount = (easing[currentStep.easing] ?? easing.gentle)(location.progress)
    pose = interpolatePose(current, nextExpression.pose, location.progress, currentStep.easing)
    expressionLayers = [
      { expression: currentExpression, strength: 1 - transitionAmount },
      { expression: nextExpression, strength: transitionAmount },
    ]
  }

  const layered = options.reducedMotion
    ? { pose: JSON.parse(JSON.stringify(pose)), blink: 0 }
    : addAmbientMotion(pose, elapsedMs, animation.ambient, animation.blink)
  if (!options.reducedMotion) {
    for (const layer of expressionLayers) {
      layered.pose = applyExpressionMotion(
        layered.pose,
        motionFor(layer.expression),
        elapsedMs,
        layer.strength,
      )
    }
  }
  return { ...location, ...layered, animationKey }
}

export const sampleExpression = (definition, expressionKey, elapsedMs = 0, options = {}) => {
  const expression = definition.expressions[expressionKey]
  if (!expression) throw new Error(`Unknown expression: ${expressionKey}`)
  if (options.reducedMotion) return JSON.parse(JSON.stringify(expression.pose))
  return applyExpressionMotion(expression.pose, motionFor(expression), elapsedMs)
}
