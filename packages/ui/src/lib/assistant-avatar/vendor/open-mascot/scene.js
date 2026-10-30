export const VIEWBOX = { width: 560, height: 560 }

const CHARACTER_SCALE = 1.28
const CAMERA_DISTANCE = 650
const BODY_CENTER_Y = 280

const fixed = value => Number((Number.isFinite(value) ? value : 0).toFixed(3))
const degreesToRadians = degrees => (Math.PI * degrees) / 180

const normalizedPose = pose => ({
  pitch: pose.pitch ?? 0,
  yaw: pose.yaw ?? 0,
  roll: pose.roll ?? 0,
  squash: pose.squash ?? 0,
  lift: pose.lift ?? 0,
})

const rotatePoint = ([x, y, z], rawPose) => {
  const pose = normalizedPose(rawPose)
  const pitch = degreesToRadians(pose.pitch)
  const yaw = degreesToRadians(pose.yaw)
  const roll = degreesToRadians(pose.roll)
  const pitched = [
    x,
    y * Math.cos(pitch) - z * Math.sin(pitch),
    y * Math.sin(pitch) + z * Math.cos(pitch),
  ]
  const yawed = [
    pitched[0] * Math.cos(yaw) + pitched[2] * Math.sin(yaw),
    pitched[1],
    -pitched[0] * Math.sin(yaw) + pitched[2] * Math.cos(yaw),
  ]
  return [
    yawed[0] * Math.cos(roll) - yawed[1] * Math.sin(roll),
    yawed[0] * Math.sin(roll) + yawed[1] * Math.cos(roll),
    yawed[2],
  ]
}

const projectPoint = (point, rawPose) => {
  const pose = normalizedPose(rawPose)
  const squashed = [point[0], point[1] * (1 - pose.squash), point[2]]
  const [x, y, z] = rotatePoint(squashed, pose)
  const perspective = CAMERA_DISTANCE / (CAMERA_DISTANCE - z)
  return {
    x: VIEWBOX.width / 2 + x * CHARACTER_SCALE * perspective,
    y: BODY_CENTER_Y + y * CHARACTER_SCALE * perspective + pose.lift,
    z,
  }
}

const smoothClosedPath = points => {
  if (points.length < 3) return ''
  const at = index => points[(index + points.length) % points.length]
  const start = {
    x: (at(-1).x + at(0).x) / 2,
    y: (at(-1).y + at(0).y) / 2,
  }
  let path = `M ${fixed(start.x)} ${fixed(start.y)}`
  for (let index = 0; index < points.length; index += 1) {
    const current = at(index)
    const next = at(index + 1)
    path += ` Q ${fixed(current.x)} ${fixed(current.y)}, ${fixed((current.x + next.x) / 2)} ${fixed((current.y + next.y) / 2)}`
  }
  return `${path} Z`
}

const eyeOutline = (shape, width, height) => {
  if (shape === 'oval') {
    return Array.from({ length: 72 }, (_, index) => {
      const angle = (index / 72) * Math.PI * 2
      return [(width / 2) * Math.cos(angle), (height / 2) * Math.sin(angle)]
    })
  }

  const halfWidth = width / 2
  const halfHeight = height / 2
  const radius = Math.min(halfWidth, halfHeight)
  const corners = [
    { x: halfWidth - radius, y: -halfHeight + radius, start: -Math.PI / 2 },
    { x: halfWidth - radius, y: halfHeight - radius, start: 0 },
    { x: -halfWidth + radius, y: halfHeight - radius, start: Math.PI / 2 },
    { x: -halfWidth + radius, y: -halfHeight + radius, start: Math.PI },
  ]
  return corners.flatMap(corner =>
    Array.from({ length: 6 }, (_, index) => {
      const angle = corner.start + (Math.PI / 2) * (index / 5)
      return [corner.x + Math.cos(angle) * radius, corner.y + Math.sin(angle) * radius]
    }),
  )
}

const bodySurfaceDepth = (x, y, width, height, depth) => {
  const vertical = height >= width
  const diameter = Math.min(width, height)
  const radius = diameter / 2
  const straightHalf = Math.max(0, (Math.max(width, height) - diameter) / 2)
  const capDistance = vertical
    ? Math.max(0, Math.abs(y) - straightHalf)
    : Math.max(0, Math.abs(x) - straightHalf)
  const capScale = Math.sqrt(Math.max(0, 1 - (capDistance / radius) ** 2))
  const crossAxis = vertical ? x : y
  const crossRadius = Math.max(0.001, radius * capScale)
  const depthRadius = (depth / 2) * capScale
  return depthRadius * Math.sqrt(Math.max(0, 1 - (crossAxis / crossRadius) ** 2))
}

