#!/usr/bin/env python3
"""PollyOS showcase icons, macOS-inspired depth with an original flat silhouette.

Layered superellipse tiles, soft material gradients, inner rims, ambient shadows
and restrained specular light. No platform logos, icons or fonts are copied.

Run from the repository root:
    python3 desktop/tools/generate-showcase-icons.py
"""
from __future__ import annotations

import json
import math
from pathlib import Path

from PIL import Image, ImageChops, ImageDraw, ImageFilter, ImageFont, ImageOps

S = 1024
INSET = 86
OUT = Path("desktop/resources/application-icons/showcase")
FONT_BOLD = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"
FONT_CJK = "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc"
WHITE = (255, 255, 255, 250)


def rgba(value: str, alpha: int = 255) -> tuple[int, int, int, int]:
    value = value.lstrip("#")
    return (int(value[0:2], 16), int(value[2:4], 16), int(value[4:6], 16), alpha)


def canvas() -> Image.Image:
    return Image.new("RGBA", (S, S), (0, 0, 0, 0))


def vgrad(size: tuple[int, int], top: str, bottom: str) -> Image.Image:
    gradient = Image.linear_gradient("L").resize(size, Image.Resampling.BICUBIC)
    return ImageOps.colorize(gradient, rgba(top), rgba(bottom)).convert("RGBA")


def squircle_mask(size: int = S, inset: int = INSET, n: float = 4.8, ss: int = 2) -> Image.Image:
    big = size * ss
    mask = Image.new("L", (big, big), 0)
    points = []
    centre = big / 2
    radius = big / 2 - inset * ss
    for index in range(256):
        angle = 2 * math.pi * index / 256
        cosine, sine = math.cos(angle), math.sin(angle)
        x = centre + radius * math.copysign(abs(cosine) ** (2 / n), cosine)
        y = centre + radius * math.copysign(abs(sine) ** (2 / n), sine)
        points.append((x, y))
    ImageDraw.Draw(mask).polygon(points, fill=255)
    return mask.resize((size, size), Image.Resampling.LANCZOS)


def rounded_mask(size: tuple[int, int], radius: float) -> Image.Image:
    mask = Image.new("L", size, 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, size[0] - 1, size[1] - 1),
                                           radius=radius, fill=255)
    return mask


def circle_mask(size: int) -> Image.Image:
    mask = Image.new("L", (size, size), 0)
    ImageDraw.Draw(mask).ellipse((0, 0, size - 1, size - 1), fill=255)
    return mask


def drop_shadow(base: Image.Image, mask: Image.Image, offset=(0, 18), blur=30, opacity=80):
    layer = Image.new("RGBA", base.size, (0, 0, 0, 0))
    layer.paste(Image.new("RGBA", base.size, (0, 0, 0, opacity)), (0, 0), mask)
    layer = layer.filter(ImageFilter.GaussianBlur(blur))
    base.alpha_composite(ImageChops.offset(layer, *offset))


def gradient_shape(base: Image.Image, box, radius, top, bottom, border=None, width=3):
    w, h = box[2] - box[0], box[3] - box[1]
    layer = vgrad((w, h), top, bottom)
    mask = rounded_mask((w, h), radius)
    layer.putalpha(mask)
    base.alpha_composite(layer, (box[0], box[1]))
    if border:
        ImageDraw.Draw(base).rounded_rectangle(box, radius=radius,
                                               outline=rgba(border), width=width)


def circle_gradient(size: int, top: str, bottom: str) -> Image.Image:
    layer = vgrad((size, size), top, bottom)
    layer.putalpha(circle_mask(size))
    return layer


def clip_to(base: Image.Image, overlay: Image.Image, mask: Image.Image, dest=(0, 0)):
    overlay.putalpha(ImageChops.multiply(overlay.getchannel("A"), mask))
    base.alpha_composite(overlay, dest)


