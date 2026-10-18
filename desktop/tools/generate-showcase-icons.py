#!/usr/bin/env python3
"""Original skeuomorphic/modern showcase icon set for PollyOS.

Draws 1024px masters with Pillow, then exports 256/128/64 app icons, 256/96
feature glyphs and a contact sheet. No platform logos, fonts or downloaded art.
Run from the repository root:
    python3 desktop/tools/generate-showcase-icons.py
"""
from __future__ import annotations

import json
import math
from pathlib import Path

from PIL import Image, ImageChops, ImageDraw, ImageFilter, ImageFont, ImageOps

S = 1024
OUT = Path("desktop/resources/application-icons/showcase")
FONT_BOLD = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"
FONT_CJK = "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc"


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


def shadow(base: Image.Image, mask: Image.Image, offset=(0, 18), blur=28, opacity=95):
    layer = Image.new("RGBA", base.size, (0, 0, 0, 0))
    layer.paste(Image.new("RGBA", base.size, (0, 0, 0, opacity)), (0, 0), mask)
    layer = layer.filter(ImageFilter.GaussianBlur(blur))
    base.alpha_composite(ImageChops.offset(layer, *offset))


def highlight(base: Image.Image, box, radius, strength=70):
    w, h = box[2] - box[0], box[3] - box[1]
    layer = Image.new("RGBA", (w, h), (255, 255, 255, 0))
    mask = Image.new("L", (w, h), 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, w - 1, int(h * 0.42)),
                                           radius=radius, fill=255)
    layer.paste(Image.new("RGBA", (w, h), (255, 255, 255, strength)), (0, 0), mask)
    layer = layer.filter(ImageFilter.GaussianBlur(10))
    base.alpha_composite(layer, (box[0], box[1]))


def circle_gradient(size, top, bottom):
    layer = vgrad(size, top, bottom)
    mask = Image.new("L", size, 0)
    ImageDraw.Draw(mask).ellipse((0, 0, size[0] - 1, size[1] - 1), fill=255)
    layer.putalpha(mask)
    return layer


def save(icon: Image.Image, slug: str, master=False):
    sizes = (1024,) if master else (256, 128, 64)
    for size in sizes:
        icon.resize((size, size), Image.Resampling.LANCZOS).save(
            OUT / f"{slug}-{size}.png", optimize=True)


def draw_files() -> Image.Image:
    base = canvas()
    body = (190, 330, 834, 790)
    tab = (250, 270, 530, 380)
    mask = Image.new("L", base.size, 0)
    d = ImageDraw.Draw(mask)
    d.rounded_rectangle(body, 82, fill=255)
    d.rounded_rectangle(tab, 42, fill=255)
    shadow(base, mask, (0, 22), 32, 105)
    paste_gradient(base, tab, 42, "#F2BE55", "#D58A1E", "#B87412")
    paper = (320, 300, 700, 640)
    base.paste(Image.new("RGBA", (paper[2] - paper[0], paper[3] - paper[1]), (255, 255, 255, 255)),
               (paper[0], paper[1]), rounded_mask((paper[2] - paper[0], paper[3] - paper[1]), 18))
    pd = ImageDraw.Draw(base)
    for i, y in enumerate((350, 405, 460)):
        pd.rounded_rectangle((355, y, 660 - i * 40, y + 16), 8, fill=(178, 194, 210, 255))
    paste_gradient(base, body, 82, "#FFDA7A", "#EFA22B", "#C07A13", 4)
    flap = (190, 560, 834, 790)
    paste_gradient(base, flap, 82, "#FFE9A8", "#F6B63B", "#D08A1B", 3)
    highlight(base, (196, 336, 828, 560), 78, 60)
    d = ImageDraw.Draw(base)
    d.rounded_rectangle((250, 600, 780, 620), 10, fill=(255, 255, 255, 70))
    return base


