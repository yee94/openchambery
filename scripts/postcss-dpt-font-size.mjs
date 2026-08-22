const REM_PX = 16;

const shouldRewriteProp = (prop) => (
  prop === 'font-size' || prop === 'line-height' || prop.startsWith('--text-')
);

export const rewriteLengthToDesignPt = (value) => {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  if (!trimmed || trimmed.includes('var(--dpt)')) return value;
  const px = trimmed.match(/^(-?\d+(?:\.\d+)?)px$/i);
  if (px) {
    const n = Number.parseFloat(px[1]);
    if (!Number.isFinite(n) || n === 0 || Math.abs(n) === 1) return value;
    return `calc(${n} * var(--dpt))`;
  }
  const rem = trimmed.match(/^(-?\d+(?:\.\d+)?)rem$/i);
  if (rem) {
    const n = Number.parseFloat(rem[1]);
    if (!Number.isFinite(n) || n === 0) return value;
    const pxValue = n * REM_PX;
    const rounded = Math.round(pxValue * 1000) / 1000;
    return `calc(${rounded} * var(--dpt))`;
  }
  return value;
};

const plugin = () => ({
  postcssPlugin: 'openchamber-dpt-font-size',
  Declaration(decl) {
    if (!shouldRewriteProp(decl.prop)) return;
    const next = rewriteLengthToDesignPt(decl.value);
    if (next !== decl.value) decl.value = next;
  },
});

plugin.postcss = true;

export default plugin;
