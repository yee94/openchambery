const REM_PX = 16;

const TYPOGRAPHY_SIZE_CUSTOM_PROP = /--[a-z0-9-]*(font-size|title-size|meta-size|subtitle-size|label-size|line-height)$/i;
// Geometry props ride --padding-scale (user density × --dpt-n). Bare rem only:
// px literals on these props are touch-minimum / inset guarantees that must
// never scale (36px targets, keyboard choreography).
const GEOMETRY_PROP = /^(padding|gap|margin)(-[a-z]+)?$|^(min-|max-)?(width|height|inline-size|block-size|inset)$/i;

export const isTypographyProp = (prop) => (
  prop === 'font-size'
  || prop === 'line-height'
  || prop.startsWith('--text-')
  || TYPOGRAPHY_SIZE_CUSTOM_PROP.test(prop)
);

export const shouldRewriteProp = (prop) => (
  isTypographyProp(prop)
  || GEOMETRY_PROP.test(prop)
);

/** Typography scale: px/rem literals → calc(px * var(--dpt)). */
export const rewriteLengthToDesignPt = (value) => {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  if (!trimmed || trimmed.includes('var(--dpt)')) return value;
  const px = trimmed.match(/^(-?\d*\.?\d+)px$/i);
  if (px) {
    const n = Number.parseFloat(px[1]);
    if (!Number.isFinite(n) || n === 0 || Math.abs(n) === 1) return value;
    return `calc(${n} * var(--dpt))`;
  }
  const rem = trimmed.match(/^(-?\d*\.?\d+)rem$/i);
  if (rem) {
    const n = Number.parseFloat(rem[1]);
    if (!Number.isFinite(n) || n === 0) return value;
    const pxValue = n * REM_PX;
    const rounded = Math.round(pxValue * 1000) / 1000;
    return `calc(${rounded} * var(--dpt))`;
  }
  return value;
};

/** Geometry scale: bare rem only → calc(Nrem * var(--padding-scale, 1)). px never. */
export const rewriteGeometryToPaddingScale = (value) => {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  if (!trimmed) return value;
  const rem = trimmed.match(/^(-?\d*\.?\d+)rem$/i);
  if (!rem) return value;
  const n = Number.parseFloat(rem[1]);
  if (!Number.isFinite(n) || n === 0) return value;
  return `calc(${trimmed} * var(--padding-scale, 1))`;
};

const plugin = () => ({
  postcssPlugin: 'openchamber-dpt-font-size',
  Declaration(decl) {
    if (!shouldRewriteProp(decl.prop)) return;
    const rewrite = isTypographyProp(decl.prop)
      ? rewriteLengthToDesignPt
      : rewriteGeometryToPaddingScale;
    // Multi-value shorthands (padding: .5rem 1rem) convert per bare-length
    // token; keywords (auto), var()/env()/calc() tokens pass through intact.
    const tokens = decl.value.trim().split(/(\s+)/);
    let changed = false;
    const next = tokens
      .map((token) => {
        if (/^\s+$/.test(token) || token === '') return token;
        const rewritten = rewrite(token);
        if (rewritten !== token) changed = true;
        return rewritten;
      })
      .join('');
    if (changed) decl.value = next;
  },
});

plugin.postcss = true;

export default plugin;
