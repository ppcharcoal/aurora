# Regenerate with: python scripts/android-icons.py src-tauri/icons/icon.png src-tauri/icons/android
# Builds Android launcher icons from the PC icon (icons/icon.png):
# full-bleed gradient background + white bars inside the adaptive safe zone.
import sys, os
from PIL import Image, ImageDraw, ImageFilter
src, out = sys.argv[1], sys.argv[2]
im = Image.open(src).convert("RGBA")
W = im.width
px = im.load()
# 1. gradient colors along the main diagonal, from the icon itself
bins = [[0, 0, 0, 0] for _ in range(64)]
for y in range(W):
    for x in range(W):
        r, g, b, a = px[x, y]
        if a < 250 or (r > 235 and g > 235 and b > 235):
            continue
        t = (x + y) / (2 * (W - 1))
        k = min(63, int(t * 64))
        bins[k][0] += r; bins[k][1] += g; bins[k][2] += b; bins[k][3] += 1
stops = [(i / 63, (s[0] / s[3], s[1] / s[3], s[2] / s[3])) for i, s in enumerate(bins) if s[3] > 20]
def color(t):
    if t <= stops[0][0]: return stops[0][1]
    if t >= stops[-1][0]: return stops[-1][1]
    for (t0, c0), (t1, c1) in zip(stops, stops[1:]):
        if t0 <= t <= t1:
            f = (t - t0) / (t1 - t0 or 1)
            return tuple(c0[i] + (c1[i] - c0[i]) * f for i in range(3))
# the icon's rounded square spans part of the diagonal; map the full canvas onto it
lo, hi = stops[0][0], stops[-1][0]
def background(size):
    bg = Image.new("RGB", (size, size))
    p = bg.load()
    for y in range(size):
        for x in range(size):
            # the launcher shows the middle 72 of 108 dp: spread the gradient over that
            c = 18 / 108
            u = ((x + y) / (2 * (size - 1)) - c) / (1 - 2 * c)
            t = lo + (hi - lo) * min(1.0, max(0.0, u))
            p[x, y] = tuple(int(round(v)) for v in color(t))
    return bg
# 2. the bars: white pixels away from the rim
inner = im.crop((int(W * .12), int(W * .12), int(W * .88), int(W * .88)))
mask = Image.eval(inner.convert("L"), lambda v: 255 if v > 200 else 0)
ip = inner.load()
bb = mask.getbbox()
bars_alpha = Image.new("L", inner.size, 0)
ba = bars_alpha.load()
for y in range(inner.height):
    for x in range(inner.width):
        r, g, b, a = ip[x, y]
        # whiteness: how far the pixel is from the gradient towards white
        m = min(r, g, b)
        ba[x, y] = max(0, min(255, int((m - 190) / (240 - 190) * 255)))
bars_alpha = bars_alpha.crop(bb)
def bars(size, frac):
    # bars fit in `frac` of the canvas (adaptive safe zone is 66%)
    bw, bh = bars_alpha.size
    s = frac * size / max(bw, bh)
    a = bars_alpha.resize((max(1, int(bw * s)), max(1, int(bh * s))), Image.LANCZOS)
    layer = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    white = Image.new("RGBA", a.size, (255, 255, 255, 255))
    layer.paste(white, ((size - a.width) // 2, (size - a.height) // 2 + int(size * 0.0)), a)
    return layer
dens = {"mdpi": 1, "hdpi": 1.5, "xhdpi": 2, "xxhdpi": 3, "xxxhdpi": 4}
for d, f in dens.items():
    folder = os.path.join(out, f"mipmap-{d}")
    os.makedirs(folder, exist_ok=True)
    A = int(108 * f)   # adaptive layer size
    L = int(48 * f)    # legacy icon size
    background(A).save(os.path.join(folder, "ic_launcher_background.png"))
    bars(A, 0.40).save(os.path.join(folder, "ic_launcher_foreground.png"))
    bars(A, 0.40).save(os.path.join(folder, "ic_launcher_monochrome.png"))
    # legacy (Android 7): the PC icon itself, and a round version
    big = 4 * L
    leg = Image.new("RGBA", (big, big), (0, 0, 0, 0))
    sq = Image.new("L", (big, big), 0)
    ImageDraw.Draw(sq).rounded_rectangle((big * .04, big * .04, big * .96, big * .96), radius=big * .2, fill=255)
    full = background(big).convert("RGBA"); full.alpha_composite(bars(big, 0.5))
    leg.paste(full, (0, 0), sq)
    leg.resize((L, L), Image.LANCZOS).save(os.path.join(folder, "ic_launcher.png"))
    rnd = Image.new("L", (big, big), 0)
    ImageDraw.Draw(rnd).ellipse((big * .02, big * .02, big * .98, big * .98), fill=255)
    r = Image.new("RGBA", (big, big), (0, 0, 0, 0)); r.paste(full, (0, 0), rnd)
    r.resize((L, L), Image.LANCZOS).save(os.path.join(folder, "ic_launcher_round.png"))
os.makedirs(os.path.join(out, "mipmap-anydpi-v26"), exist_ok=True)
xml = """<?xml version="1.0" encoding="utf-8"?>
<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">
  <background android:drawable="@mipmap/ic_launcher_background"/>
  <foreground android:drawable="@mipmap/ic_launcher_foreground"/>
  <monochrome android:drawable="@mipmap/ic_launcher_monochrome"/>
</adaptive-icon>
"""
for n in ("ic_launcher.xml", "ic_launcher_round.xml"):
    open(os.path.join(out, "mipmap-anydpi-v26", n), "w").write(xml)
print("stops", len(stops), "bars", bars_alpha.size)