def draw_settings() -> Image.Image:
    base = canvas()
    centre = 512
    tooth_mask = Image.new("L", (S, S), 0)
    tooth = Image.new("RGBA", (120, 240), (0, 0, 0, 0))
    tooth_grad = vgrad((120, 240), "#E4EDF6", "#8FA3B8")
    tooth.paste(tooth_grad, (0, 0), rounded_mask((120, 240), 30))
    tooth.alpha_composite(Image.new("RGBA", (120, 240), (255, 255, 255, 45)), (0, 0))
    ImageDraw.Draw(tooth).rounded_rectangle((1, 1, 118, 238), 29,
                                            outline=rgba("#6E8298"), width=3)
    tooth_alpha = Image.composite(tooth.getchannel("A"),
                                  Image.new("L", (120, 240), 0), rounded_mask((120, 240), 30))
    tooth_layer = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    tooth_layer.alpha_composite(tooth, (centre - 60, 86))
    tooth_mask_layer = Image.new("L", (S, S), 0)
    tooth_mask_layer.paste(tooth_alpha, (centre - 60, 86), tooth_alpha)
    teeth = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    for angle in range(0, 360, 45):
        teeth.alpha_composite(tooth_layer.rotate(angle, resample=Image.Resampling.BICUBIC,
                                                 center=(512, 512)))
        tooth_mask = ImageChops.lighter(
            tooth_mask, tooth_mask_layer.rotate(angle, resample=Image.Resampling.BICUBIC,
                                                center=(512, 512)))
    ring_mask = Image.new("L", (S, S), 0)
    ImageDraw.Draw(ring_mask).ellipse((252, 252, 772, 772), fill=255)
    full_mask = ImageChops.lighter(tooth_mask, ring_mask)
    shadow(base, full_mask, (0, 16), 28, 105)
    base.alpha_composite(teeth)
    ring = circle_gradient((520, 520), "#EAF2FA", "#7F94AB")
    base.alpha_composite(ring, (252, 252))
    ImageDraw.Draw(base).ellipse((252, 252, 772, 772), outline=rgba("#6F8298"), width=8)
    inner = circle_gradient((320, 320), "#7A8FA5", "#445A70")
    base.alpha_composite(inner, (352, 352))
    ImageDraw.Draw(base).ellipse((432, 432, 592, 592), fill=rgba("#45596E"),
                                 outline=rgba("#AEC2D6"), width=8)
    highlight(base, (270, 260, 754, 520), 240, 65)
    return base


def draw_terminal() -> Image.Image:
    base = canvas()
    frame = (190, 190, 834, 834)
    mask = Image.new("L", base.size, 0)
    ImageDraw.Draw(mask).rounded_rectangle(frame, 110, fill=255)
    shadow(base, mask, (0, 22), 34, 110)
    paste_gradient(base, frame, 110, "#34343A", "#111114", "#4A4A52", 4)
    ImageDraw.Draw(base).rounded_rectangle((190, 190, 834, 300), 110, fill=rgba("#3B3B42"))
    ImageDraw.Draw(base).rectangle((190, 270, 834, 300), fill=rgba("#2A2A30"))
    for i, colour in enumerate(("#E05A55", "#E5B34D", "#62B96B")):
        ImageDraw.Draw(base).ellipse((250 + i * 62, 222, 286 + i * 62, 258), fill=rgba(colour))
    d = ImageDraw.Draw(base)
    d.line([(330, 390), (470, 500), (330, 610)], fill=(245, 248, 252, 255), width=38, joint="curve")
    d.rounded_rectangle((510, 592, 700, 628), 18, fill=(118, 214, 132, 255))
    highlight(base, (200, 200, 824, 430), 100, 45)
    return base


def draw_text_editor() -> Image.Image:
    base = canvas()
    back = Image.new("RGBA", (560, 700), (0, 0, 0, 0))
    bd = ImageDraw.Draw(back)
    bd.rounded_rectangle((0, 0, 550, 690), 32, fill=rgba("#E9EEF5"), outline=rgba("#B7C4D3"), width=4)
    back = back.rotate(-5, resample=Image.Resampling.BICUBIC, expand=True)
    base.alpha_composite(back, (250, 230))
    page = (240, 190, 780, 830)
    mask = Image.new("L", base.size, 0)
    ImageDraw.Draw(mask).rounded_rectangle(page, 34, fill=255)
    shadow(base, mask, (0, 20), 28, 95)
    paste_gradient(base, page, 34, "#FFFFFF", "#F1F5FA", "#B8C5D4", 3)
    d = ImageDraw.Draw(base)
    d.polygon([(690, 190), (780, 280), (690, 280)], fill=rgba("#DCE6F1"))
    d.line([(690, 190), (780, 280)], fill=rgba("#B8C5D4"), width=4)
    d.line([(330, 300), (330, 760)], fill=rgba("#E8A0A0"), width=5)
    for i, y in enumerate(range(320, 740, 58)):
        d.rounded_rectangle((360, y, 700 - (i % 3) * 45, y + 14), 7, fill=rgba("#8FA7C2"))
    pencil = Image.new("RGBA", (420, 140), (0, 0, 0, 0))
    pd = ImageDraw.Draw(pencil)
    pd.rounded_rectangle((30, 40, 320, 100), 28, fill=rgba("#F6C64A"))
    pd.rounded_rectangle((30, 40, 320, 64), 18, fill=rgba("#FFE08A"))
    pd.polygon([(320, 40), (400, 70), (320, 100)], fill=rgba("#E8C49A"))
    pd.polygon([(378, 58), (400, 70), (378, 82)], fill=rgba("#3B3B3B"))
    pencil = pencil.rotate(-38, resample=Image.Resampling.BICUBIC, expand=True)
    base.alpha_composite(pencil, (500, 610))
    highlight(base, (248, 198, 772, 430), 32, 70)
    return base


