import sys
from PIL import Image


def check(path):
    image = Image.open(path).convert("RGB")
    assert image.width >= 340 and image.height >= 280, image.size

    def pixel(x, y, expected, tolerance=2):
        actual = image.getpixel((x, y))
        assert all(abs(a - b) <= tolerance for a, b in zip(actual, expected)), (
            path, (x, y), actual, expected
        )

    pixel(40, 40, (255, 0, 0))
    pixel(150, 40, (0, 0, 255))
    pixel(260, 40, (128, 0, 127))
    pixel(300, 40, (0, 0, 255))
    pixel(280, 160, (18, 52, 86))
    pixel(241, 131, (244, 246, 250))
    top = image.getpixel((40, 132))
    bottom = image.getpixel((40, 187))
    assert top[1] > 230 and top[2] < 25, top
    assert bottom[2] > 230 and bottom[1] < 25, bottom
    ink = sum(image.getpixel((x, y)) != (244, 246, 250)
              for y in range(230, 270) for x in range(20, 300))
    assert ink > 100, (path, "missing text", ink)
    print(f"PASS: {path}: fills, gradients, opacity, clipping and text")


for filename in sys.argv[1:]:
    check(filename)