def tile(top: str, bottom: str, border: str | None = None, accent: str | None = None):
    base = canvas()
    mask = squircle_mask()
    drop_shadow(base, mask, (0, 24), 38, 90)
    fill = vgrad((S, S), top, bottom)
    fill.putalpha(mask)
    base.alpha_composite(fill)

    if accent:
        band = Image.new("RGBA", (S, S), (0, 0, 0, 0))
        ImageDraw.Draw(band).polygon(
            [(0, 0), (S, 0), (S, int(S * 0.60)), (0, int(S * 0.34))],
            fill=rgba(accent, 108))
        clip_to(base, band.filter(ImageFilter.GaussianBlur(30)), mask)
        seam = Image.new("RGBA", (S, S), (0, 0, 0, 0))
        ImageDraw.Draw(seam).line([(0, int(S * 0.34)), (S, int(S * 0.60))],
                                  fill=(255, 255, 255, 44), width=3)
        clip_to(base, seam.filter(ImageFilter.GaussianBlur(3)), mask)

    # Soft top light and bottom ambient occlusion.
    light = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    light.paste(Image.new("RGBA", (S, S), (255, 255, 255, 74)), (0, 0),
                Image.linear_gradient("L").resize((S, S)).point(lambda v: max(0, 210 - v)))
    clip_to(base, light.filter(ImageFilter.GaussianBlur(26)), mask)
    dark = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    dark.paste(Image.new("RGBA", (S, S), (0, 0, 0, 70)), (0, 0),
               Image.linear_gradient("L").resize((S, S)).point(lambda v: max(0, v - 130)))
    clip_to(base, dark.filter(ImageFilter.GaussianBlur(30)), mask)

    # A single broad specular bloom, not a glossy band.
    bloom = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    bloom.paste(Image.new("RGBA", (700, 700), (255, 255, 255, 46)), (0, 0),
                circle_mask(700))
    clip_to(base, bloom.filter(ImageFilter.GaussianBlur(90)), mask)

    # Inner rim.
    edge = mask.filter(ImageFilter.FIND_EDGES).filter(ImageFilter.GaussianBlur(2))
    rim = Image.new("RGBA", (S, S), (255, 255, 255, 0))
    rim.putalpha(edge.point(lambda v: int(v * 0.52)))
    base.alpha_composite(rim)
    if border:
        outline = mask.filter(ImageFilter.FIND_EDGES).filter(ImageFilter.GaussianBlur(1))
        darkrim = Image.new("RGBA", (S, S), (0, 0, 0, 0))
        darkrim.putalpha(outline.point(lambda v: int(v * 0.35)))
        base.alpha_composite(darkrim)
    return base, ImageDraw.Draw(base)


def object_shadow(base: Image.Image, box, radius, offset=(0, 16), blur=18, opacity=90):
    w, h = box[2] - box[0], box[3] - box[1]
    mask = Image.new("L", base.size, 0)
    ImageDraw.Draw(mask).rounded_rectangle(box, radius=radius, fill=255)
    drop_shadow(base, mask, offset, blur, opacity)


def save(icon: Image.Image, slug: str):
    icon.save(OUT / f"{slug}-1024.png", optimize=True)
    for size in (256, 128, 64):
        icon.resize((size, size), Image.Resampling.LANCZOS).save(
            OUT / f"{slug}-{size}.png", optimize=True)


# ---------------------------------------------------------------- applications


def draw_files() -> Image.Image:
    base, d = tile("#5AA7FF", "#1D56B0", "#133F82", "#BFE1FF")
    body = (250, 372, 774, 742)
    tab = (318, 300, 548, 430)
    object_shadow(base, (250, 360, 790, 760), 70, (0, 24), 30, 80)
    gradient_shape(base, tab, 34, "#E9A62C", "#BE7310", "#9A5B0A", 4)
    gradient_shape(base, body, 62, "#F7C64F", "#D98C18", "#A9640A", 4)
    # inner paper
    gradient_shape(base, (330, 330, 700, 690), 22, "#FFFFFF", "#DFE8F3", "#B6C4D5", 3)
    for y in (410, 470, 530):
        d.rounded_rectangle((366, y, 664, y + 16), 8, fill=(172, 190, 208, 255))
    # front pocket
    front = (250, 560, 774, 742)
    gradient_shape(base, front, 62, "#FFE7A8", "#F6B43A", "#CE8618", 4)
    shade = Image.new("RGBA", (524, 182), (0, 0, 0, 0))
    shade.paste(Image.new("RGBA", (524, 182), (0, 0, 0, 70)), (0, 0),
                Image.linear_gradient("L").resize((524, 182)))
    clip_to(base, shade.filter(ImageFilter.GaussianBlur(14)), rounded_mask((524, 182), 62),
            (250, 560))
    d.rounded_rectangle((292, 604, 732, 624), 10, fill=(255, 255, 255, 65))
    return base


