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
for (const name of ['app-icon.svg', 'icon-win.svg']) fs.copyFileSync(path.join(canonical, 'yuri-icon-dark.svg'), path.join(icons, name));
fs.copyFileSync(path.join(canonical, 'yuri-mark-black.svg'), path.join(icons, 'tray/tray-glyph.svg'));
execFileSync('python3', ['-c', `
from PIL import Image, ImageDraw
from pathlib import Path
import math, sys
p = Path(sys.argv[1])
base = Image.open(p/'source/yuri-icon-dark-1024.png').convert('RGBA')
for name in ['icon.png', 'app-icon.png', 'dev-icon.png']:
    base.save(p/name)
base.save(p/'icon.ico', sizes=[(s,s) for s in [16,24,32,48,64,128,256]])
base.save(p/'icon.icns')
base.save(p/'dev-icon.icns')
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
for (const appearance of ['dark', 'light']) fs.copyFileSync(path.join(canonical, `yuri-icon-${appearance}-1024.png`), path.join(assets, `yuri-${appearance}.png`));
console.log('Yuri canonical desktop, Windows, Linux and tray icons regenerated.');