const projectedEye = (definition, pose, side) => {
  const { blob, face } = definition
  const eye = pose.eyes[side]
  const direction = side === 'left' ? -1 : 1
  const centerX = direction * face.eyeGap / 2 + pose.gaze.x + eye.x
  const centerY = face.eyeY + pose.gaze.y + eye.y
  const width = Math.max(2, face.eyeWidth * eye.scaleX)
  const height = Math.max(2, face.eyeHeight * eye.scaleY)
  const angle = degreesToRadians(eye.rotation)
  const bodyDepth = Math.min(blob.width, blob.height) * (150 / 220)
  const points = eyeOutline(face.eyeShape ?? 'capsule', width, height).map(([x, y]) => {
    const rotatedX = x * Math.cos(angle) - y * Math.sin(angle)
    const rotatedY = x * Math.sin(angle) + y * Math.cos(angle)
    const surfaceX = centerX + rotatedX
    const surfaceY = centerY + rotatedY
    return projectPoint([
      surfaceX,
      surfaceY,
      bodySurfaceDepth(surfaceX, surfaceY, blob.width, blob.height, bodyDepth) + 1.4,
    ], pose.blob)
  })
  return eyeScene(face, points)
}

const bodyAxis = (blob, pose) => {
  const vertical = blob.height >= blob.width
  const straightHalf = Math.max(0, (Math.max(blob.width, blob.height) - Math.min(blob.width, blob.height)) / 2)
  const axis = rotatePoint(vertical ? [0, straightHalf, 0] : [straightHalf, 0, 0], pose)
  return [axis[0], axis[1]]
}

const projectedBodyPath = (blob, rawPose) => {
  const pose = normalizedPose(rawPose)
  const radius = Math.min(blob.width, blob.height) / 2
  const bodyDepth = Math.min(blob.width, blob.height) * (150 / 220)
  const squash = 1 - pose.squash
  const basisX = rotatePoint([radius, 0, 0], pose)
  const basisY = rotatePoint([0, radius * squash, 0], pose)
  const basisZ = rotatePoint([0, 0, bodyDepth / 2], pose)
  const columns = [basisX, basisY, basisZ].map(([x, y]) => [x, y])
  const qxx = columns.reduce((sum, column) => sum + column[0] ** 2, 0)
  const qxy = columns.reduce((sum, column) => sum + column[0] * column[1], 0)
  const qyy = columns.reduce((sum, column) => sum + column[1] ** 2, 0)
  const axis = bodyAxis(blob, pose).map(value => value * squash)

  const perimeterSamples = 92
  const points = Array.from({ length: perimeterSamples }, (_, index) => {
    const angle = (index * Math.PI * 2) / perimeterSamples
    const direction = [Math.cos(angle), Math.sin(angle)]
    const qDirection = [
      qxx * direction[0] + qxy * direction[1],
      qxy * direction[0] + qyy * direction[1],
    ]
    const denominator = Math.sqrt(direction[0] * qDirection[0] + direction[1] * qDirection[1]) || 1
    const axisDot = direction[0] * axis[0] + direction[1] * axis[1]
    const axisSign = Math.abs(axisDot) < 1e-8 ? 0 : Math.sign(axisDot)
    return {
      x: VIEWBOX.width / 2 + (qDirection[0] / denominator + axis[0] * axisSign) * CHARACTER_SCALE,
      y: BODY_CENTER_Y + (qDirection[1] / denominator + axis[1] * axisSign) * CHARACTER_SCALE + pose.lift,
    }
  })
  return smoothClosedPath(points)
}

const riggedPoint = ([x, y], blob, rawPose) => {
  const pose = normalizedPose(rawPose)
  const yawScale = Math.max(0.8, 1 - Math.abs(pose.yaw) * 0.005)
  const pitchScale = Math.max(0.9, 1 - Math.abs(pose.pitch) * 0.0025)
  const verticalProgress = y / Math.max(1, blob.height / 2)
  const bentX = x * yawScale + pose.yaw * verticalProgress * 0.18
  const bentY = y * (1 - pose.squash) * pitchScale
  const roll = degreesToRadians(pose.roll)
  return {
    x: VIEWBOX.width / 2
      + (bentX * Math.cos(roll) - bentY * Math.sin(roll)) * CHARACTER_SCALE
      + pose.yaw * 0.16,
    y: BODY_CENTER_Y
      + (bentX * Math.sin(roll) + bentY * Math.cos(roll)) * CHARACTER_SCALE
      + pose.lift,
  }
}

const capsuleOutline = (width, height) => {
  const vertical = height >= width
  const radius = Math.min(width, height) / 2
  const straightHalf = Math.max(0, (Math.max(width, height) - Math.min(width, height)) / 2)
  const outlineSamples = 88
  return Array.from({ length: outlineSamples }, (_, sampleIndex) => {
    const phase = (sampleIndex * Math.PI * 2) / outlineSamples
    const unitX = Math.cos(phase)
    const unitY = Math.sin(phase)
    return vertical
      ? [radius * unitX, radius * unitY + (Math.abs(unitY) < 1e-8 ? 0 : Math.sign(unitY)) * straightHalf]
      : [radius * unitX + (Math.abs(unitX) < 1e-8 ? 0 : Math.sign(unitX)) * straightHalf, radius * unitY]
  })
}

