#!/usr/bin/env python3
"""Modern, minimal PollyOS showcase icon set.

Original soft-gradient rounded tiles with bold filled glyphs. No platform
logos, system icons or proprietary fonts. Draws 1024px masters, exports
256/128/64 app icons and 256/96 feature glyphs plus a contact sheet.

Run from the repository root:
    python3 desktop/tools/generate-showcase-icons.py
"""
from __future__ import annotations

import json
import math
from pathlib import Path

from PIL import Image, ImageChops, ImageDraw, ImageFilter, ImageFont, ImageOps

S = 1024
TILE = (104, 104, 920, 920)
RADIUS = 196
OUT = Path("desktop/resources/application-icons/showcase")
FONT_BOLD = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"
FONT_CJK = "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc"
WHITE = (255, 255, 255, 248)


def rgba(value: str, alpha: int = 255) -> tuple[int, int, int, int]:
    value = value.lstrip("#")
    return (int(value[0:2], 16), int(value[2:4], 16), int(value[4:6], 16), alpha)


def canvas() -> Image.Image:
    return Image.new("RGBA", (S, S), (0, 0, 0, 0))


def vgrad(size: tuple[int, int], top: str, bottom: str) -> Image.Image:
    gradient = Image.linear_gradient("L").resize(size, Image.Resampling.BICUBIC)
    return ImageOps.colorize(gradient, rgba(top), rgba(bottom)).convert("RGBA")


def rounded_mask(size: tuple[int, int], radius: float) -> Image.Image:
    mask = Image.new("L", size, 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, size[0] - 1, size[1] - 1),
                                           radius=radius, fill=255)
    return mask


def paste_gradient(base: Image.Image, box, radius, top, bottom, border=None, width=3):
    w, h = box[2] - box[0], box[3] - box[1]
    layer = vgrad((w, h), top, bottom)
    base.paste(layer, (box[0], box[1]), rounded_mask((w, h), radius))
    if border:
        ImageDraw.Draw(base).rounded_rectangle(box, radius=radius,
                                               outline=rgba(border), width=width)


def soft_shadow(base: Image.Image, mask: Image.Image, offset=(0, 14), blur=26, opacity=70):
    layer = Image.new("RGBA", base.size, (0, 0, 0, 0))
    layer.paste(Image.new("RGBA", base.size, (0, 0, 0, opacity)), (0, 0), mask)
    layer = layer.filter(ImageFilter.GaussianBlur(blur))
    base.alpha_composite(ImageChops.offset(layer, *offset))


def tile(top: str, bottom: str, border: str | None = None) -> tuple[Image.Image, ImageDraw.ImageDraw]:
    base = canvas()
    mask = Image.new("L", base.size, 0)
    ImageDraw.Draw(mask).rounded_rectangle(TILE, RADIUS, fill=255)
    soft_shadow(base, mask, (0, 16), 28, 72)
    paste_gradient(base, TILE, RADIUS, top, bottom, border, 3)
    # A single very soft top light, not a glossy bevel.
    light = Image.new("RGBA", (TILE[2] - TILE[0], 300), (255, 255, 255, 0))
    lm = Image.new("L", light.size, 0)
    ImageDraw.Draw(lm).rounded_rectangle((0, 0, light.width - 1, light.height - 1),
                                         RADIUS, fill=255)
    light.paste(Image.new("RGBA", light.size, (255, 255, 255, 20)), (0, 0), lm)
    base.alpha_composite(light.filter(ImageFilter.GaussianBlur(18)), (TILE[0], TILE[1]))
    return base, ImageDraw.Draw(base)


def save(icon: Image.Image, slug: str):
    icon.save(OUT / f"{slug}-1024.png", optimize=True)
    for size in (256, 128, 64):
        icon.resize((size, size), Image.Resampling.LANCZOS).save(
            OUT / f"{slug}-{size}.png", optimize=True)


