"""Chroma-key the magenta background out of generated sprites, trim and downscale.
Usage: python3 scripts/process-sprites.py [name ...]  (reads public/sprites/raw/*.png, writes public/sprites/*.png)"""
import glob, os, sys
from PIL import Image, ImageFilter
import colorsys

SRC, DST = 'public/sprites/raw', 'public/sprites'
MAX = {'background': 1536, 'tank': 384, 'armoredcar': 384}
ONLY = set(sys.argv[1:])
for f in glob.glob(f'{SRC}/*.png'):
    name = os.path.splitext(os.path.basename(f))[0]
    if (ONLY and name not in ONLY) or '@' in name: continue
    if name.startswith('obj_'): MAX[name] = 384
    im = Image.open(f).convert('RGBA')
    if name == 'background':
        im = im.convert('RGB'); im.save(f'{DST}/{name}.jpg', quality=85); continue
    px = im.load(); w, h = im.size
    # the key's hue band: the generic magenta band, or for objective dressings (which carry deep reds) a band
    # around the background's own hue, sampled at the corners
    lo, hi, flo, fhi = 0.78, 0.99, 0.78, 0.99
    if name.startswith('obj_'):
        bh = sorted(colorsys.rgb_to_hsv(*[c / 255 for c in px[x, y][:3]])[0] for x, y in ((2, 2), (w - 3, 2), (2, h - 3), (w - 3, h - 3)))[1]
        lo, hi, flo, fhi = bh - 0.06, bh + 0.035, bh - 0.08, bh + 0.045
    for y in range(h):
        for x in range(w):
            r, g, b, a = px[x, y]
            hh, s, v = colorsys.rgb_to_hsv(r / 255, g / 255, b / 255)
            # magenta/pink hue band: ~0.80 - 0.98
            if lo < hh < hi and s > 0.35 and v > 0.45:
                px[x, y] = (0, 0, 0, 0)
            elif flo < hh < fhi and s > 0.2 and v > 0.4:
                # fringe: partially transparent and desaturate
                px[x, y] = (int((r + g + b) / 3), g, int((g + b) / 2), 110)
    # shrink alpha by 1px to kill pink halo
    alpha = im.getchannel('A').filter(ImageFilter.MinFilter(3))
    im.putalpha(alpha)
    im = im.crop(im.getbbox())
    im.thumbnail((MAX.get(name, 256), MAX.get(name, 256)), Image.LANCZOS)
    im.save(f'{DST}/{name}.png', optimize=True)
    print(name, im.size)
