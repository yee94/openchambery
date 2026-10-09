#!/usr/bin/env python3
"""Generate mobile launcher icons from the original, unscaled brand assets.

The shared asset (packages/mobile/assets/icon-only.png) is a finished icon card:
a rounded dark square with the cube mark on top. Adaptive icons must supply the
mark alone, otherwise launchers composite that card over the adaptive background
and the icon reads as two stacked layers. This isolates the cube via its
hexagonal silhouette and lays it out inside the 66dp safe zone.
"""

import json
from pathlib import Path
from shutil import copy2

from PIL import Image, ImageDraw

REPO = Path(__file__).resolve().parents[1]
SOURCE = REPO / "packages/mobile/assets/icon-only.png"
RES = REPO / "packages/mobile/android/app/src/main/res"
IOS = REPO / "packages/mobile/ios/App/App"

# Outer corners of the cube silhouette in the 1024x1024 source, measured from
# the white stroke bounds. Order: top, upper-right, lower-right, bottom,
# lower-left, upper-left.
HEX = [
    (511.5, 190.0),
    (792.0, 352.5),
    (792.0, 667.5),
    (511.5, 833.0),
    (231.0, 667.5),
    (231.0, 352.5),
]
# Grow the silhouette so the anti-aliased outer edge of the stroke survives.
BLEED = 7.0
SUPERSAMPLE = 4

# Adaptive icons are a 108dp canvas with a 72dp viewport and a 66dp safe zone.
# 64dp keeps the complete silhouette inside the safe zone, including round masks.
CANVAS_DP = 108
MARK_HEIGHT_DP = 64
IOS_MARK_HEIGHT = 836
DENSITIES = {
    "ldpi": 81,
    "mdpi": 108,
    "hdpi": 162,
    "xhdpi": 216,
    "xxhdpi": 324,
    "xxxhdpi": 432,
}


def expanded_hexagon() -> list[tuple[float, float]]:
    cx = sum(x for x, _ in HEX) / len(HEX)
    cy = sum(y for _, y in HEX) / len(HEX)
    grown = []
    for x, y in HEX:
        dx, dy = x - cx, y - cy
        length = (dx * dx + dy * dy) ** 0.5
        grown.append((x + dx / length * BLEED, y + dy / length * BLEED))
    return grown


def extract_mark() -> Image.Image:
    source = Image.open(SOURCE).convert("RGBA")
    polygon = expanded_hexagon()

    mask = Image.new("L", (source.width * SUPERSAMPLE, source.height * SUPERSAMPLE), 0)
    ImageDraw.Draw(mask).polygon(
        [(x * SUPERSAMPLE, y * SUPERSAMPLE) for x, y in polygon], fill=255
    )
    mask = mask.resize(source.size, Image.LANCZOS)

    cut = Image.new("RGBA", source.size, (0, 0, 0, 0))
    cut.paste(source, mask=mask)
    return cut.crop(cut.getbbox())


def centered_mark(mark: Image.Image, canvas: int, height: int) -> Image.Image:
    aspect = mark.width / mark.height
    scaled = mark.resize((round(height * aspect), height), Image.LANCZOS)
    out = Image.new("RGBA", (canvas, canvas), (0, 0, 0, 0))
    out.alpha_composite(scaled, ((canvas - scaled.width) // 2, (canvas - height) // 2))
    return out


def background(canvas: int) -> Image.Image:
    # Same dark gradient as the existing Android adaptive background.
    out = Image.new("RGB", (canvas, canvas))
    draw = ImageDraw.Draw(out)
    for y in range(canvas):
        shade = round(48 + (19 - 48) * y / (canvas - 1))
        draw.line((0, y, canvas - 1, y), fill=(shade, shade, shade))
    return out


def generate_ios(mark: Image.Image) -> None:
    icon = background(1024).convert("RGBA")
    icon.alpha_composite(centered_mark(mark, 1024, IOS_MARK_HEIGHT))
    icon.convert("RGB").save(IOS / "Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png")

    # Keep the existing glass artwork, with mobile-only sizing. Desktop uses
    # its original Composer document and dock-specific padding.
    source = REPO / "packages/electron/resources/icons/AppIcon.icon"
    target = IOS / "AppIcon.icon"
    (target / "Assets").mkdir(parents=True, exist_ok=True)
    document = json.loads((source / "icon.json").read_text())
    for group in document["groups"]:
        for layer in group["layers"]:
            copy2(source / "Assets" / layer["image-name"], target / "Assets" / layer["image-name"])
            if not layer.get("hidden"):
                layer["position-specializations"] = [{
                    "idiom": "square",
                    "value": {"scale": 1.30, "translation-in-points": [0, 0]},
                }]
    (target / "icon.json").write_text(json.dumps(document, indent=2) + "\n")


def main() -> None:
    mark = extract_mark()
    generate_ios(mark)

    for density, canvas in DENSITIES.items():
        height = round(canvas * MARK_HEIGHT_DP / CANVAS_DP)
        out = centered_mark(mark, canvas, height)

        target = RES / f"mipmap-{density}/ic_launcher_foreground.png"
        out.save(target)
        print(f"{target.relative_to(REPO)} {canvas}x{canvas} mark-height={height}")

        # Pre-adaptive launchers consume these PNGs directly. Match the adaptive
        # viewport size and preserve both the rounded-square and round variants.
        viewport = 768
        legacy = background(viewport).convert("RGBA")
        legacy.alpha_composite(centered_mark(mark, viewport, round(viewport * MARK_HEIGHT_DP / 72)))
        size = round(canvas * 48 / CANVAS_DP)
        for name, circular in [("ic_launcher.png", False), ("ic_launcher_round.png", True)]:
            mask = Image.new("L", (viewport, viewport))
            draw = ImageDraw.Draw(mask)
            if circular:
                draw.ellipse((0, 0, viewport - 1, viewport - 1), fill=255)
            else:
                draw.rounded_rectangle((0, 0, viewport - 1, viewport - 1), radius=viewport * 0.225, fill=255)
            shaped = legacy.copy()
            shaped.putalpha(mask)
            shaped.resize((size, size), Image.LANCZOS).save(RES / f"mipmap-{density}" / name)


if __name__ == "__main__":
    main()