def draw_files() -> Image.Image:
    base, d = tile("#FFD66B", "#F0A21C", "#D88B0E")
    d.rounded_rectangle((292, 350, 478, 448), 26, fill=WHITE)
    d.rounded_rectangle((292, 402, 732, 710), 44, fill=WHITE)
    d.rounded_rectangle((318, 472, 706, 686), 28, fill=(255, 255, 255, 232))
    d.rounded_rectangle((350, 520, 674, 538), 9, fill=rgba("#F3B23D"))
    return base


def draw_settings() -> Image.Image:
    base, d = tile("#A9B8CA", "#66798F", "#52657A")
    tooth = Image.new("RGBA", (120, 240), (0, 0, 0, 0))
    ImageDraw.Draw(tooth).rounded_rectangle((0, 0, 119, 239), 32, fill=WHITE)
    tooth_layer = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    tooth_layer.alpha_composite(tooth, (452, 90))
    for angle in range(0, 360, 45):
        base.alpha_composite(tooth_layer.rotate(angle, resample=Image.Resampling.BICUBIC,
                                                center=(512, 512)))
    d.ellipse((244, 244, 780, 780), fill=WHITE)
    d.ellipse((364, 364, 660, 660), fill=rgba("#6E8298"))
    return base


def draw_terminal() -> Image.Image:
    base, d = tile("#38383D", "#151517", "#0C0C0E")
    d.line([(330, 386), (470, 500), (330, 614)], fill=WHITE, width=46, joint="curve")
    d.rounded_rectangle((516, 592, 704, 632), 20, fill=(126, 226, 146, 255))
    return base


def draw_text_editor() -> Image.Image:
    base, d = tile("#6C9BF2", "#2F5FD0", "#244BAA")
    d.rounded_rectangle((318, 260, 706, 764), 34, fill=WHITE)
    d.polygon([(616, 260), (706, 350), (616, 350)], fill=(220, 230, 250, 255))
    for y in (402, 468, 534, 600):
        d.rounded_rectangle((370, y, 654, y + 18), 9, fill=rgba("#4A76D1"))
    d.rounded_rectangle((370, 666, 550, 684), 9, fill=rgba("#9FB6E6"))
    return base


def draw_photos() -> Image.Image:
    base, d = tile("#FFA36B", "#E44C1B", "#C73C10")
    d.rounded_rectangle((286, 300, 738, 724), 44, fill=WHITE)
    d.rounded_rectangle((334, 348, 690, 676), 26, fill=rgba("#F0642E"))
    d.ellipse((566, 390, 634, 458), fill=WHITE)
    d.polygon([(334, 640), (452, 500), (570, 640)], fill=WHITE)
    d.polygon([(486, 640), (604, 530), (722, 640)], fill=(255, 255, 255, 210))
    return base


def draw_music() -> Image.Image:
    base, d = tile("#FF7D9C", "#C2185B", "#9E1249")
    d.arc((314, 306, 710, 702), 180, 360, fill=WHITE, width=58)
    d.rounded_rectangle((282, 520, 398, 746), 48, fill=WHITE)
    d.rounded_rectangle((626, 520, 742, 746), 48, fill=WHITE)
    d.rounded_rectangle((306, 552, 374, 714), 30, fill=rgba("#C2185B"))
    d.rounded_rectangle((650, 552, 718, 714), 30, fill=rgba("#C2185B"))
    return base


def draw_calculator() -> Image.Image:
    base, d = tile("#4A4A50", "#1E1E22", "#121215")
    d.rounded_rectangle((292, 242, 732, 782), 52, fill=WHITE)
    d.rounded_rectangle((338, 296, 686, 428), 24, fill=rgba("#222B36"))
    d.rounded_rectangle((366, 330, 658, 394), 14, fill=rgba("#93E3B0"))
    for row in range(3):
        for col in range(3):
            x, y = 344 + col * 106, 478 + row * 90
            d.rounded_rectangle((x, y, x + 72, y + 64), 18, fill=rgba("#D7DEE8"))
    d.rounded_rectangle((662, 478, 734, 722), 18, fill=rgba("#F2A33A"))
    d.rounded_rectangle((344, 748, 626, 780), 14, fill=rgba("#D7DEE8"))
    return base


