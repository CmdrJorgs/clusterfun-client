#!/usr/bin/env python3
"""
Generate PLACEHOLDER plate art for Sushi Sync.

These are stand-ins so the layering system, preloader and all three render surfaces work
before any real art exists.  Replace them one file at a time with hand-drawn PNGs - the
filenames and geometry are the contract, nothing in the code cares who drew them.

Geometry is the single source of truth in src/games/SushiSync/models/plateArt.ts and is
documented for artists in src/games/SushiSync/assets/ASSETS.md.  Keep all three in step.

Usage:  python3 scripts/generate-sushi-placeholders.py
Requires: pillow
"""

import os
from PIL import Image, ImageDraw

# --- Authoring canvas (mirrors plateArt.ts) ------------------------------------------------
W, H = 512, 384
SEAT_Y = 292
BAND_X0, BAND_X1 = 80, 432
BAND_MAX_HEIGHT = 100

OUT_DIR = os.path.join(
    os.path.dirname(os.path.abspath(__file__)),
    "..", "src", "games", "SushiSync", "assets", "images",
)
ING_DIR = os.path.join(OUT_DIR, "ingredients")

# --- Palette -------------------------------------------------------------------------------
# id: (fill, shade, body_height, style)
# body_height is what gets DRAWN; the rise (how far it lifts the next layer) lives in
# plateArt.ts and is deliberately smaller, so layers overlap the way a real stack does.
INGREDIENTS = {
    # Base - flat sheets
    "nori":      ((28, 46, 38),    (18, 32, 26),   26, "sheet"),
    "soypaper":  ((232, 214, 168), (206, 186, 138), 26, "sheet"),
    # Binder - the mound that gives a roll its bulk
    "whiterice": ((248, 246, 240), (222, 218, 208), 78, "mound"),
    "brownrice": ((206, 178, 134), (180, 152, 110), 78, "mound"),
    # Filling - slices and batons
    "salmon":    ((240, 134, 92),  (214, 104, 66),  46, "slice"),
    "tuna":      ((208, 66, 78),   (176, 46, 60),   46, "slice"),
    "eel":       ((122, 78, 46),   (92, 56, 32),    46, "slice"),
    "cucumber":  ((150, 198, 108), (112, 166, 78),  42, "batons"),
    "avocado":   ((168, 202, 106), (132, 172, 78),  42, "fan"),
    # Topping - scatters and drizzles
    "tobiko":    ((242, 138, 44),  (210, 106, 24),  22, "scatter"),
    "spicymayo": ((246, 152, 118), (222, 118, 84),  18, "drizzle"),
    "eelsauce":  ((78, 52, 34),    (54, 34, 20),    18, "drizzle"),
    "sesame":    ((236, 228, 206), (198, 186, 158), 14, "scatter"),
}


def new_canvas():
    return Image.new("RGBA", (W, H), (0, 0, 0, 0))


def draw_sheet(d, fill, shade, h):
    """A flat sheet (nori, soy paper) - slight lift at the ends so it reads as pliable."""
    top = SEAT_Y - h
    d.polygon(
        [(BAND_X0, top + 6), (BAND_X0 + 24, top), (BAND_X1 - 24, top),
         (BAND_X1, top + 6), (BAND_X1, SEAT_Y), (BAND_X0, SEAT_Y)],
        fill=fill,
    )
    d.rectangle([BAND_X0, SEAT_Y - 6, BAND_X1, SEAT_Y], fill=shade)


