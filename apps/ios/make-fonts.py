"""Makes the app's fonts: python3 make-fonts.py (needs fontTools).

Google Sans Flex and Google Sans Code, as on the web, cut from Google Fonts' variable files at a pinned
commit into static faces, since iOS picks a weight or italic from a family's faces: Flex at its default
optical size (18), width (100) and roundness (0), and slanted 10 degrees for italic.
"""

import math
import os
import shutil
import sys
import tempfile
import urllib.request

from fontTools.ttLib import TTFont
from fontTools.varLib import instancer

FONTS = "https://raw.githubusercontent.com/google/fonts"
FLEX = (
    "bd8f81ddb5c74d5c8897b36ad88b440266245103",
    "ofl/googlesansflex",
    "GoogleSansFlex%5BROND,opsz,slnt,wdth,wght%5D.ttf",
)
CODE = ("9e108e1439daa51f8dddeb8834e9617816b50c01", "ofl/googlesanscode", "GoogleSansCode%5Bwght%5D.ttf")
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "Hatbot", "Resources", "Fonts")

# Style, weight, italic.
FLEX_FACES = [
    ("Regular", 400, False),
    ("Italic", 400, True),
    ("Medium", 500, False),
    ("SemiBold", 600, False),
    ("Bold", 700, False),
    ("BoldItalic", 700, True),
]
CODE_FACES = [("Regular", 400, False), ("Bold", 700, False)]
WORDS = {"BoldItalic": "Bold Italic"}
SLANT = -10


def fetch(commit, folder, name, into):
    path = os.path.join(into, name.replace("%5B", "[").replace("%5D", "]"))
    with urllib.request.urlopen(f"{FONTS}/{commit}/{folder}/{name}", timeout=120) as r, open(path, "wb") as f:
        shutil.copyfileobj(r, f)
    return path


def rename(font, family, style, weight, italic):
    """Names the face so iOS groups the six into one family: Regular, Italic, Bold and Bold Italic under
    the family's own name, Medium and SemiBold under typographic names (16, 17)."""
    words = WORDS.get(style, style)
    ribbi = style in ("Regular", "Italic", "Bold", "BoldItalic")
    ps = f"{family.replace(' ', '')}-{style}"
    names = font["name"]
    version = names.getDebugName(5) or "Version 1.000"
    for nid in (1, 2, 3, 4, 6, 16, 17, 21, 22, 25):
        names.removeNames(nameID=nid)
    for nid, value in (
        (1, family if ribbi else f"{family} {words}"),
        (2, words if ribbi else "Regular"),
        (3, f"{version};{ps}"),
        (4, f"{family} {words}"),
        (6, ps),
    ):
        names.setName(value, nid, 3, 1, 0x409)
    if not ribbi:
        names.setName(family, 16, 3, 1, 0x409)
        names.setName(words, 17, 3, 1, 0x409)

    os2 = font["OS/2"]
    os2.usWeightClass = weight
    os2.fsSelection &= ~((1 << 0) | (1 << 5) | (1 << 6))
    if italic:
        os2.fsSelection |= 1 << 0
    if ribbi and weight == 700:
        os2.fsSelection |= 1 << 5
    if style == "Regular" or not ribbi:
        os2.fsSelection |= 1 << 6
    font["head"].macStyle = (1 if ribbi and weight == 700 else 0) | (2 if italic else 0)
    font["post"].italicAngle = SLANT if italic else 0
    hhea = font["hhea"]
    hhea.caretSlopeRise, hhea.caretSlopeRun = (1000, round(1000 * math.tan(math.radians(-SLANT)))) if italic else (1, 0)
    hhea.caretOffset = 0
    return ps


def cut(source, family, faces, axes):
    for style, weight, italic in faces:
        font = TTFont(source)
        location = dict(axes, wght=weight)
        if "slnt" in axes:
            location["slnt"] = SLANT if italic else 0
        instancer.instantiateVariableFont(font, location, inplace=True)
        if "STAT" in font:
            del font["STAT"]
        ps = rename(font, family, style, weight, italic)
        path = os.path.join(OUT, f"{ps}.ttf")
        font.save(path)
        print(f"{path}: {os.path.getsize(path) // 1024} kB")


def main():
    os.makedirs(OUT, exist_ok=True)
    with tempfile.TemporaryDirectory() as tmp:
        flex = fetch(*FLEX, tmp)
        code = fetch(*CODE, tmp)
        shutil.copy(fetch(FLEX[0], FLEX[1], "OFL.txt", tmp), os.path.join(OUT, "GoogleSansFlex-OFL.txt"))
        shutil.copy(fetch(CODE[0], CODE[1], "OFL.txt", tmp), os.path.join(OUT, "GoogleSansCode-OFL.txt"))
        cut(flex, "Google Sans Flex", FLEX_FACES, {"opsz": 18, "wdth": 100, "ROND": 0, "slnt": 0})
        cut(code, "Google Sans Code", CODE_FACES, {})


if __name__ == "__main__":
    sys.exit(main())