def draw_calendar() -> Image.Image:
    base, d = tile("#FF6266", "#C62828", "#A31D1D")
    d.rounded_rectangle((296, 268, 728, 768), 34, fill=WHITE)
    d.rounded_rectangle((296, 268, 728, 390), 34, fill=(255, 255, 255, 235))
    d.rectangle((296, 360, 728, 390), fill=(255, 255, 255, 235))
    for x in (372, 466, 560, 654):
        d.rounded_rectangle((x, 232, x + 34, 330), 17, fill=WHITE)
    d.text((350, 414), "OCT", font=ImageFont.truetype(FONT_BOLD, 58), fill=rgba("#C62828"))
    d.text((420, 480), "18", font=ImageFont.truetype(FONT_BOLD, 220), fill=rgba("#C62828"))
    d.text((390, 700), "FRIDAY", font=ImageFont.truetype(FONT_BOLD, 46), fill=rgba("#9A1C1C"))
    return base


def draw_monitor() -> Image.Image:
    base, d = tile("#37C9B8", "#087F8C", "#05636E")
    d.rounded_rectangle((276, 280, 748, 654), 40, fill=WHITE)
    d.rounded_rectangle((322, 326, 702, 608), 22, fill=rgba("#0A8794"))
    points = [(350, 550), (430, 480), (500, 512), (580, 410), (668, 446)]
    d.line(points, fill=WHITE, width=16, joint="curve")
    d.rounded_rectangle((452, 654, 572, 722), 12, fill=WHITE)
    d.rounded_rectangle((360, 722, 664, 764), 20, fill=WHITE)
    return base


def draw_browser() -> Image.Image:
    base, d = tile("#67B0FF", "#1E5BB8", "#174896")
    d.ellipse((252, 252, 772, 772), outline=WHITE, width=42)
    d.arc((300, 300, 724, 724), 200, 340, fill=WHITE, width=16)
    d.arc((300, 300, 724, 724), 20, 160, fill=(255, 255, 255, 150), width=10)
    d.polygon([(512, 330), (566, 500), (512, 470), (458, 500)], fill=WHITE)
    d.polygon([(512, 694), (458, 524), (512, 554), (566, 524)], fill=(255, 255, 255, 170))
    d.ellipse((488, 488, 536, 536), fill=rgba("#1E5BB8"))
    return base


def badge(top: str, bottom: str, border: str) -> tuple[Image.Image, ImageDraw.ImageDraw]:
    base = canvas()
    box = (20, 20, S - 20, S - 20)
    mask = Image.new("L", base.size, 0)
    ImageDraw.Draw(mask).rounded_rectangle(box, 210, fill=255)
    soft_shadow(base, mask, (0, 12), 22, 60)
    paste_gradient(base, box, 210, top, bottom, border, 3)
    return base, ImageDraw.Draw(base)


def draw_wifi() -> Image.Image:
    base, d = badge("#67B5F5", "#2373C8", "#1B5DA6")
    for radius, width in ((190, 28), (128, 28), (66, 28)):
        d.arc((512 - radius, 360 - radius, 512 + radius, 360 + radius), 210, 330,
              fill=WHITE, width=width)
    d.ellipse((482, 552, 542, 612), fill=WHITE)
    return base


def draw_bluetooth() -> Image.Image:
    base, d = badge("#6BA9F3", "#2C5FBF", "#214C99")
    d.line([(424, 368), (618, 544), (512, 642), (512, 328), (618, 426), (424, 602)],
           fill=WHITE, width=34, joint="curve")
    return base