def draw_settings() -> Image.Image:
    base, d = tile("#DDE6F0", "#8FA2B6", "#66798E", "#FFFFFF")
    tooth = Image.new("RGBA", (124, 170), (0, 0, 0, 0))
    tg = vgrad((124, 170), "#FDFEFF", "#A7B8CA")
    tooth.paste(tg, (0, 0), rounded_mask((124, 170), 32))
    ImageDraw.Draw(tooth).rounded_rectangle((1, 1, 122, 168), 31,
                                            outline=rgba("#71869B"), width=4)
    tooth_layer = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    tooth_layer.alpha_composite(tooth, (450, 142))
    for angle in range(0, 360, 45):
        base.alpha_composite(tooth_layer.rotate(angle, resample=Image.Resampling.BICUBIC,
                                                center=(512, 512)))
    object_shadow(base, (252, 252, 772, 772), 260, (0, 18), 26, 90)
    ring = circle_gradient(520, "#FDFEFF", "#C3D0DE")
    base.alpha_composite(ring, (252, 252))
    d.ellipse((252, 252, 772, 772), outline=rgba("#6B7F94"), width=7)
    d.ellipse((448, 448, 576, 576), fill=rgba("#41556A"), outline=rgba("#93A8BC"), width=6)
    d.arc((272, 272, 752, 752), 200, 330, fill=(255, 255, 255, 120), width=10)
    return base


def draw_terminal() -> Image.Image:
    base, d = tile("#3A3A40", "#0A0A0C", "#050506", "#70707A")
    glass = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    ImageDraw.Draw(glass).polygon([(150, 120), (650, 90), (420, 520), (110, 300)],
                                  fill=(255, 255, 255, 22))
    clip_to(base, glass.filter(ImageFilter.GaussianBlur(30)), squircle_mask())
    glow = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    ImageDraw.Draw(glow).line([(330, 386), (470, 500), (330, 614)], fill=(255, 255, 255, 120),
                              width=64, joint="curve")
    clip_to(base, glow.filter(ImageFilter.GaussianBlur(22)), squircle_mask())
    d.line([(330, 386), (470, 500), (330, 614)], fill=WHITE, width=46, joint="curve")
    d.rounded_rectangle((516, 592, 704, 632), 20, fill=(126, 226, 146, 255))
    d.rounded_rectangle((516, 592, 704, 632), 20, outline=(190, 255, 205, 120), width=2)
    return base


def draw_text_editor() -> Image.Image:
    base, d = tile("#74A7F7", "#2C5BC4", "#1C438F", "#BFD6FF")
    object_shadow(base, (300, 270, 720, 760), 38, (0, 18), 24, 80)
    gradient_shape(base, (340, 300, 690, 750), 30, "#F4F7FC", "#CDDAEA", "#A8B8CC", 3)
    gradient_shape(base, (310, 260, 712, 748), 34, "#FFFFFF", "#E7EEF8", "#B6C5D8", 3)
    d.polygon([(612, 260), (712, 360), (612, 360)], fill=(214, 227, 246, 255))
    d.line([(612, 260), (712, 360)], fill=(167, 186, 209), width=3)
    for y in (420, 486, 552, 618):
        d.rounded_rectangle((366, y, 658, y + 16), 8, fill=(87, 128, 200, 235))
    # pencil with ferrule and wood tip
    pencil = Image.new("RGBA", (460, 150), (0, 0, 0, 0))
    pd = ImageDraw.Draw(pencil)
    pd.rounded_rectangle((20, 44, 300, 106), 30, fill=rgba("#F4C444"))
    pd.rounded_rectangle((20, 44, 300, 70), 26, fill=rgba("#FFE38A"))
    pd.rounded_rectangle((300, 44, 370, 106), 12, fill=rgba("#C9D2DE"))
    pd.rounded_rectangle((322, 44, 340, 106), 6, fill=rgba("#8FA0B4"))
    pd.polygon([(368, 44), (446, 75), (368, 106)], fill=rgba("#E7C49B"))
    pd.polygon([(420, 66), (446, 75), (420, 84)], fill=rgba("#38383B"))
    pencil = pencil.rotate(-38, resample=Image.Resampling.BICUBIC, expand=True)
    base.alpha_composite(pencil, (470, 590))
    return base