def draw_photos() -> Image.Image:
    base = canvas()
    back = Image.new("RGBA", (560, 560), (0, 0, 0, 0))
    ImageDraw.Draw(back).rounded_rectangle((0, 0, 550, 550), 24, fill=rgba("#FFFFFF"), outline=rgba("#C7D1DC"), width=4)
    back = back.rotate(7, resample=Image.Resampling.BICUBIC, expand=True)
    base.alpha_composite(back, (300, 260))
    card = (220, 220, 800, 800)
    mask = Image.new("L", base.size, 0)
    ImageDraw.Draw(mask).rounded_rectangle(card, 28, fill=255)
    shadow(base, mask, (0, 20), 28, 100)
    base.paste(Image.new("RGBA", (580, 580), (255, 255, 255, 255)), (220, 220),
               rounded_mask((580, 580), 28))
    sky = vgrad((500, 360), "#6CB7F2", "#D6EEFF")
    base.paste(sky, (260, 260), rounded_mask((500, 360), 12))
    d = ImageDraw.Draw(base)
    d.ellipse((620, 300, 700, 380), fill=(255, 236, 150, 255))
    d.polygon([(260, 620), (410, 430), (560, 620)], fill=rgba("#5B9E67"))
    d.polygon([(430, 620), (590, 470), (760, 620)], fill=rgba("#3F7F52"))
    d.rectangle((260, 590, 760, 620), fill=rgba("#77B67C"))
    d.rounded_rectangle((220, 220, 800, 800), 28, outline=rgba("#C3CEDB"), width=4)
    highlight(base, (226, 226, 794, 420), 24, 65)
    return base


def draw_music() -> Image.Image:
    base = canvas()
    tile = (180, 180, 844, 844)
    mask = Image.new("L", base.size, 0)
    ImageDraw.Draw(mask).rounded_rectangle(tile, 190, fill=255)
    shadow(base, mask, (0, 22), 34, 110)
    paste_gradient(base, tile, 190, "#6E9BF2", "#1B3E9C", "#15347E", 5)
    d = ImageDraw.Draw(base)
    d.arc((260, 250, 764, 754), 180, 360, fill=(246, 249, 253, 255), width=58)
    d.arc((288, 278, 736, 726), 180, 360, fill=(176, 192, 212, 255), width=18)
    for box in ((236, 520, 378, 770), (646, 520, 788, 770)):
        paste_gradient(base, box, 56, "#FBFCFE", "#B6C2D2", "#7D8DA1", 4)
        inner = (box[0] + 24, box[1] + 26, box[2] - 24, box[3] - 26)
        paste_gradient(base, inner, 38, "#3A5A9E", "#162E63", "#0E1F44", 3)
        d.rounded_rectangle((box[0] + 18, box[1] + 40, box[0] + 30, box[3] - 40), 6,
                            fill=(255, 255, 255, 105))
    highlight(base, (196, 196, 828, 430), 160, 65)
    return base


