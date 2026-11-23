# The ants' lost look: on a painted ant, find its two eye whites, lift each pupil out, fill the eye with its white and set
# the pupil back near the eye's outer edge, the two looking away from each other (one a little up, the other a little down), a touch smaller
# so the eyes look wider. Works on cut-outs (RGBA, transparent around) and on renders on white (the background white touches the border).
# Usage: python3 derp-eyes.py in.png out.png [scale] [push]   (scale of the pupil, default .72; push 0..1 of the way to the edge, default 1.0)
# One ant per file: crop to one head first. On a whole painting it takes the two largest white areas, which may not be eyes.
import sys, math
from PIL import Image, ImageFilter

def lum(p): return 0.3 * p[0] + 0.59 * p[1] + 0.11 * p[2]

def derp(im, scale=0.72, push=1.0, tilt=(-0.45, 0.35), white=205):
    im = im.convert('RGBA'); W, H = im.size; px = im.load()
    isw = lambda x, y: px[x, y][3] > 200 and lum(px[x, y]) > white
    seen = bytearray(W * H); comps = []
    for y0 in range(H):
        for x0 in range(W):
            if seen[y0 * W + x0] or not isw(x0, y0): continue
            stack = [(x0, y0)]; seen[y0 * W + x0] = 1; pts = []; edge = False
            while stack:
                x, y = stack.pop(); pts.append((x, y))
                if x == 0 or y == 0 or x == W - 1 or y == H - 1: edge = True
                for q in ((x + 1, y), (x - 1, y), (x, y + 1), (x, y - 1)):
                    if 0 <= q[0] < W and 0 <= q[1] < H and not seen[q[1] * W + q[0]] and isw(*q):
                        seen[q[1] * W + q[0]] = 1; stack.append(q)
            if not edge and len(pts) > 40: comps.append(pts)
    comps.sort(key=len, reverse=True)
    if len(comps) < 2 or len(comps[1]) < 0.25 * len(comps[0]): return im, 'no two eyes'
    eyes = []
    for pts in comps[:2]:
        xs = [p[0] for p in pts]; ys = [p[1] for p in pts]
        bx0, by0, bx1, by1 = min(xs), min(ys), max(xs), max(ys)
        inside = set(pts)
        # the holes inside the white: the pupil (and its shine); found as what the outside can't reach inside the white's box
        out = set(); stack = []
        for x in range(bx0 - 1, bx1 + 2):
            for y in (by0 - 1, by1 + 1): stack.append((x, y))
        for y in range(by0 - 1, by1 + 2):
            for x in (bx0 - 1, bx1 + 1): stack.append((x, y))
        while stack:
            q = stack.pop()
            if q in out or q in inside or not (bx0 - 1 <= q[0] <= bx1 + 1 and by0 - 1 <= q[1] <= by1 + 1): continue
            out.add(q)
            x, y = q; stack += [(x + 1, y), (x - 1, y), (x, y + 1), (x, y - 1)]
        holes = [(x, y) for x in range(bx0, bx1 + 1) for y in range(by0, by1 + 1) if (x, y) not in inside and (x, y) not in out]
        if len(holes) < 0.004 * len(pts):
            # the pupil touches the eye's rim, so it isn't a hole: take the eye as the ellipse round its white, a little inside its outline,
            # and the pupil as the dark pixels in it
            ecx, ecy = (bx0 + bx1) / 2, (by0 + by1) / 2; erx, ery = (bx1 - bx0) / 2 + 1, (by1 - by0) / 2 + 1
            holes = [(x, y) for x in range(int(ecx - erx), int(ecx + erx) + 1) for y in range(int(ecy - ery), int(ecy + ery) + 1)
                     if 0 <= x < W and 0 <= y < H and ((x - ecx) / erx) ** 2 + ((y - ecy) / ery) ** 2 <= 0.86
                     and (x, y) not in inside and px[x, y][3] > 200 and lum(px[x, y]) < 170]
            if len(holes) < 0.004 * len(pts): return im, 'no pupil found'
        eyes.append(dict(white=pts, holes=holes, box=(bx0, by0, bx1, by1)))
    mid = [sum((e['box'][0] + e['box'][2]) / 2 for e in eyes) / 2, sum((e['box'][1] + e['box'][3]) / 2 for e in eyes) / 2]
    eyes.sort(key=lambda e: e['box'][0])
    out = im.copy(); op = out.load()
    for i, e in enumerate(eyes):
        body = set(e['white']) | set(e['holes'])
        cx = sum(p[0] for p in body) / len(body); cy = sum(p[1] for p in body) / len(body)
        rx = (e['box'][2] - e['box'][0]) / 2; ry = (e['box'][3] - e['box'][1]) / 2
        hx = [p[0] for p in e['holes']]; hy = [p[1] for p in e['holes']]
        pb = (min(hx), min(hy), max(hx) + 1, max(hy) + 1)
        pcx = (pb[0] + pb[2]) / 2; pcy = (pb[1] + pb[3]) / 2; pr = max(pb[2] - pb[0], pb[3] - pb[1]) / 2
        # the pupil as a sprite: its pixels, a soft edge
        mask = Image.new('L', (W, H), 0); mp = mask.load()
        for p in e['holes']: mp[p] = 255
        mask = mask.filter(ImageFilter.MaxFilter(3)).filter(ImageFilter.GaussianBlur(0.6))
        pad = 2; box = (max(0, pb[0] - pad), max(0, pb[1] - pad), min(W, pb[2] + pad), min(H, pb[3] + pad))
        spr = im.crop(box); spr.putalpha(mask.crop(box))
        nw, nh = max(1, round(spr.width * scale)), max(1, round(spr.height * scale))
        spr = spr.resize((nw, nh), Image.LANCZOS)
        # fill the eye where the pupil was with the eye's white (its median)
        ws = sorted((im.getpixel(p) for p in e['white']), key=lum); fill = ws[len(ws) // 2]
        for p in mask.crop(box).getbbox() and [(x, y) for x in range(box[0], box[2]) for y in range(box[1], box[3]) if mask.getpixel((x, y)) > 8 and (x, y) in body] or []:
            op[p] = fill
        # where it goes: away from the other eye, one a little up, the other a little down, as far as the white allows
        dx, dy = (cx - mid[0]), (cy - mid[1]) + tilt[i] * max(rx, ry)
        n = math.hypot(dx, dy) or 1; dx, dy = dx / n, dy / n
        reach = max(0.0, min(rx, ry) - pr * scale - 2) * push
        tx, ty = cx + dx * reach, cy + dy * reach
        # paste, kept inside the eye (the white and the old hole)
        lay = Image.new('RGBA', (W, H), (0, 0, 0, 0)); lay.paste(spr, (round(tx - nw / 2), round(ty - nh / 2)))
        clip = Image.new('L', (W, H), 0); cp = clip.load()
        for p in body: cp[p] = 255
        clip = clip.filter(ImageFilter.MinFilter(3))
        a = lay.getchannel('A'); lay.putalpha(Image.composite(a, Image.new('L', (W, H), 0), clip))
        out = Image.alpha_composite(out, lay); op = out.load()
    return out, 'ok'

if __name__ == '__main__':
    src, dst = sys.argv[1], sys.argv[2]
    sc = float(sys.argv[3]) if len(sys.argv) > 3 else 0.72
    pu = float(sys.argv[4]) if len(sys.argv) > 4 else 1.0
    im = Image.open(src); rgb = im.mode == 'RGB'
    res, why = derp(im, sc, pu)
    if rgb: res = res.convert('RGB')
    res.save(dst); print(src.split('/')[-1], why)
