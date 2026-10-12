"""Validate actual native frames, not a synthetic DOM render."""
from pathlib import Path
import sys
from PIL import Image

root = Path(sys.argv[1])
def frame(name):
    files = list(root.rglob(name))
    assert len(files) == 1, (name, files)
    with Image.open(files[0]) as image:
        return image.convert("RGBA")
before = frame("desktop-before-marquee.png")
marquee = frame("desktop-marquee.png")
assert before.size == marquee.size == (1280, 720)
selection = (193, 210, 238)
for point in ((220, 60), (230, 130)):
    source = before.getpixel(point)
    actual = marquee.getpixel(point)
    expected = tuple(round(0.45 * selected + 0.55 * background)
                     for selected, background in zip(selection, source[:3]))
    assert all(abs(a - b) <= 2 for a, b in zip(actual[:3], expected)), (point, actual, expected)
assert before.getpixel((8, 60)) == marquee.getpixel((8, 60)), "Marquee leaked beyond its logical rectangle"
assert marquee.getpixel((20, 20))[:3] == selection, "Selected icon highlight is not native"
assert frame("desktop-fractional.png").size == (1280, 720), "1.25 scale did not preserve physical buffer dimensions"
assert frame("desktop-second-fractional.png").size == (1280, 720), "1.5 scale did not preserve physical buffer dimensions"
reloaded = frame("desktop-reloaded.png")
changes = sum(reloaded.getpixel((x, y)) != before.getpixel((x, y))
              for y in range(124, 220) for x in range(20, 108))
assert changes > 100, "Reloaded icon artwork/label is missing at its persisted location"
print("PASS: native marquee 0.45 blend, rectangle boundary, selection highlight, two fractional buffers and persisted rearrangement")