def draw_calculator() -> Image.Image:
    base = canvas()
    body = (230, 190, 794, 840)
    mask = Image.new("L", base.size, 0)
    ImageDraw.Draw(mask).rounded_rectangle(body, 70, fill=255)
    shadow(base, mask, (0, 22), 32, 105)
    paste_gradient(base, body, 70, "#FBFCFE", "#C8D0DA", "#8E99A8", 4)
    display = (288, 260, 736, 420)
    paste_gradient(base, display, 24, "#2A3A4C", "#111C27", "#0B131B", 3)
    d = ImageDraw.Draw(base)
    d.text((320, 300), "1280", font=ImageFont.truetype(FONT_BOLD, 108), fill=(210, 236, 224, 255))
    for row, values in enumerate((("7", "8", "9", "÷"), ("4", "5", "6", "×"),
                                  ("1", "2", "3", "−"), ("0", ".", "=", "+"))):
        for col, value in enumerate(values):
            x = 306 + col * 112
            y = 470 + row * 92
            operator = col == 3 or value == "="
            fill = "#F2A33A" if operator else "#F7F9FC"
            border = "#C57A1F" if operator else "#AEB9C7"
            d.rounded_rectangle((x, y, x + 88, y + 72), 22, fill=rgba(fill), outline=rgba(border), width=3)
            d.text((x + 30, y + 10), value, font=ImageFont.truetype(FONT_BOLD, 44),
                   fill=rgba("#FFFFFF" if operator else "#34465B"))
    highlight(base, (238, 198, 786, 420), 64, 75)
    return base


def draw_calendar() -> Image.Image:
    base = canvas()
    page = (250, 220, 774, 840)
    mask = Image.new("L", base.size, 0)
    ImageDraw.Draw(mask).rounded_rectangle(page, 34, fill=255)
    shadow(base, mask, (0, 22), 30, 105)
    base.paste(Image.new("RGBA", (524, 620), (255, 255, 255, 255)), (250, 220),
               rounded_mask((524, 620), 34))
    paste_gradient(base, (250, 220, 774, 390), 34, "#E95757", "#B92332", "#9E1B28", 3)
    d = ImageDraw.Draw(base)
    d.rectangle((250, 330, 774, 390), fill=rgba("#C42D3A"))
    for i in range(7):
        x = 300 + i * 62
        d.ellipse((x, 190, x + 34, 250), fill=rgba("#D8DEE7"), outline=rgba("#8D99A9"), width=3)
    d.text((330, 270), "OCT", font=ImageFont.truetype(FONT_BOLD, 52), fill=(255, 255, 255, 255))
    d.text((445, 440), "18", font=ImageFont.truetype(FONT_BOLD, 220), fill=(52, 65, 82, 255))
    d.text((400, 700), "FRIDAY", font=ImageFont.truetype(FONT_BOLD, 54), fill=(126, 141, 160, 255))
    for i in range(5):
        d.rounded_rectangle((300 + i * 34, 780, 326 + i * 34, 796), 6, fill=rgba("#C3CFDD"))
    highlight(base, (256, 226, 768, 390), 30, 55)
    return base


def draw_monitor() -> Image.Image:
    base = canvas()
    screen = (190, 230, 834, 700)
    mask = Image.new("L", base.size, 0)
    ImageDraw.Draw(mask).rounded_rectangle(screen, 46, fill=255)
    shadow(base, mask, (0, 22), 32, 105)
    paste_gradient(base, screen, 46, "#3A4654", "#161D26", "#0D1218", 4)
    base.paste(Image.new("RGBA", (560, 360), (255, 255, 255, 0)), (232, 276))
    inner = (232, 276, 792, 654)
    paste_gradient(base, inner, 22, "#12283A", "#08141D", "#20384D", 2)
    d = ImageDraw.Draw(base)
    for i in range(6):
        d.line((260 + i * 90, 300, 260 + i * 90, 630), fill=(64, 96, 120, 90), width=2)
    for i in range(5):
        d.line((260, 320 + i * 70, 764, 320 + i * 70), fill=(64, 96, 120, 90), width=2)
    points = [(270, 570), (350, 520), (420, 550), (500, 430), (570, 470), (650, 370), (760, 400)]
    d.line(points, fill=(104, 226, 156, 255), width=12, joint="curve")
    for point in points:
        d.ellipse((point[0] - 8, point[1] - 8, point[0] + 8, point[1] + 8), fill=(190, 255, 210, 255))
    d.rounded_rectangle((452, 700, 572, 760), 10, fill=rgba("#2C3642"))
    d.rounded_rectangle((350, 760, 674, 800), 18, fill=rgba("#4B5866"))
    highlight(base, (198, 238, 826, 400), 40, 55)
    return base