def draw_photos() -> Image.Image:
    base, d = tile("#FFB26E", "#EA4A20", "#C33712", "#FFD2B0")
    for angle, offset in ((8, (330, 280)), (-6, (300, 260))):
        card = Image.new("RGBA", (520, 520), (0, 0, 0, 0))
        ImageDraw.Draw(card).rounded_rectangle((0, 0, 510, 510), 26, fill=WHITE)
        card = card.rotate(angle, resample=Image.Resampling.BICUBIC, expand=True)
        base.alpha_composite(card, offset)
    object_shadow(base, (270, 250, 770, 750), 30, (0, 20), 24, 90)
    d.rounded_rectangle((260, 250, 760, 750), 30, fill=WHITE)
    d.rounded_rectangle((300, 292, 720, 708), 20, fill=rgba("#F0642E"))
    sky = vgrad((420, 260), "#8FD3FF", "#FFD3A0")
    base.paste(sky, (300, 292), rounded_mask((420, 260), 20))
    d.ellipse((592, 336, 668, 412), fill=(255, 244, 184, 255))
    d.polygon([(300, 660), (440, 470), (580, 660)], fill=rgba("#4E8F62"))
    d.polygon([(500, 660), (620, 520), (720, 660)], fill=rgba("#356F4B"))
    d.rounded_rectangle((300, 640, 720, 660), 10, fill=rgba("#77B77C"))
    gloss = Image.new("RGBA", (420, 260), (255, 255, 255, 0))
    gloss.paste(Image.new("RGBA", (420, 260), (255, 255, 255, 45)), (0, 0),
                Image.linear_gradient("L").resize((420, 260)).point(lambda v: max(0, 180 - v)))
    clip_to(base, gloss.filter(ImageFilter.GaussianBlur(22)), rounded_mask((420, 260), 20),
            (300, 292))
    return base


def draw_music() -> Image.Image:
    base, d = tile("#FF7FA2", "#C2185B", "#931044", "#FFC1D2")
    d.ellipse((250, 250, 774, 774), fill=(255, 255, 255, 18))
    # beam and note heads with a soft cast shadow
    shadow = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    sd = ImageDraw.Draw(shadow)
    sd.polygon([(430, 370), (724, 300), (724, 356), (430, 426)], fill=(0, 0, 0, 90))
    sd.rounded_rectangle((492, 360, 520, 670), 14, fill=(0, 0, 0, 90))
    sd.rounded_rectangle((696, 300, 724, 610), 14, fill=(0, 0, 0, 90))
    sd.ellipse((372, 620, 522, 720), fill=(0, 0, 0, 90))
    sd.ellipse((596, 560, 746, 660), fill=(0, 0, 0, 90))
    clip_to(base, shadow.filter(ImageFilter.GaussianBlur(20)), squircle_mask())
    d.polygon([(430, 356), (724, 286), (724, 342), (430, 412)], fill=WHITE)
    d.rounded_rectangle((492, 346, 520, 656), 14, fill=WHITE)
    d.rounded_rectangle((696, 286, 724, 596), 14, fill=WHITE)
    d.ellipse((372, 606, 522, 706), fill=WHITE)
    d.ellipse((596, 546, 746, 646), fill=WHITE)
    d.ellipse((404, 626, 468, 674), fill=(255, 255, 255, 190))
    d.arc((280, 280, 744, 744), 200, 330, fill=(255, 255, 255, 90), width=8)
    return base


def draw_calculator() -> Image.Image:
    base, d = tile("#56565E", "#1B1B1F", "#0E0E11", "#A0A0AA")
    object_shadow(base, (280, 232, 744, 792), 58, (0, 20), 26, 85)
    gradient_shape(base, (280, 232, 744, 792), 58, "#F9FBFD", "#BEC9D6", "#8C99A9", 4)
    gradient_shape(base, (330, 292, 694, 430), 26, "#2B3542", "#0E1721", "#081018", 3)
    d.rounded_rectangle((356, 330, 668, 392), 14, fill=(146, 229, 173, 255))
    d.text((380, 302), "1280", font=ImageFont.truetype(FONT_BOLD, 80), fill=(196, 245, 210, 255))
    for row in range(3):
        for col in range(3):
            x, y = 336 + col * 108, 474 + row * 92
            gradient_shape(base, (x, y, x + 78, y + 68), 20, "#FFFFFF", "#D3DCE7", "#A9B7C6", 2)
    gradient_shape(base, (668, 474, 746, 750), 22, "#FFB24A", "#E4821A", "#B8610F", 2)
    gradient_shape(base, (336, 750, 630, 782), 14, "#FFFFFF", "#D3DCE7", "#A9B7C6", 2)
    return base


