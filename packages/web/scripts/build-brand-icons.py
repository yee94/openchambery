"""Derive Web assets from the approved Yuri vector-B export directory."""
import argparse
import re
from pathlib import Path
from PIL import Image

parser = argparse.ArgumentParser()
parser.add_argument("source", type=Path, help="Directory containing the approved yuri-b SVG/PNG exports")
args = parser.parse_args()
public = Path(__file__).resolve().parents[1] / "public"
light = Image.open(args.source / "yuri-b-icon-light-1024.png").convert("RGBA")
dark = Image.open(args.source / "yuri-b-icon-dark-1024.png").convert("RGBA")
sizes = {
    "favicon.png": 64, "favicon-16.png": 16, "favicon-32.png": 32,
    "apple-touch-icon.png": 180, "pwa-192.png": 192, "pwa-512.png": 512,
    "pwa-maskable-192.png": 192, "pwa-maskable-512.png": 512,
    "logo-light-192x192.png": 192,
}
for size in (120, 152, 167, 180):
    sizes[f"apple-touch-icon-{size}x{size}.png"] = size
for name, size in sizes.items():
    image = light
    if name.startswith(("pwa-maskable", "apple-touch")):
        background = Image.new("RGBA", light.size, (255, 255, 255, 255))
        background.alpha_composite(light)
        image = background
    image.resize((size, size), Image.Resampling.LANCZOS).save(public / name)
dark.resize((192, 192), Image.Resampling.LANCZOS).save(public / "logo-dark-192x192.png")
for name in ("favicon.svg", "apple-touch-icon.svg", "logo-light-512x512.svg"):
    (public / name).write_bytes((args.source / "yuri-b-icon-light.svg").read_bytes())
(public / "logo-dark-512x512.svg").write_bytes((args.source / "yuri-b-icon-dark.svg").read_bytes())
mark = (args.source / "yuri-b-mark-black.svg").read_text()
body = re.search(r"<svg[^>]*>(.*)</svg>", mark, re.S).group(1).replace('#000000', 'var(--splash-logo-fill)')
index = public.parent / "index.html"
html = index.read_text()
html = re.sub(r'(<svg[^>]*aria-label="Yuri loading icon"[^>]*>).*?(</svg>)', lambda m: m[1] + body + m[2], html, count=1, flags=re.S)
index.write_text(html)
