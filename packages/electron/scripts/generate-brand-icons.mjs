import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const icons = fileURLToPath(new URL('../resources/icons/', import.meta.url));
const source = process.argv[2];
const canonical = path.join(icons, 'source');
fs.mkdirSync(canonical, { recursive: true });
if (source) {
  for (const name of ['icon-light.svg', 'icon-dark.svg', 'mark-black.svg', 'mark-white.svg', 'icon-light-1024.png', 'icon-dark-1024.png', 'mark-black-1024.png', 'mark-white-1024.png']) {
    fs.copyFileSync(path.join(source, `yuri-b-${name}`), path.join(canonical, `yuri-${name}`));
  }
}
const desktopSvg = fs.readFileSync(path.join(canonical, 'yuri-icon-light.svg'), 'utf8')
  .replace('viewBox="0 0 1024 1024"', 'viewBox="100 100 824 824"');
for (const name of ['app-icon.svg', 'icon-win.svg']) fs.writeFileSync(path.join(icons, name), desktopSvg);
fs.copyFileSync(path.join(canonical, 'yuri-mark-black.svg'), path.join(icons, 'tray/tray-glyph.svg'));
execFileSync('python3', ['-c', `
from PIL import Image, ImageDraw
from pathlib import Path
from xml.etree import ElementTree
import math, sys
p = Path(sys.argv[1])
assets = p/'AppIcon.icon/Assets'
assets.mkdir(parents=True, exist_ok=True)
for appearance, mark_name in [('light', 'black'), ('dark', 'white')]:
    svg = ElementTree.parse(p/f'source/yuri-icon-{appearance}.svg')
    stops = svg.findall('.//{*}stop')
    colors = [tuple(bytes.fromhex(stop.attrib['stop-color'].lstrip('#'))) for stop in stops]
    tile = Image.new('RGBA', (1024, 1024))
    draw = ImageDraw.Draw(tile)
    for y in range(1024):
        draw.line((0, y, 1023, y), fill=tuple(round(a+(b-a)*y/1023) for a,b in zip(*colors))+(255,))
    mark = Image.open(p/f'source/yuri-mark-{mark_name}-1024.png').convert('RGBA')
    mark = mark.resize((795,795), Image.Resampling.LANCZOS)
    ink = tuple(bytes.fromhex(svg.find('.//{*}path').attrib['fill'].lstrip('#')))
    portrait = Image.new('RGBA', mark.size, ink+(255,))
    portrait.putalpha(mark.getchannel('A'))
    tile.alpha_composite(portrait, (114,114))
    # Icon Composer owns the outer shape; its layers must be full bleed.
    tile.save(assets/f'yuri-{appearance}.png')
    if appearance == 'light':
        base = tile.copy()
mask = Image.new('L', (4096,4096), 0)
ImageDraw.Draw(mask).rounded_rectangle((0,0,4095,4095), radius=920, fill=255)
base.putalpha(mask.resize(base.size, Image.Resampling.LANCZOS))
for name in ['icon.png', 'app-icon.png', 'dev-icon.png']:
    base.save(p/name)
base.save(p/'icon.ico', sizes=[(s,s) for s in [16,24,32,48,64,128,256]])
mac = Image.new('RGBA', (1024,1024), (0,0,0,0))
mac.alpha_composite(base.resize((824,824), Image.Resampling.LANCZOS), (100,100))
mac.save(p/'icon.icns')
mac.save(p/'dev-icon.icns')
mark = Image.open(p/'source/yuri-mark-black-1024.png').convert('RGBA')
for scale in [1,2]:
    suffix = '@2x' if scale == 2 else ''
    small = mark.resize((18*scale,18*scale),Image.Resampling.LANCZOS)
    small.save(p/f'tray/trayTemplate-idle{suffix}.png')
    unseen = small.copy()
    ImageDraw.Draw(unseen).ellipse((14*scale,0,18*scale,4*scale),fill=(0,0,0,255))
    unseen.save(p/f'tray/trayTemplate-unseen{suffix}.png')
    for frame in range(16):
        image = small.copy()
        opacity = .45+.55*(1+math.cos(2*math.pi*frame/16))/2
        image.putalpha(image.getchannel('A').point(lambda value: round(value*opacity)))
        image.save(p/f'tray/trayTemplate-breath-{frame:02d}{suffix}.png')
`, icons], { stdio: 'inherit' });
const assets = path.join(icons, 'AppIcon.icon/Assets');
fs.mkdirSync(assets, { recursive: true });
for (const obsolete of ['app-icon-glyph-dark 4.png', 'app-icon-glyph-light 2.png']) fs.rmSync(path.join(assets, obsolete), { force: true });
console.log('Yuri canonical desktop, Windows, Linux and tray icons regenerated.');