const cubicPoint = (start, controlA, controlB, end, amount) => {
  const inverse = 1 - amount
  return [
    inverse ** 3 * start[0]
      + 3 * inverse ** 2 * amount * controlA[0]
      + 3 * inverse * amount ** 2 * controlB[0]
      + amount ** 3 * end[0],
    inverse ** 3 * start[1]
      + 3 * inverse ** 2 * amount * controlA[1]
      + 3 * inverse * amount ** 2 * controlB[1]
      + amount ** 3 * end[1],
  ]
}

const dropOutline = (width, height) => {
  const x = width / 2
  const y = height / 2
  const segments = [
    [[0, -y], [x * 0.16, -y * 0.68], [x, -y * 0.23], [x, y * 0.26]],
    [[x, y * 0.26], [x, y * 0.78], [x * 0.55, y], [0, y]],
    [[0, y], [-x * 0.55, y], [-x, y * 0.78], [-x, y * 0.26]],
    [[-x, y * 0.26], [-x, -y * 0.23], [-x * 0.16, -y * 0.68], [0, -y]],
  ]
  return segments.flatMap(segment =>
    Array.from({ length: 24 }, (_, index) => cubicPoint(...segment, index / 24)),
  )
}

const eyeScene = (face, points) => {
  const xs = points.map(point => point.x)
  const ys = points.map(point => point.y)
  return {
    shape: face.eyeShape ?? 'capsule',
    cx: fixed((Math.min(...xs) + Math.max(...xs)) / 2),
    cy: fixed((Math.min(...ys) + Math.max(...ys)) / 2),
    rx: fixed((Math.max(...xs) - Math.min(...xs)) / 2),
    ry: fixed((Math.max(...ys) - Math.min(...ys)) / 2),
    path: smoothClosedPath(points),
    rotation: 0,
    fill: face.eyeColor,
  }
}

const riggedEye = (definition, pose, side) => {
  const { blob, face } = definition
  const eye = pose.eyes[side]
  const direction = side === 'left' ? -1 : 1
  const center = [
    direction * face.eyeGap / 2 + pose.gaze.x + eye.x,
    face.eyeY + pose.gaze.y + eye.y,
  ]
  const angle = degreesToRadians(eye.rotation)
  const projection = CAMERA_DISTANCE / (CAMERA_DISTANCE - (Math.min(blob.width, blob.height) * (150 / 220)) / 2)
  const points = eyeOutline(
    face.eyeShape ?? 'capsule',
    Math.max(2, face.eyeWidth * eye.scaleX),
    Math.max(2, face.eyeHeight * eye.scaleY),
  ).map(([x, y]) => riggedPoint([
    center[0] + x * Math.cos(angle) - y * Math.sin(angle),
    center[1] + x * Math.sin(angle) + y * Math.cos(angle),
  ], blob, pose.blob)).map(point => ({
    x: VIEWBOX.width / 2 + (point.x - VIEWBOX.width / 2) * projection,
    y: BODY_CENTER_Y + (point.y - BODY_CENTER_Y - pose.blob.lift) * projection + pose.blob.lift,
  }))
  return eyeScene(face, points)
}

export const buildScene = (definition, pose) => {
  const { blob, stage } = definition
  const projected = blob.renderMode !== 'rigged-2d'
  const flatOutline = blob.shape === 'drop'
    ? dropOutline(blob.width, blob.height)
    : capsuleOutline(blob.width, blob.height)
  const bodyPath = projected && blob.shape !== 'drop'
    ? projectedBodyPath(blob, pose.blob)
    : smoothClosedPath(flatOutline.map(point => riggedPoint(point, blob, pose.blob)))
  const eyes = projected
    ? [projectedEye(definition, pose, 'left'), projectedEye(definition, pose, 'right')]
    : [riggedEye(definition, pose, 'left'), riggedEye(definition, pose, 'right')]
  const bodyCenter = projectPoint([0, 0, 0], pose.blob)

  return {
    viewBox: `0 0 ${VIEWBOX.width} ${VIEWBOX.height}`,
    width: VIEWBOX.width,
    height: VIEWBOX.height,
    background: stage.color,
    transform: '',
    shadow: {
      cx: fixed(bodyCenter.x * 0.18 + (VIEWBOX.width / 2) * 0.82),
      cy: 480,
      rx: fixed((blob.width / 2) * CHARACTER_SCALE * 0.78),
      ry: 17,
      fill: '#000000',
      opacity: 0.24,
    },
    blob: { path: bodyPath, fill: blob.color },
    eyes,
  }
}
