const presets = Object.freeze({
  round: Object.freeze({ width: 220, height: 220 }),
  soft: Object.freeze({ width: 220, height: 270 }),
  tall: Object.freeze({ width: 196, height: 286 }),
  wide: Object.freeze({ width: 252, height: 210 }),
  compact: Object.freeze({ width: 188, height: 220 }),
  large: Object.freeze({ width: 250, height: 300 }),
  drop: Object.freeze({ width: 202, height: 236 }),
})

export const listBlobShapes = () => Object.keys(presets)

export const hasBlobShape = name => Object.hasOwn(presets, name)

export const getBlobPreset = name => {
  const preset = presets[name]
  if (!preset) throw new Error(`Unknown blob preset: ${name}`)
  return { ...preset }
}