def draw_volume() -> Image.Image:
    base, d = badge("#7CD3AF", "#238E6C", "#186E52")
    d.polygon([(346, 430), (436, 430), (558, 338), (558, 686), (436, 594), (346, 594)], fill=WHITE)
    for radius in (116, 186, 256):
        d.arc((558 - radius, 512 - radius, 558 + radius, 512 + radius), 300, 60,
              fill=WHITE, width=24)
    return base


def draw_brightness() -> Image.Image:
    base, d = badge("#FFD36E", "#E28A1E", "#B96A10")
    d.ellipse((404, 404, 620, 620), fill=WHITE)
    for angle in range(0, 360, 45):
        rad = math.radians(angle)
        d.line((512 + math.cos(rad) * 270, 512 + math.sin(rad) * 270,
                512 + math.cos(rad) * 350, 512 + math.sin(rad) * 350), fill=WHITE, width=28)
    return base


def draw_battery() -> Image.Image:
    base, d = badge("#8DDC90", "#2F8E49", "#236F38")
    d.rounded_rectangle((296, 398, 700, 626), 36, outline=WHITE, width=28)
    d.rounded_rectangle((700, 470, 742, 554), 14, fill=WHITE)
    d.rounded_rectangle((332, 434, 610, 590), 20, fill=WHITE)
    return base


def draw_airplane() -> Image.Image:
    base, d = badge("#82BBF0", "#2A66B0", "#1D4F8C")
    d.polygon([(512, 222), (570, 468), (806, 558), (806, 620), (570, 568),
               (570, 700), (650, 760), (650, 800), (512, 750), (374, 800),
               (374, 760), (454, 700), (454, 568), (218, 620), (218, 558),
               (454, 468)], fill=WHITE)
    return base


def draw_night() -> Image.Image:
    base, d = badge("#7A8DF0", "#313A9E", "#252D7D")
    mask = Image.new("L", (S, S), 0)
    md = ImageDraw.Draw(mask)
    md.ellipse((330, 280, 700, 650), fill=255)
    md.ellipse((430, 200, 800, 570), fill=0)
    layer = Image.new("RGBA", (S, S), WHITE)
    base.alpha_composite(Image.composite(layer, Image.new("RGBA", (S, S), (0, 0, 0, 0)), mask))
    d = ImageDraw.Draw(base)
    for x, y, r in ((620, 330, 12), (690, 430, 9), (600, 500, 7)):
        d.ellipse((x - r, y - r, x + r, y + r), fill=(255, 255, 255, 210))
    return base


def draw_accessibility() -> Image.Image:
    base, d = badge("#7EBDF5", "#2F65BC", "#234E95")
    d.ellipse((472, 270, 552, 350), fill=WHITE)
    d.rounded_rectangle((496, 370, 528, 560), 16, fill=WHITE)
    d.line([(360, 430), (664, 430)], fill=WHITE, width=30)
    d.line([(512, 540), (400, 730)], fill=WHITE, width=30)
    d.line([(512, 540), (624, 730)], fill=WHITE, width=30)
    return base


APPS = [
    ("files", "Files", "文件", "Existing · core", draw_files),
    ("settings", "Settings", "设置", "Existing · six pages", draw_settings),
    ("terminal", "Terminal", "终端", "Existing · foot", draw_terminal),
    ("text-editor", "Text Editor", "文本编辑", "Existing · basic", draw_text_editor),
    ("photos", "Photos", "照片", "Proposed", draw_photos),
    ("music", "Music", "音乐", "Proposed", draw_music),
    ("calculator", "Calculator", "计算器", "Proposed", draw_calculator),
    ("calendar", "Calendar", "日历", "Proposed", draw_calendar),
    ("monitor", "System Monitor", "系统监视器", "Existing · Processes", draw_monitor),
    ("browser", "Browser", "浏览器", "External · Chromium tested", draw_browser),
]