def draw_browser() -> Image.Image:
    base = canvas()
    disc = (190, 190, 834, 834)
    mask = Image.new("L", base.size, 0)
    ImageDraw.Draw(mask).ellipse(disc, fill=255)
    shadow(base, mask, (0, 22), 32, 110)
    globe = circle_gradient((644, 644), "#5CB7F5", "#1A5FBE")
    base.alpha_composite(globe, (190, 190))
    lines = Image.new("RGBA", base.size, (0, 0, 0, 0))
    ld = ImageDraw.Draw(lines)
    for x in range(280, 820, 74):
        ld.arc((x - 40, 210, x + 40, 814), 0, 360, fill=(255, 255, 255, 75), width=3)
    for y in range(300, 760, 74):
        ld.arc((210, y - 40, 814, y + 40), 0, 360, fill=(255, 255, 255, 75), width=3)
    lines.putalpha(Image.composite(lines.getchannel("A"), Image.new("L", base.size, 0), mask))
    base.alpha_composite(lines)
    d = ImageDraw.Draw(base)
    d.polygon([(512, 300), (565, 500), (512, 465), (459, 500)], fill=(232, 60, 66, 255))
    d.polygon([(512, 724), (459, 524), (512, 559), (565, 524)], fill=(246, 248, 252, 255))
    d.ellipse((492, 492, 532, 532), fill=rgba("#2B3B52"))
    d.ellipse((502, 502, 522, 522), fill=rgba("#F6F8FC"))
    d.arc((210, 210, 814, 814), 200, 330, fill=(255, 255, 255, 130), width=14)
    return base


def badge(top: str, bottom: str, border: str) -> tuple[Image.Image, ImageDraw.ImageDraw]:
    base = canvas()
    box = (24, 24, S - 24, S - 24)
    mask = Image.new("L", base.size, 0)
    ImageDraw.Draw(mask).rounded_rectangle(box, 200, fill=255)
    shadow(base, mask, (0, 18), 28, 90)
    paste_gradient(base, box, 200, top, bottom, border, 5)
    highlight(base, (40, 40, S - 40, 380), 160, 55)
    return base, ImageDraw.Draw(base)


def draw_wifi() -> Image.Image:
    base, d = badge("#60B9F5", "#1D6CC0", "#155A9F")
    for radius, width in ((220, 26), (150, 26), (80, 26)):
        d.arc((512 - radius, 330 - radius, 512 + radius, 330 + radius), 210, 330,
              fill=(255, 255, 255, 255), width=width)
    d.ellipse((482, 560, 542, 620), fill=(255, 255, 255, 255))
    return base


def draw_bluetooth() -> Image.Image:
    base, d = badge("#69A8F0", "#2458B8", "#1B4590")
    white = (255, 255, 255, 255)
    d.line([(420, 360), (620, 540), (512, 640), (512, 320), (620, 420), (420, 600)],
           fill=white, width=34, joint="curve")
    return base


def draw_volume() -> Image.Image:
    base, d = badge("#7ED0B0", "#1E8B69", "#146A50")
    white = (255, 255, 255, 255)
    d.polygon([(350, 430), (440, 430), (560, 340), (560, 684), (440, 594), (350, 594)], fill=white)
    for radius in (120, 190, 260):
        d.arc((560 - radius, 512 - radius, 560 + radius, 512 + radius), 300, 60,
              fill=white, width=26)
    return base


def draw_brightness() -> Image.Image:
    base, d = badge("#FFD36E", "#E28A1E", "#B96A10")
    white = (255, 255, 255, 255)
    d.ellipse((402, 402, 622, 622), fill=white)
    for angle in range(0, 360, 45):
        rad = math.radians(angle)
        x1, y1 = 512 + math.cos(rad) * 280, 512 + math.sin(rad) * 280
        x2, y2 = 512 + math.cos(rad) * 360, 512 + math.sin(rad) * 360
        d.line((x1, y1, x2, y2), fill=white, width=30)
    return base


def draw_battery() -> Image.Image:
    base, d = badge("#8BD58D", "#2C8A46", "#1F6A34")
    dark = (22, 42, 32, 255)
    white = (255, 255, 255, 255)
    d.rounded_rectangle((300, 400, 700, 620), 34, outline=white, width=26)
    d.rounded_rectangle((700, 470, 740, 550), 14, fill=white)
    d.rounded_rectangle((336, 436, 618, 584), 18, fill=white)
    return base


def draw_airplane() -> Image.Image:
    base, d = badge("#7EB8EF", "#245FA9", "#174579")
    white = (255, 255, 255, 255)
    d.polygon([(512, 220), (570, 470), (806, 560), (806, 620), (570, 570),
               (570, 700), (650, 760), (650, 800), (512, 750), (374, 800),
               (374, 760), (454, 700), (454, 570), (218, 620), (218, 560),
               (454, 470)], fill=white)
    return base


