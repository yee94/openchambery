"""Trace the sage-profile mark (scheme B) 1:1 from the approved draft into clean vector outlines."""
import json
from pathlib import Path

OUT = Path(__file__).resolve().parent
import trace_helpers as trace

from PIL import Image, ImageFilter  # noqa: E402

trace.SRC = OUT / "source-preview.png"
trace.CROP = (158, 155, 625, 688)


def main():
    im = Image.open(trace.SRC).convert("L").crop(trace.CROP)
    im = im.resize((im.width * trace.UP, im.height * trace.UP), Image.LANCZOS)
    im = im.filter(ImageFilter.GaussianBlur(trace.UP * 0.5))
    loops = [l for l in trace.link(trace.marching_squares(im)) if abs(trace.area(l)) > trace.MIN_AREA * trace.UP * trace.UP]
    shapes = [trace.simplify(trace.smooth_loop(l), 0.08) for l in loops]
    xs = [p[0] for s in shapes for p in s]
    ys = [p[1] for s in shapes for p in s]
    x0, x1, y0, y1 = min(xs), max(xs), min(ys), max(ys)
    k = 88.0 / max(x1 - x0, y1 - y0)
    ox = 50 - (x0 + x1) / 2 * k
    oy = 50 - (y0 + y1) / 2 * k
    norm = [[(round(ox + x * k, 3), round(oy + y * k, 3)) for x, y in s] for s in shapes]
    info = []
    for s in norm:
        sx = [p[0] for p in s]
        sy = [p[1] for p in s]
        info.append({"area": round(trace.area(s), 1), "bbox": [round(min(sx), 1), round(min(sy), 1), round(max(sx), 1), round(max(sy), 1)], "n": len(s)})
    (OUT / "traced.json").write_text(json.dumps({"shapes": norm}))
    print(json.dumps(info, indent=1))


if __name__ == "__main__":
    main()
