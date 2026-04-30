#!/usr/bin/env python3
"""Generate d2rive app icons (app + tray) using Pillow."""

from PIL import Image, ImageDraw
import math, os, subprocess, shutil

ROOT   = os.path.dirname(os.path.abspath(__file__))
ASSETS = os.path.join(ROOT, 'app', 'assets')
ICONSET = os.path.join(ASSETS, '_icon.iconset')

# ── Palette ───────────────────────────────────────────────────────────────────
BLUE_TOP    = (24, 105, 220)
BLUE_BOTTOM = (10, 62, 188)
WHITE       = (255, 255, 255, 255)
BLACK       = (0,   0,   0, 255)

# ── Background ────────────────────────────────────────────────────────────────

def gradient_bg(size):
    g = Image.new('RGB', (1, 2))
    g.putpixel((0, 0), BLUE_TOP)
    g.putpixel((0, 1), BLUE_BOTTOM)
    return g.resize((size, size), Image.BILINEAR)

def rounded_mask(size, frac=0.215):
    m = Image.new('L', (size, size), 0)
    d = ImageDraw.Draw(m)
    r = max(1, int(size * frac))
    d.rounded_rectangle([0, 0, size - 1, size - 1], radius=r, fill=255)
    return m

# ── Sync symbol ───────────────────────────────────────────────────────────────

def _arrowhead(draw, cx, cy, r, end_deg, head, color):
    a  = math.radians(end_deg)
    ex = cx + r * math.cos(a)
    ey = cy + r * math.sin(a)
    tx = -math.sin(a)   # clockwise tangent
    ty =  math.cos(a)
    nx = -ty            # outward normal
    ny =  tx

    tip   = (ex + tx * head * 0.55, ey + ty * head * 0.55)
    back  = (ex - tx * head * 0.45, ey - ty * head * 0.45)
    b1    = (back[0] + nx * head * 0.55, back[1] + ny * head * 0.55)
    b2    = (back[0] - nx * head * 0.55, back[1] - ny * head * 0.55)
    draw.polygon([tip, b1, b2], fill=color)

def sync_symbol(draw, cx, cy, r, thick, color):
    bb = [cx - r, cy - r, cx + r, cy + r]
    # Two arcs leaving ~25° gaps (at ~170° and ~350°, i.e. 9 o'clock and 3 o'clock areas)
    draw.arc(bb, start=205, end=335, fill=color, width=thick)   # top arc
    draw.arc(bb, start=25,  end=155, fill=color, width=thick)   # bottom arc
    head = thick * 1.55
    _arrowhead(draw, cx, cy, r, 335, head, color)
    _arrowhead(draw, cx, cy, r, 155, head, color)

# ── Icon builders ─────────────────────────────────────────────────────────────

def app_icon(size):
    s = size / 1024
    bg   = gradient_bg(size)
    mask = rounded_mask(size)
    img  = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    img.paste(bg, mask=mask)
    draw = ImageDraw.Draw(img)
    cx = cy = size // 2
    sync_symbol(draw, cx, cy, int(295 * s), int(70 * s), WHITE)
    return img

def tray_icon(size):
    # Render 4x, then downsample for clean anti-aliasing
    big  = size * 4
    img  = Image.new('RGBA', (big, big), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    cx = cy = big // 2
    sync_symbol(draw, cx, cy, int(big * 0.34), max(2, int(big * 0.115)), BLACK)
    return img.resize((size, size), Image.LANCZOS)

# ── Build ─────────────────────────────────────────────────────────────────────

def main():
    os.makedirs(ICONSET, exist_ok=True)
    os.makedirs(ASSETS,  exist_ok=True)

    # macOS .icns — iconset with all required sizes
    icns_files = [
        (16,   'icon_16x16.png'),
        (32,   'icon_16x16@2x.png'),
        (32,   'icon_32x32.png'),
        (64,   'icon_32x32@2x.png'),
        (128,  'icon_128x128.png'),
        (256,  'icon_128x128@2x.png'),
        (256,  'icon_256x256.png'),
        (512,  'icon_256x256@2x.png'),
        (512,  'icon_512x512.png'),
        (1024, 'icon_512x512@2x.png'),
    ]
    for sz, fname in icns_files:
        app_icon(sz).save(os.path.join(ICONSET, fname))
        print(f'  {fname}')

    icns_path = os.path.join(ASSETS, 'icon.icns')
    subprocess.run(['iconutil', '-c', 'icns', ICONSET, '-o', icns_path], check=True)
    shutil.rmtree(ICONSET)
    print(f'icon.icns → {icns_path}')

    # Linux PNG
    png_path = os.path.join(ASSETS, 'icon.png')
    app_icon(512).save(png_path)
    print(f'icon.png  → {png_path}')

    # Windows ICO (multi-size embedded)
    ico_sizes = [16, 32, 48, 64, 128, 256]
    frames = [app_icon(s).convert('RGBA') for s in ico_sizes]
    ico_path = os.path.join(ASSETS, 'icon.ico')
    frames[0].save(ico_path, format='ICO', append_images=frames[1:],
                   sizes=[(s, s) for s in ico_sizes])
    print(f'icon.ico  → {ico_path}')

    # Tray template images (macOS monochrome)
    tray_icon(16).save(os.path.join(ASSETS, 'trayTemplate.png'))
    tray_icon(32).save(os.path.join(ASSETS, 'trayTemplate@2x.png'))
    print('trayTemplate.png + @2x')

    print('\nDone.')

if __name__ == '__main__':
    main()
