"""Trace the GPT image 2.5 Yuri lettering and export standalone vector assets."""

import json
from pathlib import Path
from xml.etree import ElementTree as ET

from PIL import Image, ImageChops, ImageDraw, ImageOps

import trace_helpers as trace
from render_helpers import colored, path_d

OUT = Path(__file__).resolve().parent
CONTENT_HEIGHT = 256
PADDING = 12
SOURCE_CROP = (180, 140, 1340, 660)


def trace_wordmark():
    source = Image.open(OUT / "wordmark-source.png").convert("RGBA")
    paper = Image.new("RGBA", source.size, "white")
    paper.alpha_composite(source)
    gray = paper.convert("L").crop(SOURCE_CROP)
    bounds = gray.point(lambda value: 255 if value < 128 else 0).getbbox()
    if bounds is None:
        raise ValueError("The source contains no dark lettering")
    field = ImageOps.expand(gray.crop(bounds), border=8, fill=255)
    loops = [loop for loop in trace.link(trace.marching_squares(field)) if abs(trace.area(loop)) > 40]
    if len(loops) != 4:
        raise ValueError(f"Expected Y, joined ur, i stem and dot, found {len(loops)} contours")
    shapes = [trace.simplify(trace.smooth_loop(loop, radius=2, passes=1), 0.32) for loop in loops]
    shapes.sort(key=lambda shape: min(x for x, _ in shape))
    x0 = min(x for shape in shapes for x, _ in shape)
    y0 = min(y for shape in shapes for _, y in shape)
    x1 = max(x for shape in shapes for x, _ in shape)
    y1 = max(y for shape in shapes for _, y in shape)
    scale = CONTENT_HEIGHT / (y1 - y0)
    normalized = [[(round((x - x0) * scale + PADDING, 3), round((y - y0) * scale + PADDING, 3)) for x, y in shape] for shape in shapes]
    return {
        "word": "Yuri",
        "sourceModel": "image 2.5",
        "design": "round-2-option-1-sculpted",
        "sourceCrop": list(SOURCE_CROP),
        "viewBox": [0, 0, round((x1 - x0) * scale + PADDING * 2, 3), CONTENT_HEIGHT + PADDING * 2],
        "letters": {"Y": [normalized[0]], "ur": [normalized[1]], "i": normalized[2:]},
    }


def word_body(data, fill):
    return "".join(
        f'<g id="letter-{letter}" fill="{fill}" fill-rule="evenodd">'
        + "".join(f'<path d="{path_d(shape)}"/>' for shape in shapes)
        + '</g>'
        for letter, shapes in data["letters"].items()
    )


def svg_document(width, height, body):
    return f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {width} {height}" role="img" aria-label="Yuri"><title>Yuri</title>{body}</svg>\n'


def shape_mask(size, shapes, scale, offset=(0, 0)):
    mask = Image.new("L", size, 0)
    for shape in shapes:
        layer = Image.new("L", size, 0)
        ImageDraw.Draw(layer).polygon([(x * scale + offset[0], y * scale + offset[1]) for x, y in shape], fill=255)
        mask = ImageChops.difference(mask, layer)
    return mask


def render_word(data, width, rgb):
    view_w, view_h = data["viewBox"][2:]
    height = round(width * view_h / view_w)
    scale = width * 4 / view_w
    shapes = [shape for letter in data["letters"].values() for shape in letter]
    mask = shape_mask((width * 4, height * 4), shapes, scale)
    return colored(mask.resize((width, height), Image.Resampling.LANCZOS), rgb)


def render_lockup(data, mark_shapes, width, rgb):
    word_scale, word_x, word_y = 0.64, 256, (256 - data["viewBox"][3] * 0.64) / 2
    view_w, view_h = word_x + data["viewBox"][2] * word_scale + 16, 256
    height = round(width * view_h / view_w)
    scale = width * 4 / view_w
    size = (width * 4, height * 4)
    mark = shape_mask(size, mark_shapes, 2.56 * scale)
    shapes = [shape for letter in data["letters"].values() for shape in letter]
    word = shape_mask(size, shapes, word_scale * scale, (word_x * scale, word_y * scale))
    return colored(ImageChops.lighter(mark, word).resize((width, height), Image.Resampling.LANCZOS), rgb)


def main():
    data = trace_wordmark()
    (OUT / "wordmark-traced.json").write_text(json.dumps(data, indent=2) + "\n")
    width, height = data["viewBox"][2:]
    mark_root = ET.parse(OUT / "yuri-b-mark-black.svg").getroot()
    mark_paths = [element.attrib["d"] for element in mark_root.iter() if element.tag.endswith("}path")]
    mark_shapes = json.loads((OUT / "traced.json").read_text())["shapes"]
    for name, fill in (("black", "#000000"), ("white", "#FFFFFF"), ("current", "currentColor")):
        (OUT / f"yuri-wordmark-{name}.svg").write_text(svg_document(width, height, word_body(data, fill)))
        mark = f'<g transform="scale(2.56)" fill="{fill}" fill-rule="evenodd">' + "".join(f'<path d="{d}"/>' for d in mark_paths) + '</g>'
        word = f'<g transform="translate(256 {(256 - height * 0.64) / 2:.3f}) scale(0.64)">{word_body(data, fill)}</g>'
        (OUT / f"yuri-lockup-{name}.svg").write_text(svg_document(round(272 + width * 0.64, 3), 256, mark + word))
        if name != "current":
            rgb = (0, 0, 0) if name == "black" else (255, 255, 255)
            render_word(data, 1600, rgb).save(OUT / f"yuri-wordmark-{name}.png")
            render_lockup(data, mark_shapes, 1600, rgb).save(OUT / f"yuri-lockup-{name}.png")

    board = Image.new("RGBA", (1600, 1000), "white")
    board.alpha_composite(render_word(data, 1160, (0, 0, 0)), (220, 55))
    draw = ImageDraw.Draw(board)
    draw.rectangle((0, 610, 799, 999), fill=(244, 243, 240))
    draw.rectangle((800, 610, 1599, 999), fill=(28, 28, 28))
    for x, rgb in ((60, (0, 0, 0)), (860, (255, 255, 255))):
        lockup = render_lockup(data, mark_shapes, 680, rgb)
        board.alpha_composite(lockup, (x, 610 + (390 - lockup.height) // 2))
    board.convert("RGB").save(OUT / "yuri-wordmark-board.png")
    contours = sum(len(shapes) for shapes in data["letters"].values())
    print(f"Exported Yuri: {len(data['letters'])} letter groups, {contours} contours, viewBox {width} × {height}")


if __name__ == "__main__":
    main()