def draw_calendar() -> Image.Image:
    base, d = tile("#FF7275", "#C62828", "#991A1A", "#FFB8BA")
    object_shadow(base, (286, 256, 738, 780), 36, (0, 20), 26, 90)
    gradient_shape(base, (286, 256, 738, 780), 36, "#FFFFFF", "#E8EEF7", "#C3D0DF", 3)
    gradient_shape(base, (286, 256, 738, 390), 36, "#FF8B8E", "#D32F2F", "#A51E1E", 3)
    d.rectangle((286, 350, 738, 390), fill=(211, 47, 47, 255))
    for x in (356, 462, 568, 674):
        d.rounded_rectangle((x, 220, x + 34, 326), 17, fill=(245, 248, 252, 255),
                            outline=(160, 174, 192, 255), width=3)
    d.text((342, 408), "OCT", font=ImageFont.truetype(FONT_BOLD, 56), fill=(198, 40, 40, 255))
    d.text((398, 472), "18", font=ImageFont.truetype(FONT_BOLD, 224), fill=(198, 40, 40, 255))
    d.text((372, 704), "FRIDAY", font=ImageFont.truetype(FONT_BOLD, 46), fill=(150, 32, 32, 255))
    # page curl
    d.polygon([(650, 780), (738, 700), (738, 780)], fill=(214, 225, 238, 255))
    return base


def draw_monitor() -> Image.Image:
    base, d = tile("#42D3C1", "#087F8C", "#055B66", "#A8F2E8")
    object_shadow(base, (262, 268, 762, 668), 40, (0, 20), 28, 85)
    gradient_shape(base, (262, 268, 762, 668), 40, "#46525F", "#171D25", "#0B1016", 4)
    gradient_shape(base, (306, 312, 718, 624), 24, "#123247", "#07141D", "#0A1A24", 2)
    for i in range(5):
        d.line((330 + i * 90, 330, 330 + i * 90, 606), fill=(58, 96, 120, 80), width=2)
    for i in range(4):
        d.line((330, 350 + i * 72, 694, 350 + i * 72), fill=(58, 96, 120, 80), width=2)
    points = [(344, 552), (426, 474), (500, 512), (574, 410), (676, 448)]
    glow = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    ImageDraw.Draw(glow).line(points, fill=(110, 244, 176, 180), width=30, joint="curve")
    clip_to(base, glow.filter(ImageFilter.GaussianBlur(22)), squircle_mask())
    d.line(points, fill=(146, 255, 196, 255), width=12, joint="curve")
    for point in points:
        d.ellipse((point[0] - 8, point[1] - 8, point[0] + 8, point[1] + 8), fill=WHITE)
    gradient_shape(base, (452, 668, 572, 736), 12, "#5D6B79", "#2C3743", "#1A232C", 2)
    gradient_shape(base, (364, 736, 660, 776), 20, "#66747F", "#333E48", "#202A33", 2)
    return base


def draw_browser() -> Image.Image:
    base, d = tile("#6EB7FF", "#1E5BB8", "#143F86", "#C2E1FF")
    object_shadow(base, (232, 232, 792, 792), 280, (0, 18), 24, 80)
    globe = circle_gradient(560, "#8FD1FF", "#1C55A8")
    base.alpha_composite(globe, (232, 232))
    # Globe lines must stay inside the circle.
    lines2 = Image.new("RGBA", (560, 560), (0, 0, 0, 0))
    ld2 = ImageDraw.Draw(lines2)
    for x in range(60, 500, 70):
        ld2.arc((x - 38, 60, x + 38, 484), 0, 360, fill=(255, 255, 255, 62), width=3)
    for y in range(60, 500, 70):
        ld2.arc((60, y - 38, 484, y + 38), 0, 360, fill=(255, 255, 255, 62), width=3)
    lines2.putalpha(ImageChops.multiply(lines2.getchannel("A"), circle_mask(560)))
    base.alpha_composite(lines2, (232, 232))
    d.ellipse((232, 232, 792, 792), outline=rgba("#DDE9F8"), width=10)
    d.arc((250, 250, 774, 774), 200, 330, fill=(255, 255, 255, 150), width=8)
    d.polygon([(512, 322), (570, 500), (512, 466), (454, 500)], fill=(236, 64, 72, 255))
    d.polygon([(512, 702), (454, 524), (512, 558), (570, 524)], fill=WHITE)
    d.ellipse((482, 482, 542, 542), fill=rgba("#123E7D"))
    d.ellipse((496, 496, 528, 528), fill=WHITE)
    return base


