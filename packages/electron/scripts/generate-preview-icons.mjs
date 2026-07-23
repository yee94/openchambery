/**
 * Generate preview-marked desktop icons from the production icon.png.
 * Produces:
 *   resources/icons/preview-icon.png
 *   resources/icons/preview-icon.icns  (macOS)
 *   resources/icons/preview-icon.ico  (Windows)
 *
 * Requires Pillow (python3 -c "import PIL"). macOS also uses sips + iconutil.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const iconsDir = path.join(root, 'resources', 'icons');
const sourcePng = path.join(iconsDir, 'icon.png');
const outPng = path.join(iconsDir, 'preview-icon.png');
const outIcns = path.join(iconsDir, 'preview-icon.icns');
const outIco = path.join(iconsDir, 'preview-icon.ico');

const run = (command, args, options = {}) => {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    stdio: options.capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
  });
  if (result.status !== 0) {
    const detail = options.capture ? `${result.stdout || ''}${result.stderr || ''}` : '';
    throw new Error(`${command} ${args.join(' ')} failed (${result.status}): ${detail}`);
  }
  return result.stdout || '';
};

if (!fs.existsSync(sourcePng)) {
  throw new Error(`Missing source icon at ${sourcePng}`);
}

const py = `
from PIL import Image, ImageDraw, ImageFont
from io import BytesIO
import sys

src, out_png, out_ico = sys.argv[1], sys.argv[2], sys.argv[3]
base = Image.open(src).convert('RGBA')
w, h = base.size
img = base.copy()
layer = Image.new('RGBA', base.size, (0, 0, 0, 0))
draw = ImageDraw.Draw(layer)

# Small blue corner tag (top-left). Keep the product mark otherwise unchanged.
# Geometry is relative so it stays legible at 64–128px dock sizes without
# covering the cube.
pad = max(28, w // 28)
tag_h = max(72, h // 11)
font = None
for size in (max(34, h // 22), max(28, h // 26), 24):
    try:
        font = ImageFont.truetype('/System/Library/Fonts/Supplemental/Arial Bold.ttf', size)
        break
    except Exception:
        try:
            font = ImageFont.truetype('/System/Library/Fonts/Helvetica.ttc', size)
            break
        except Exception:
            continue
if font is None:
    font = ImageFont.load_default()

text = 'PREVIEW'
bbox = draw.textbbox((0, 0), text, font=font)
tw, th = bbox[2] - bbox[0], bbox[3] - bbox[1]
inner_x = max(18, w // 48)
inner_y = max(10, h // 70)
tag_w = tw + inner_x * 2
# Soft rounded pill, slightly inset from the icon edge.
x0, y0 = pad, pad
x1, y1 = x0 + tag_w, y0 + tag_h
radius = tag_h // 2
# Blue tag + subtle darker edge for contrast on light icons.
blue = (37, 99, 235, 245)       # blue-600
edge = (29, 78, 216, 255)       # blue-700
draw.rounded_rectangle((x0, y0, x1, y1), radius=radius, fill=blue, outline=edge, width=max(2, w // 400))
tx = x0 + (tag_w - tw) / 2 - bbox[0]
ty = y0 + (tag_h - th) / 2 - bbox[1] - max(1, h // 400)
draw.text((tx, ty), text, font=font, fill=(255, 255, 255, 255))

img = Image.alpha_composite(img, layer)
img.save(out_png, 'PNG')

sizes = [16, 24, 32, 48, 64, 128, 256]
buf = BytesIO()
img.save(buf, format='ICO', sizes=[(s, s) for s in sizes])
open(out_ico, 'wb').write(buf.getvalue())
print(f'wrote {out_png}')
print(f'wrote {out_ico}')
`;

run('python3', ['-c', py, sourcePng, outPng, outIco]);

// macOS .icns via iconutil
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-preview-icon-'));
const iconset = path.join(tmp, 'preview.iconset');
fs.mkdirSync(iconset);
const sizes = [
  [16, 'icon_16x16.png'],
  [32, 'diana.k@example.org'],
  [32, 'icon_32x32.png'],
  [64, 'ivan.p@example.net'],
  [128, 'icon_128x128.png'],
  [256, 'wendy.h@example.net'],
  [256, 'icon_256x256.png'],
  [512, 'wendy.h@example.net'],
  [512, 'icon_512x512.png'],
  [1024, 'walt.e@example.net'],
];
try {
  for (const [px, name] of sizes) {
    const dest = path.join(iconset, name);
    run('sips', ['-z', String(px), String(px), outPng, '--out', dest], { capture: true });
  }
  run('iconutil', ['-c', 'icns', iconset, '-o', outIcns]);
  console.log(`wrote ${outIcns}`);
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log('[electron] preview icons ready');
