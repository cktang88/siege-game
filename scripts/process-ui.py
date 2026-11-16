"""Process generated UI art (public/ui/raw -> public/ui).
Icons/insignia were drawn on flat #00FF00: key it out with a flood fill seeded from the border
(so green inside the design survives), despill the fringe, trim and downscale.
Same approach as cktang88/card-game scripts/process-ui.py."""
import glob, os
from collections import deque
from PIL import Image, ImageFilter

SRC, DST = 'public/ui/raw', 'public/ui'
os.makedirs(DST, exist_ok=True)

def key_out(im, tol=42):
    """flood-fill from the border, keying anything close to the sampled backdrop colour
    (models often paint a flat but not pure key colour)"""
    im = im.convert('RGBA')
    w, h = im.size
    px = im.load()
    border = [px[x, 0] for x in range(0, w, 7)] + [px[x, h - 1] for x in range(0, w, 7)] + \
             [px[0, y] for y in range(0, h, 7)] + [px[w - 1, y] for y in range(0, h, 7)]
    bg = [sorted(c[i] for c in border)[len(border) // 2] for i in range(3)]
    def is_key(p):
        return abs(p[0] - bg[0]) + abs(p[1] - bg[1]) + abs(p[2] - bg[2]) < tol * 1.6
    seen = bytearray(w * h)
    q = deque()
    for x in range(w):
        q.append((x, 0)); q.append((x, h - 1))
    for y in range(h):
        q.append((0, y)); q.append((w - 1, y))
    while q:
        x, y = q.popleft()
        if x < 0 or y < 0 or x >= w or y >= h or seen[y * w + x]:
            continue
        seen[y * w + x] = 1
        if not is_key(px[x, y]):
            continue
        px[x, y] = (0, 0, 0, 0)
        q.extend(((x + 1, y), (x - 1, y), (x, y + 1), (x, y - 1)))
    # despill: pull residual green toward the average of r and b on the edge
    for y in range(h):
        for x in range(w):
            r, g, b, a = px[x, y]
            if a and bg[1] > max(bg[0], bg[2]) and g > max(r, b) + 6 and abs(r - bg[0]) + abs(g - bg[1]) + abs(b - bg[2]) < tol * 2.5:
                px[x, y] = (r, int((r + b) / 2 + (g - (r + b) / 2) * 0.3), b, a)
    alpha = im.getchannel('A').filter(ImageFilter.MinFilter(3))
    im.putalpha(alpha)
    return im.crop(im.getbbox())

for f in sorted(glob.glob(f'{SRC}/*.png')):
    name = os.path.splitext(os.path.basename(f))[0]
    im = Image.open(f)
    if name == 'map':
        im.convert('RGB').resize((1600, int(1600 * im.height / im.width)), Image.LANCZOS).save(f'{DST}/{name}.jpg', quality=82)
    elif name in ('paper', 'metal'):
        im.convert('RGB').resize((512, 512), Image.LANCZOS).save(f'{DST}/{name}.jpg', quality=82)
    else:
        im = key_out(im)
        im.thumbnail((160, 160), Image.LANCZOS)
        im.save(f'{DST}/{name}.png', optimize=True)
    print(name, im.size)