# -------------------------------------------------------------------- features


def badge(top: str, bottom: str, border: str):
    base = canvas()
    mask = squircle_mask(inset=26, n=4.4)
    drop_shadow(base, mask, (0, 12), 22, 70)
    fill = vgrad((S, S), top, bottom)
    fill.putalpha(mask)
    base.alpha_composite(fill)
    light = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    light.paste(Image.new("RGBA", (S, S), (255, 255, 255, 60)), (0, 0),
                Image.linear_gradient("L").resize((S, S)).point(lambda v: max(0, 190 - v)))
    clip_to(base, light.filter(ImageFilter.GaussianBlur(24)), mask)
    edge = mask.filter(ImageFilter.FIND_EDGES).filter(ImageFilter.GaussianBlur(2))
    rim = Image.new("RGBA", (S, S), (255, 255, 255, 0))
    rim.putalpha(edge.point(lambda v: int(v * 0.4)))
    base.alpha_composite(rim)
    return base, ImageDraw.Draw(base)


def draw_wifi() -> Image.Image:
    base, d = badge("#70BAF6", "#2373C8", "#1B5DA6")
    for radius, width in ((190, 26), (128, 26), (66, 26)):
        d.arc((512 - radius, 360 - radius, 512 + radius, 360 + radius), 210, 330,
              fill=WHITE, width=width)
    d.ellipse((482, 552, 542, 612), fill=WHITE)
    return base


def draw_bluetooth() -> Image.Image:
    base, d = badge("#6FAEF4", "#2C5FBF", "#214C99")
    d.line([(424, 368), (618, 544), (512, 642), (512, 328), (618, 426), (424, 602)],
           fill=WHITE, width=32, joint="curve")
    return base


def draw_volume() -> Image.Image:
    base, d = badge("#7FD4B0", "#238E6C", "#186E52")
    d.polygon([(346, 430), (436, 430), (558, 338), (558, 686), (436, 594), (346, 594)], fill=WHITE)
    for radius in (116, 186, 256):
        d.arc((558 - radius, 512 - radius, 558 + radius, 512 + radius), 300, 60,
              fill=WHITE, width=22)
    return base


def draw_brightness() -> Image.Image:
    base, d = badge("#FFD36E", "#E28A1E", "#B96A10")
    d.ellipse((404, 404, 620, 620), fill=WHITE)
    for angle in range(0, 360, 45):
        rad = math.radians(angle)
        d.line((512 + math.cos(rad) * 270, 512 + math.sin(rad) * 270,
                512 + math.cos(rad) * 350, 512 + math.sin(rad) * 350), fill=WHITE, width=26)
    return base


