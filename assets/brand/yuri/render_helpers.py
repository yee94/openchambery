"""Shared rendering primitives preserved from the approved vector-B pipeline."""

from PIL import Image, ImageFont


ICON_THEMES = {
    "light": {"top": (255, 255, 255), "bottom": (229, 227, 223), "mark": (28, 27, 26), "edge": (0, 0, 0, 22), "shadow": 70},
    "dark": {"top": (60, 59, 57), "bottom": (17, 17, 16), "mark": (244, 242, 238), "edge": (255, 255, 255, 26), "shadow": 110},
}


def colored(mask, rgb):
    img = Image.new("RGBA", mask.size, rgb + (255,))
    img.putalpha(mask)
    return img


def path_d(points):
    head, *rest = points
    return "M{:.2f} {:.2f}".format(*head) + "".join("L{:.2f} {:.2f}".format(x, y) for x, y in rest) + "Z"


def hex_rgb(rgb):
    return "#{:02X}{:02X}{:02X}".format(*rgb)


def load_font(size):
    for path in ("/System/Library/Fonts/Avenir Next.ttc", "/System/Library/Fonts/HelveticaNeue.ttc"):
        for index in range(12):
            try:
                font = ImageFont.truetype(path, size, index=index)
            except OSError:
                break
            if font.getname()[1] in ("Regular", "Medium"):
                return font
    return ImageFont.load_default(size)


def draw_spaced(draw, xy, text, font, fill, tracking):
    x, y = xy
    for ch in text:
        draw.text((x, y), ch, font=font, fill=fill)
        x += draw.textlength(ch, font=font) + tracking


def spaced_width(draw, text, font, tracking):
    return sum(draw.textlength(ch, font=font) for ch in text) + tracking * (len(text) - 1)
