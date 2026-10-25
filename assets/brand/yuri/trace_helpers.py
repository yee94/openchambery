"""Contour extraction primitives used by the approved vector-B trace."""
import math
UP = 4
THRESH = 128
MIN_AREA = 12


def marching_squares(im):
    w, h = im.size
    px = im.load()
    segs = {}

    def interp(a, b):
        return 0.5 if a == b else (THRESH - a) / (b - a)

    for y in range(h - 1):
        for x in range(w - 1):
            a, b, c, d = px[x, y], px[x + 1, y], px[x + 1, y + 1], px[x, y + 1]
            idx = (a < THRESH) | (b < THRESH) << 1 | (c < THRESH) << 2 | (d < THRESH) << 3
            if idx == 0 or idx == 15:
                continue
            edges = {
                "t": (("h", x, y), (x + interp(a, b), y)),
                "r": (("v", x + 1, y), (x + 1, y + interp(b, c))),
                "b": (("h", x, y + 1), (x + interp(d, c), y + 1)),
                "l": (("v", x, y), (x, y + interp(a, d))),
            }
            table = {
                1: [("l", "t")], 2: [("t", "r")], 3: [("l", "r")], 4: [("r", "b")],
                5: [("l", "t"), ("r", "b")], 6: [("t", "b")], 7: [("l", "b")], 8: [("b", "l")],
                9: [("b", "t")], 10: [("t", "r"), ("b", "l")], 11: [("b", "r")], 12: [("r", "l")],
                13: [("r", "t")], 14: [("t", "l")],
            }
            for e0, e1 in table[idx]:
                k0, p0 = edges[e0]
                k1, p1 = edges[e1]
                segs.setdefault(k0, []).append((k1, p0, p1))
                segs.setdefault(k1, []).append((k0, p1, p0))
    return segs


def link(segs):
    used = set()
    loops = []
    for start in list(segs):
        if start in used:
            continue
        loop, prev, cur = [], None, start
        while cur not in used:
            used.add(cur)
            nxt = [s for s in segs[cur] if s[0] != prev and s[0] not in used] or [s for s in segs[cur] if s[0] != prev]
            if not nxt:
                break
            k, p0, _ = nxt[0]
            loop.append(p0)
            prev, cur = cur, k
        if len(loop) > 8:
            loops.append(loop)
    return loops


def area(pts):
    return 0.5 * sum(pts[i - 1][0] * pts[i][1] - pts[i][0] * pts[i - 1][1] for i in range(len(pts)))


def simplify(pts, eps):
    def rdp(seq):
        if len(seq) < 3:
            return seq
        (x0, y0), (x1, y1) = seq[0], seq[-1]
        dx, dy = x1 - x0, y1 - y0
        norm = math.hypot(dx, dy) or 1e-9
        best, bi = 0.0, 0
        for i in range(1, len(seq) - 1):
            dist = abs(dy * (seq[i][0] - x0) - dx * (seq[i][1] - y0)) / norm
            if dist > best:
                best, bi = dist, i
        if best <= eps:
            return [seq[0], seq[-1]]
        return rdp(seq[: bi + 1])[:-1] + rdp(seq[bi:])

    mid = len(pts) // 2
    return rdp(pts[: mid + 1])[:-1] + rdp(pts[mid:] + [pts[0]])[:-1]


def resample(pts, step):
    closed = pts + [pts[0]]
    out, carry = [pts[0]], 0.0
    for (x0, y0), (x1, y1) in zip(closed, closed[1:]):
        seg = math.hypot(x1 - x0, y1 - y0)
        d = step - carry
        while d <= seg:
            f = d / seg
            out.append((x0 + (x1 - x0) * f, y0 + (y1 - y0) * f))
            d += step
        carry = seg - (d - step)
    return out[:-1] if len(out) > 1 else out


def turn(pts, i, span):
    n = len(pts)
    ax, ay = pts[(i - span) % n]
    bx, by = pts[i]
    cx, cy = pts[(i + span) % n]
    v1 = (bx - ax, by - ay)
    v2 = (cx - bx, cy - by)
    cosv = (v1[0] * v2[0] + v1[1] * v2[1]) / ((math.hypot(*v1) * math.hypot(*v2)) or 1e-9)
    return math.degrees(math.acos(max(-1.0, min(1.0, cosv))))


def smooth_loop(pts, radius=3, corner_deg=50, passes=2):
    pts = resample(pts, 1.0)
    n = len(pts)
    corners = {i for i in range(n) if turn(pts, i, 4) > corner_deg}
    for _ in range(passes):
        nxt = []
        for i in range(n):
            near = min((min(abs(i - c), n - abs(i - c)) for c in corners), default=n)
            r = min(radius, near)
            if r == 0:
                nxt.append(pts[i])
                continue
            sx = sy = 0.0
            for j in range(-r, r + 1):
                sx += pts[(i + j) % n][0]
                sy += pts[(i + j) % n][1]
            nxt.append((sx / (2 * r + 1), sy / (2 * r + 1)))
        pts = nxt
    return pts