def draw_night() -> Image.Image:
    base, d = badge("#6D7FE8", "#2A2F86", "#202463")
    mask = Image.new("L", (S, S), 0)
    md = ImageDraw.Draw(mask)
    md.ellipse((330, 280, 700, 650), fill=255)
    md.ellipse((430, 200, 800, 570), fill=0)
    layer = Image.new("RGBA", (S, S), (255, 255, 255, 255))
    base.alpha_composite(Image.composite(layer, Image.new("RGBA", (S, S), (0, 0, 0, 0)), mask))
    d = ImageDraw.Draw(base)
    for x, y, r in ((620, 330, 12), (690, 430, 9), (600, 500, 7)):
        d.ellipse((x - r, y - r, x + r, y + r), fill=(255, 255, 255, 220))
    return base


def draw_accessibility() -> Image.Image:
    base, d = badge("#71B6F2", "#2B62B8", "#1C4A91")
    white = (255, 255, 255, 255)
    d.ellipse((472, 270, 552, 350), fill=white)
    d.rounded_rectangle((496, 370, 528, 560), 16, fill=white)
    d.line([(360, 430), (664, 430)], fill=white, width=30)
    d.line([(512, 540), (400, 730)], fill=white, width=30)
    d.line([(512, 540), (624, 730)], fill=white, width=30)
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
    sheet = Image.new("RGBA", (W, H), rgba("#F4F6F9"))
    d = ImageDraw.Draw(sheet)
    d.text((90, 64), "PollyOS  ·  built-in app & capability showcase", font=font(46, bold=True), fill=rgba("#1F2A36"))
    d.text((92, 128), "精简集合 / concise set  ·  original skeuomorphic icon study  ·  not a claim that every app is implemented",
           font=font(22, cjk=True), fill=rgba("#61707F"))
    d.line((90, 172, W - 90, 172), fill=rgba("#D5DDE6"), width=2)

    columns = 5
    card_w, card_h = 306, 330
    left, top = 90, 212
    for index, (slug, name, cjk, status, _) in enumerate(APPS):
        col, row = index % columns, index // columns
        x, y = left + col * (card_w + 18), top + row * (card_h + 22)
        d.rounded_rectangle((x, y, x + card_w, y + card_h), 26, fill=(255, 255, 255, 255),
                            outline=(214, 222, 231, 255), width=2)
        d.rounded_rectangle((x + 1, y + 1, x + card_w - 1, y + 150), 24, fill=(247, 249, 252, 255))
        icon = app_icons[slug].resize((150, 150), Image.Resampling.LANCZOS)
        sheet.alpha_composite(icon, (x + (card_w - 150) // 2, y + 18))
        d.text((x + 22, y + 186), name, font=font(30, bold=True), fill=rgba("#1F2A36"))
        d.text((x + 22, y + 228), cjk, font=font(24, cjk=True), fill=rgba("#5B6B7C"))
        d.text((x + 22, y + 276), status, font=font(17, cjk=True), fill=rgba("#2A70B8"))

    d.text((90, 930), "System capabilities", font=font(34, bold=True), fill=rgba("#1F2A36"))
    d.text((90, 976), "Start / Search · Taskbar · Notifications · Quick settings · Snap & workspaces · Theme center · File dialogs · IME & clipboard",
           font=font(22, cjk=True), fill=rgba("#5B6B7C"))
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
    app_icons, feature_icons, manifest = {}, {}, {"schemaVersion": 1, "style": "original skeuomorphic/modern",
                                                   "master": 1024, "apps": [], "features": []}
    for slug, name, cjk, status, draw in APPS:
        icon = draw()
        icon.save(OUT / f"{slug}-1024.png", optimize=True)
        save(icon, slug)
        app_icons[slug] = icon
        manifest["apps"].append({"id": slug, "name": name, "nameZh": cjk, "status": status,
                                 "sizes": [256, 128, 64], "master": f"{slug}-1024.png"})
    for slug, name, draw in FEATURES:
        icon = draw()
        icon.save(OUT / f"{slug}-1024.png", optimize=True)
        save(icon, slug)
        feature_icons[slug] = icon
        manifest["features"].append({"id": slug, "name": name, "sizes": [256, 128, 64],
                                     "master": f"{slug}-1024.png"})
    make_sheet(app_icons, feature_icons)
    (OUT / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    print("Wrote", OUT)


if __name__ == "__main__":
    main()
