"""Build scheme B (sage profile) SVG + PNG deliverables, mirroring the scheme A pipeline."""
import json
from pathlib import Path

from PIL import Image, ImageChops, ImageDraw, ImageFilter

OUT = Path(__file__).resolve().parent
import render_helpers as base

SHAPES = json.loads((OUT / "traced.json").read_text())["shapes"]
ICON_SCALE = 6.4
MARK_CENTER = (50.0, 50.0)


def mark_mask(size, k, ox, oy):
    """Even-odd fill: holes (eye) are carved out of the silhouette."""
    mask = Image.new("L", (size, size), 0)
    for shape in SHAPES:
        layer = Image.new("L", (size, size), 0)
        ImageDraw.Draw(layer).polygon([(ox + x * k, oy + y * k) for x, y in shape], fill=255)
        mask = ImageChops.difference(mask, layer)
    return mask


def render_mark(size, rgb, ss=4):
    s = size * ss
    m = mark_mask(s, s / 100, 0, 0).resize((size, size), Image.LANCZOS)
    return base.colored(m, rgb)


def render_icon(size, theme, ss=4):
    t = base.ICON_THEMES[theme]
    s = size * ss
    u = s / 1024
    canvas = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    box = [100 * u, 100 * u, 924 * u, 924 * u]
    radius = 185 * u
    shadow = Image.new("L", (s, s), 0)
    ImageDraw.Draw(shadow).rounded_rectangle([box[0], box[1] + 12 * u, box[2], box[3] + 12 * u], radius, fill=t["shadow"])
    canvas.alpha_composite(base.colored(shadow.filter(ImageFilter.GaussianBlur(18 * u)), (0, 0, 0)))
    grad = Image.new("RGBA", (s, s))
    gd = ImageDraw.Draw(grad)
    for y in range(s):
        f = min(1.0, max(0.0, (y - box[1]) / (box[3] - box[1])))
        gd.line([(0, y), (s, y)], fill=tuple(round(t["top"][i] + (t["bottom"][i] - t["top"][i]) * f) for i in range(3)) + (255,))
    tile = Image.new("L", (s, s), 0)
    ImageDraw.Draw(tile).rounded_rectangle(box, radius, fill=255)
    grad.putalpha(tile)
    canvas.alpha_composite(grad)
    edge = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    ImageDraw.Draw(edge).rounded_rectangle(box, radius, outline=t["edge"], width=max(1, round(2 * u)))
    canvas.alpha_composite(edge)
    k = ICON_SCALE * u
    canvas.alpha_composite(base.colored(mark_mask(s, k, 512 * u - MARK_CENTER[0] * k, 512 * u - MARK_CENTER[1] * k), t["mark"]))
    return canvas.resize((size, size), Image.LANCZOS)


def mark_body(fill):
    d = "".join(base.path_d(s) for s in SHAPES)
    return f'<path fill="{fill}" fill-rule="evenodd" d="{d}"/>'


def write_svgs():
    for name, fill in (("black", "#000000"), ("white", "#FFFFFF")):
        (OUT / f"yuri-b-mark-{name}.svg").write_text(
            f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">{mark_body(fill)}</svg>\n'
        )
    for theme, t in base.ICON_THEMES.items():
        ox = 512 - MARK_CENTER[0] * ICON_SCALE
        oy = 512 - MARK_CENTER[1] * ICON_SCALE
        svg = (
            '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024">'
            '<defs><linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">'
            f'<stop offset="0" stop-color="{base.hex_rgb(t["top"])}"/><stop offset="1" stop-color="{base.hex_rgb(t["bottom"])}"/>'
            "</linearGradient></defs>"
            '<rect x="100" y="100" width="824" height="824" rx="185" fill="url(#bg)"/>'
            f'<g transform="translate({ox:.2f} {oy:.2f}) scale({ICON_SCALE})">{mark_body(base.hex_rgb(t["mark"]))}</g>'
            "</svg>\n"
        )
        (OUT / f"yuri-b-icon-{theme}.svg").write_text(svg)


def build_board():
    W, H = 2400, 1600
    board = Image.new("RGBA", (W, H), (255, 255, 255, 255))
    d = ImageDraw.Draw(board)
    caption = base.load_font(30)
    gray = (140, 138, 134)
    board.alpha_composite(render_mark(620, (0, 0, 0)), (130, 90))
    word = base.load_font(118)
    ww = base.spaced_width(d, "yuri", word, 40)
    base.draw_spaced(d, (130 + 310 - ww / 2, 690), "yuri", word, (0, 0, 0), 40)
    d.rectangle([900, 110, 1520, 730], fill=(0, 0, 0))
    board.alpha_composite(render_mark(500, (255, 255, 255)), (960, 170))
    d.text((900, 760), "White on solid black", font=caption, fill=gray)
    d.rectangle([1640, 110, 2260, 730], fill=(236, 234, 230))
    board.alpha_composite(render_mark(500, (0, 0, 0)), (1700, 170))
    d.text((1640, 760), "Black on solid stone", font=caption, fill=gray)
    board.alpha_composite(render_icon(520, "light"), (110, 880))
    d.text((300, 1410), "macOS Light", font=caption, fill=gray)
    board.alpha_composite(render_icon(520, "dark"), (670, 880))
    d.text((865, 1410), "macOS Dark", font=caption, fill=gray)
    x = 1240
    for sz in (256, 128, 64, 32, 16):
        board.alpha_composite(render_icon(sz, "light"), (x, 1000))
        board.alpha_composite(render_icon(sz, "dark"), (x, 1270))
        x += sz + 46
    d.text((1240, 940), "256 / 128 / 64 / 32 / 16 px", font=caption, fill=gray)
    for row, theme in enumerate(("light", "dark")):
        board.alpha_composite(render_icon(32, theme).resize((256, 256), Image.NEAREST), (2040, 1000 + row * 270))
    d.text((2040, 940), "32 px  x8", font=caption, fill=gray)
    return board.convert("RGB")


if __name__ == "__main__":
    write_svgs()
    render_mark(1024, (0, 0, 0)).save(OUT / "yuri-b-mark-black-1024.png")
    render_mark(1024, (255, 255, 255)).save(OUT / "yuri-b-mark-white-1024.png")
    for theme in base.ICON_THEMES:
        render_icon(1024, theme).save(OUT / f"yuri-b-icon-{theme}-1024.png")
        for sz in (16, 32):
            render_icon(sz, theme).save(OUT / f"yuri-b-icon-{theme}-{sz}.png")
    build_board().save(OUT / "yuri-b-board.png")
    print("ok")