def draw_battery() -> Image.Image:
    base, d = badge("#8DDC90", "#2F8E49", "#236F38")
    d.rounded_rectangle((296, 398, 700, 626), 36, outline=WHITE, width=26)
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
    d.line([(360, 430), (664, 430)], fill=WHITE, width=28)
    d.line([(512, 540), (400, 730)], fill=WHITE, width=28)
    d.line([(512, 540), (624, 730)], fill=WHITE, width=28)
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
    W, H = 1800, 1480
    sheet = Image.new("RGBA", (W, H), rgba("#F4F6F9"))
    d = ImageDraw.Draw(sheet)
    d.text((60, 60), "PollyOS  ·  built-in app & capability showcase", font=font(48, bold=True),
           fill=rgba("#1D2834"))
    d.text((62, 126), "精简集合 · Monterey-inspired split tiles, original silhouettes · not a claim that every app is implemented",
           font=font(22, cjk=True), fill=rgba("#5E6F80"))
    d.line((60, 172, W - 60, 172), fill=rgba("#D5DEE7"), width=2)
    columns = 5
    card_w, card_h = 320, 404
    left, top = 60, 210
    for index, (slug, name, cjk, status, _) in enumerate(APPS):
        col, row = index % columns, index // columns
        x, y = left + col * (card_w + 20), top + row * (card_h + 24)
        d.rounded_rectangle((x, y, x + card_w, y + card_h), 30, fill=(255, 255, 255, 255),
                            outline=(213, 222, 232, 255), width=2)
        icon = app_icons[slug].resize((224, 224), Image.Resampling.LANCZOS)
        sheet.alpha_composite(icon, (x + (card_w - 224) // 2, y + 14))
        d.text((x + 24, y + 258), name, font=font(32, bold=True), fill=rgba("#1D2834"))
        d.text((x + 24, y + 304), cjk, font=font(25, cjk=True), fill=rgba("#5E6F80"))
        d.text((x + 24, y + 354), status, font=font(18, cjk=True), fill=rgba("#2A6FB5"))
    d.text((60, 1090), "System capabilities", font=font(36, bold=True), fill=rgba("#1D2834"))
    d.text((60, 1140), "Start / Search · Taskbar · Notifications · Quick settings · Snap & workspaces · Theme center · File dialogs · IME & clipboard",
           font=font(23, cjk=True), fill=rgba("#5E6F80"))
    fx = 60
    for slug, name, _ in FEATURES:
        icon = feature_icons[slug].resize((112, 112), Image.Resampling.LANCZOS)
        sheet.alpha_composite(icon, (fx, 1192))
        d.text((fx, 1318), name, font=font(20, bold=True), fill=rgba("#34465B"))
        fx += 210
    d.text((60, 1400), "Icons: original Pillow artwork, 1024px masters · 256/128/64 exports · no platform icons or fonts bundled",
           font=font(18), fill=rgba("#7B8898"))
    sheet.convert("RGB").save(OUT / "showcase-sheet.png", optimize=True)


def make_sections(app_icons, feature_icons):
    # Apps sheet, separated from the system-capability strip.
    W, H = 1800, 1160
    sheet = Image.new("RGBA", (W, H), rgba("#F4F6F9"))
    d = ImageDraw.Draw(sheet)
    d.text((60, 54), "PollyOS  ·  apps", font=font(48, bold=True), fill=rgba("#1D2834"))
    d.text((62, 118), "Monterey-inspired split tiles · existing capabilities and proposed additions",
           font=font(22, cjk=True), fill=rgba("#5E6F80"))
    card_w, card_h = 320, 430
    left, top = 60, 180
    for index, (slug, name, cjk, status, _) in enumerate(APPS):
        col, row = index % 5, index // 5
        x, y = left + col * (card_w + 20), top + row * (card_h + 24)
        d.rounded_rectangle((x, y, x + card_w, y + card_h), 30, fill=(255, 255, 255, 255),
                            outline=(213, 222, 232, 255), width=2)
        icon = app_icons[slug].resize((250, 250), Image.Resampling.LANCZOS)
        sheet.alpha_composite(icon, (x + (card_w - 250) // 2, y + 18))
        d.text((x + 24, y + 292), name, font=font(33, bold=True), fill=rgba("#1D2834"))
        d.text((x + 24, y + 338), cjk, font=font(25, cjk=True), fill=rgba("#5E6F80"))
        d.text((x + 24, y + 386), status, font=font(18, cjk=True), fill=rgba("#2A6FB5"))
    sheet.convert("RGB").save(OUT / "showcase-apps.png", optimize=True)

    # System capability sheet.
    W, H = 1800, 540
    sheet = Image.new("RGBA", (W, H), rgba("#F4F6F9"))
    d = ImageDraw.Draw(sheet)
    d.text((60, 54), "PollyOS  ·  system capabilities", font=font(44, bold=True), fill=rgba("#1D2834"))
    d.text((62, 118), "Start / Search · Taskbar · Notifications · Quick settings · Snap & workspaces · Theme center · File dialogs · IME & clipboard",
           font=font(21, cjk=True), fill=rgba("#5E6F80"))
    fx = 60
    for slug, name, _ in FEATURES:
        icon = feature_icons[slug].resize((150, 150), Image.Resampling.LANCZOS)
        sheet.alpha_composite(icon, (fx, 190))
        d.text((fx, 362), name, font=font(22, bold=True), fill=rgba("#34465B"))
        d.text((fx, 400), "system", font=font(17), fill=rgba("#7B8898"))
        fx += 210
    sheet.convert("RGB").save(OUT / "showcase-system.png", optimize=True)


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    app_icons, feature_icons = {}, {}
    manifest = {"schemaVersion": 1, "style": "Monterey-inspired split-tone, macOS depth",
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
    make_sections(app_icons, feature_icons)
    (OUT / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    print("Wrote", OUT)


if __name__ == "__main__":
    main()