def draw_mound(d, fill, shade, h):
    """A rounded mound of rice."""
    top = SEAT_Y - h
    d.rounded_rectangle([BAND_X0 + 16, top, BAND_X1 - 16, SEAT_Y], radius=h // 2, fill=fill)
    d.rounded_rectangle(
        [BAND_X0 + 16, SEAT_Y - h // 3, BAND_X1 - 16, SEAT_Y], radius=h // 3, fill=shade
    )
    # A few grain speckles so it is not a flat blob at small sizes.
    for gx in range(BAND_X0 + 46, BAND_X1 - 40, 34):
        d.ellipse([gx, top + 14, gx + 13, top + 22], fill=shade)


def draw_slice(d, fill, shade, h):
    """A draped slice of fish."""
    top = SEAT_Y - h
    d.rounded_rectangle([BAND_X0 + 8, top, BAND_X1 - 8, SEAT_Y], radius=12, fill=fill)
    for gx in range(BAND_X0 + 30, BAND_X1 - 30, 46):
        d.rectangle([gx, top + 8, gx + 20, SEAT_Y - 8], fill=shade)


def draw_batons(d, fill, shade, h):
    """Cucumber batons, end-on."""
    top = SEAT_Y - h
    span = BAND_X1 - BAND_X0 - 24
    n = 5
    step = span // n
    for i in range(n):
        x0 = BAND_X0 + 12 + i * step
        d.rounded_rectangle([x0, top, x0 + step - 10, SEAT_Y], radius=8, fill=fill)
        d.rounded_rectangle([x0 + 6, top + 8, x0 + step - 16, SEAT_Y - 8], radius=6, fill=shade)


def draw_fan(d, fill, shade, h):
    """Fanned avocado slices."""
    top = SEAT_Y - h
    span = BAND_X1 - BAND_X0 - 20
    n = 6
    step = span // n
    for i in range(n):
        x0 = BAND_X0 + 10 + i * step
        d.rounded_rectangle([x0, top + (i % 2) * 5, x0 + step + 6, SEAT_Y], radius=10, fill=fill)
        d.rounded_rectangle(
            [x0 + 4, top + 4 + (i % 2) * 5, x0 + step, SEAT_Y - 6], radius=8, fill=shade
        )


def draw_scatter(d, fill, shade, h):
    """Roe or seeds sprinkled across the top."""
    top = SEAT_Y - h
    r = max(4, h // 3)
    y = top + r
    x = BAND_X0 + 14
    row = 0
    while y < SEAT_Y + 4:
        xx = x + (row % 2) * r
        while xx < BAND_X1 - 12:
            d.ellipse([xx, y - r, xx + r * 2, y + r], fill=fill if row % 2 == 0 else shade)
            xx += int(r * 2.6)
        y += int(r * 1.7)
        row += 1


def draw_drizzle(d, fill, shade, h):
    """A zig-zag sauce drizzle that overhangs slightly into the drip zone."""
    top = SEAT_Y - h
    pts = []
    span = BAND_X1 - BAND_X0 - 20
    n = 9
    for i in range(n + 1):
        x = BAND_X0 + 10 + int(span * i / n)
        pts.append((x, top + (h - 6 if i % 2 else 0)))
    d.line(pts, fill=fill, width=max(6, h // 2), joint="curve")
    # Two drips past the seat line, which is what the 12px drip zone is for.
    for dx in (int(span * 0.3), int(span * 0.72)):
        x = BAND_X0 + 10 + dx
        d.ellipse([x - 5, SEAT_Y - 4, x + 5, SEAT_Y + 8], fill=shade)


STYLES = {
    "sheet": draw_sheet, "mound": draw_mound, "slice": draw_slice,
    "batons": draw_batons, "fan": draw_fan, "scatter": draw_scatter,
    "drizzle": draw_drizzle,
}


def build_ingredient(name, spec):
    fill, shade, h, style = spec
    h = min(h, BAND_MAX_HEIGHT)
    img = new_canvas()
    STYLES[style](ImageDraw.Draw(img), fill, shade, h)
    path = os.path.join(ING_DIR, f"{name}.png")
    img.save(path, optimize=True)
    return path


def build_dish():
    """The empty plate.  Its own file so it can be tinted/swapped without touching food art."""
    img = new_canvas()
    d = ImageDraw.Draw(img)
    rim, face, edge = (238, 240, 245), (214, 218, 228), (176, 182, 196)
    # Side wall, then the elliptical top face sitting on the seat line.
    d.ellipse([20, SEAT_Y - 26 + 14, 492, SEAT_Y + 26 + 14], fill=edge)
    d.ellipse([20, SEAT_Y - 26, 492, SEAT_Y + 26], fill=rim)
    d.ellipse([54, SEAT_Y - 18, 458, SEAT_Y + 18], fill=face)
    img.save(os.path.join(OUT_DIR, "dish.png"), optimize=True)


def main():
    os.makedirs(ING_DIR, exist_ok=True)
    for name, spec in INGREDIENTS.items():
        build_ingredient(name, spec)
    build_dish()
    print(f"Wrote {len(INGREDIENTS)} ingredient placeholders + dish.png to {ING_DIR}")


if __name__ == "__main__":
    main()
