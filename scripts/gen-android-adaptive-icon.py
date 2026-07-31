#!/usr/bin/env python3
"""Generate Android adaptive-icon foregrounds from the shared brand asset.

The shared asset (packages/mobile/assets/icon-only.png) is a finished icon card:
a rounded dark square with the cube mark on top. Adaptive icons must supply the
mark alone, otherwise launchers composite that card over the adaptive background
and the icon reads as two stacked layers. This isolates the cube via its
hexagonal silhouette and lays it out inside the 66dp safe zone.
"""

from pathlib import Path

from PIL import Image, ImageDraw

REPO = Path(__file__).resolve().parents[1]
SOURCE = REPO / "packages/mobile/assets/icon-only.png"
RES = REPO / "packages/mobile/android/app/src/main/res"

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
BLEED = 3.0
SUPERSAMPLE = 4

# Adaptive icons are a 108dp canvas with a 72dp viewport and a 66dp safe zone.
# 56dp keeps the mark inside the safe zone and leaves visible padding.
CANVAS_DP = 108
MARK_HEIGHT_DP = 56
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


def main() -> None:
    mark = extract_mark()
    aspect = mark.width / mark.height

    for density, canvas in DENSITIES.items():
        height = round(canvas * MARK_HEIGHT_DP / CANVAS_DP)
        width = round(height * aspect)
        scaled = mark.resize((width, height), Image.LANCZOS)

        out = Image.new("RGBA", (canvas, canvas), (0, 0, 0, 0))
        out.paste(scaled, ((canvas - width) // 2, (canvas - height) // 2))

        target = RES / f"mipmap-{density}/ic_launcher_foreground.png"
        out.save(target)
        print(f"{target.relative_to(REPO)} {canvas}x{canvas} mark={width}x{height}")


if __name__ == "__main__":
    main()
