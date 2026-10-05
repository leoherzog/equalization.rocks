# /// script
# requires-python = ">=3.12"
# dependencies = ["pillow", "resvg-py"]
# ///
"""Renders the social card, app icons, and favicon.ico beside this script from the duotone glyph in favicon.svg.

Run `uv run assets/generate.py` after changing the glyph, the brand colors, or the card copy.
"""

import io
import re
import tempfile
import urllib.request
from pathlib import Path

import resvg_py
from PIL import Image

HERE = Path(__file__).parent
FONT_URL = "https://cdn.jsdelivr.net/fontsource/fonts/inter@latest/latin-{weight}-normal.ttf"

# Web Awesome "elegant" palette, matching the kit's orange brand and gray neutral.
ORANGE_50 = "#b65d22"
ORANGE_60 = "#d1824d"
ORANGE_70 = "#e1a173"
GRAY_05 = "#111217"
GRAY_10 = "#1c1d25"
GRAY_20 = "#30323f"
GRAY_50 = "#727486"
GRAY_60 = "#9294a2"
GRAY_70 = "#adaeb9"
GRAY_95 = "#f2f2f3"

EQ_BANDS = ["32", "64", "125", "250", "500", "1k", "2k", "8k", "16k"]
EQ_GAINS = [7, 5, 2, -1, -3, -1, 2, 5, 8]  # dB, within the app's ±12 range

_favicon = (HERE / "favicon.svg").read_text()
BG_PATH = re.search(r'class="bg" d="([^"]+)"', _favicon)[1]
FG_PATH = re.search(r'class="fg" d="([^"]+)"', _favicon)[1]


def glyph(x, y, size, color):
    """Draws the glyph as a `size` square at (x, y); its content box sits at (64, 96) in the 640 viewBox."""
    return (
        f'<g transform="translate({x} {y}) scale({size / 512}) translate(-64 -96)" fill="{color}">'
        f'<path d="{BG_PATH}" fill-opacity=".4"/><path d="{FG_PATH}"/></g>'
    )


def tile(radius, scale):
    """An orange 512-unit square with the white glyph centered at `scale` of its width."""
    size = 512 * scale
    offset = (512 - size) / 2
    return (
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">'
        f'<rect width="512" height="512" rx="{radius}" fill="{ORANGE_50}"/>'
        f'{glyph(offset, offset, size, "#fff")}</svg>'
    )


def equalizer(x, y, width, height):
    """A card of vertical EQ sliders echoing the app's nine-band equalizer."""
    pad, label_space = 36, 48
    top, bottom = y + pad + 14, y + height - pad - label_space
    zero = (top + bottom) / 2
    step = (width - 2 * pad) / len(EQ_BANDS)
    parts = [
        f'<rect x="{x}" y="{y}" width="{width}" height="{height}" rx="24" fill="{GRAY_10}" stroke="{GRAY_20}" stroke-width="2"/>',
        f'<line x1="{x + pad}" y1="{zero}" x2="{x + width - pad}" y2="{zero}" stroke="{GRAY_20}" stroke-width="2" stroke-dasharray="4 6"/>',
    ]
    for i, (band, gain) in enumerate(zip(EQ_BANDS, EQ_GAINS)):
        cx = x + pad + step * (i + 0.5)
        thumb = zero - gain / 12 * (zero - top)
        parts += [
            f'<rect x="{cx - 3}" y="{top}" width="6" height="{bottom - top}" rx="3" fill="{GRAY_20}"/>',
            f'<rect x="{cx - 3}" y="{min(zero, thumb)}" width="6" height="{abs(zero - thumb)}" fill="{ORANGE_50}"/>',
            f'<circle cx="{cx}" cy="{thumb}" r="13" fill="{ORANGE_70}" stroke="{GRAY_10}" stroke-width="3"/>',
            f'<text x="{cx}" y="{y + height - pad}" text-anchor="middle" font-size="15" fill="{GRAY_60}">{band}</text>',
        ]
    return "".join(parts)


def card():
    """The 1200x630 Open Graph image."""
    return f"""<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630" font-family="Inter">
  <defs>
    <radialGradient id="glow" gradientUnits="userSpaceOnUse" cx="930" cy="315" r="560">
      <stop offset="0" stop-color="{ORANGE_50}" stop-opacity=".25"/>
      <stop offset="1" stop-color="{ORANGE_50}" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <rect width="1200" height="630" fill="{GRAY_05}"/>
  <rect width="1200" height="630" fill="url(#glow)"/>
  {glyph(80, 80, 112, ORANGE_60)}
  <text font-weight="700" font-size="92" letter-spacing="-2" fill="{GRAY_95}">
    <tspan x="76" y="300">Equalization</tspan>
    <tspan x="76" y="396" fill="{ORANGE_70}">Rocks!</tspan>
  </text>
  <text font-size="32" fill="{GRAY_70}">
    <tspan x="80" y="470">Build a real-time audio effects chain</tspan>
    <tspan x="80" y="512">right in your browser.</tspan>
  </text>
  <text x="80" y="566" font-weight="700" font-size="26" fill="{GRAY_50}">equalization.rocks</text>
  {equalizer(690, 80, 430, 470)}
</svg>"""


def render(svg, width, fonts=()):
    png = resvg_py.svg_to_bytes(svg_string=svg, width=width, skip_system_fonts=True, font_files=list(fonts))
    return Image.open(io.BytesIO(png))


def save(image, name, alpha=True):
    """Writes an optimized PNG; full-bleed images drop alpha since iOS fills transparency with black."""
    (image if alpha else image.convert("RGB")).save(HERE / name, optimize=True)


with tempfile.TemporaryDirectory() as tmp:
    fonts = []
    for weight in (400, 700):
        path = Path(tmp) / f"inter-{weight}.ttf"
        with urllib.request.urlopen(FONT_URL.format(weight=weight)) as response:
            path.write_bytes(response.read())
        fonts.append(str(path))
    save(render(card(), 1200, fonts), "og-image.png", alpha=False)

save(render(tile(0, 0.6), 180), "apple-touch-icon.png", alpha=False)
save(render(tile(112, 0.62), 192), "icon-192.png")
save(render(tile(112, 0.62), 512), "icon-512.png")
# Maskable icons must keep the glyph inside the central circle of radius 40%.
save(render(tile(0, 0.55), 512), "icon-maskable-512.png", alpha=False)

favicons = [render(tile(96, 0.8), n) for n in (16, 32, 48)]
favicons[-1].save(HERE / "favicon.ico", sizes=[im.size for im in favicons], append_images=favicons[:-1])