FEATURES = [
    ("wifi", "Wi-Fi", draw_wifi),
    ("bluetooth", "Bluetooth", draw_bluetooth),
    ("volume", "Volume", draw_volume),
    ("brightness", "Brightness", draw_brightness),
    ("battery", "Battery", draw_battery),
    ("airplane", "Airplane", draw_airplane),
    ("night", "Night light", draw_night),
    ("accessibility", "Accessibility", draw_accessibility),
]


def font(size, cjk=False, bold=False):
    if cjk:
        return ImageFont.truetype(FONT_CJK, size)
    return ImageFont.truetype(FONT_BOLD if bold else "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", size)


def make_sheet(app_icons, feature_icons):
    W, H = 1800, 1280
    sheet = Image.new("RGBA", (W, H), rgba("#F5F7FA"))
    d = ImageDraw.Draw(sheet)
    d.text((90, 64), "PollyOS  ·  built-in app & capability showcase", font=font(46, bold=True),
           fill=rgba("#1E2935"))
    d.text((92, 128), "精简集合 · modern flat tiles with soft gradients · original artwork, not a claim that every app is implemented",
           font=font(22, cjk=True), fill=rgba("#5F7080"))
    d.line((90, 172, W - 90, 172), fill=rgba("#D8E0E8"), width=2)

    columns = 5
    card_w, card_h = 306, 330
    left, top = 90, 212
    for index, (slug, name, cjk, status, _) in enumerate(APPS):
        col, row = index % columns, index // columns
        x, y = left + col * (card_w + 18), top + row * (card_h + 22)
        d.rounded_rectangle((x, y, x + card_w, y + card_h), 26, fill=(255, 255, 255, 255),
                            outline=(214, 222, 231, 255), width=2)
        icon = app_icons[slug].resize((150, 150), Image.Resampling.LANCZOS)
        sheet.alpha_composite(icon, (x + (card_w - 150) // 2, y + 20))
        d.text((x + 22, y + 190), name, font=font(30, bold=True), fill=rgba("#1E2935"))
        d.text((x + 22, y + 232), cjk, font=font(24, cjk=True), fill=rgba("#5F7080"))
        d.text((x + 22, y + 280), status, font=font(17, cjk=True), fill=rgba("#2570B8"))

    d.text((90, 930), "System capabilities", font=font(34, bold=True), fill=rgba("#1E2935"))
    d.text((90, 976), "Start / Search · Taskbar · Notifications · Quick settings · Snap & workspaces · Theme center · File dialogs · IME & clipboard",
           font=font(22, cjk=True), fill=rgba("#5F7080"))
    fx = 90
    for slug, name, _ in FEATURES:
        icon = feature_icons[slug].resize((92, 92), Image.Resampling.LANCZOS)
        sheet.alpha_composite(icon, (fx, 1030))
        d.text((fx, 1132), name, font=font(19, bold=True), fill=rgba("#34465B"))
        fx += 208
    d.text((90, 1215), "Icons: original Pillow artwork, 1024px masters · 256/128/64 exports · no platform icons or fonts bundled",
           font=font(17), fill=rgba("#7B8898"))
    sheet.convert("RGB").save(OUT / "showcase-sheet.png", optimize=True)


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    app_icons, feature_icons = {}, {}
    manifest = {"schemaVersion": 1, "style": "modern flat tiles with soft gradients",
                "master": 1024, "apps": [], "features": []}
    for slug, name, cjk, status, draw in APPS:
        icon = draw()
        save(icon, slug)
        app_icons[slug] = icon
        manifest["apps"].append({"id": slug, "name": name, "nameZh": cjk, "status": status,
                                 "sizes": [256, 128, 64], "master": f"{slug}-1024.png"})
    for slug, name, draw in FEATURES:
        icon = draw()
        save(icon, slug)
        feature_icons[slug] = icon
        manifest["features"].append({"id": slug, "name": name, "sizes": [256, 128, 64],
                                     "master": f"{slug}-1024.png"})
    make_sheet(app_icons, feature_icons)
    (OUT / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    print("Wrote", OUT)


if __name__ == "__main__":
    main()
