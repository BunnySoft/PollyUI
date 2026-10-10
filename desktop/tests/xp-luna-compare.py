import argparse
import hashlib
import json
from pathlib import Path

from PIL import Image


def metrics(actual, reference):
    if actual.size != reference.size:
        raise ValueError(f"Unscaled crop sizes differ: {actual.size} versus {reference.size}")
    pairs = list(zip(actual.convert("RGB").getdata(), reference.convert("RGB").getdata()))
    differences = [abs(a - b) for left, right in pairs for a, b in zip(left, right)]
    return {
        "size": list(actual.size),
        "meanAbsoluteChannelError": round(sum(differences) / len(differences), 4),
        "maxAbsoluteChannelError": max(differences),
        "changedPixels": sum(left != right for left, right in pairs),
        "totalPixels": len(pairs),
    }


parser = argparse.ArgumentParser(description="Unscaled Luna crop comparison; no acceptance threshold or masking")
parser.add_argument("--reference", type=Path, required=True)
parser.add_argument("--paint-strip", type=Path)
parser.add_argument("--actual", type=Path)
parser.add_argument("--reference-box", type=int, nargs=4, metavar=("X", "Y", "W", "H"))
parser.add_argument("--actual-box", type=int, nargs=4, metavar=("X", "Y", "W", "H"))
parser.add_argument("--output", type=Path)
args = parser.parse_args()
if bool(args.paint_strip) == bool(args.actual):
    parser.error("Choose exactly one of --paint-strip and --actual")

reference = Image.open(args.reference).convert("RGB")
result = {"referenceSha256": hashlib.sha256(args.reference.read_bytes()).hexdigest()}
if args.paint_strip:
    manifest = json.loads((Path(__file__).parent.parent / "resources" / "themes" / "xp-reference.json").read_text())
    source = next(item for item in manifest["references"] if item["id"] == "notepad")
    if result["referenceSha256"] != source["sha256"]:
        raise ValueError("The reference does not match the recorded analysis-only Notepad screenshot")
    strip = Image.open(args.paint_strip).convert("RGB")
    if strip.size != (2, 30):
        raise ValueError(f"Unexpected painter evidence shape: {strip.size}")
    target = reference.crop((300, 0, 301, 30))
    result["scope"] = "Native title painter strip only, NOT captured desktop acceptance"
    result["before"] = metrics(strip.crop((0, 0, 1, 30)), target)
    result["after"] = metrics(strip.crop((1, 0, 2, 30)), target)
    result["exclusions"] = "Fixed x=300 strip excludes text and icons by crop selection; no masked pixels"
    if args.output:
        for name, column in (("before", 0), ("after", 1)):
            strip.crop((column, 0, column + 1, 30)).save(args.output.with_name(args.output.stem + f"-{name}.png"))
else:
    if not args.reference_box or not args.actual_box:
        parser.error("Native screenshot comparisons require both explicit unscaled crop boxes")
    actual = Image.open(args.actual).convert("RGB")
    def crop(image, box):
        x, y, width, height = box
        if width < 1 or height < 1 or x < 0 or y < 0 or x + width > image.width or y + height > image.height:
            raise ValueError(f"Out-of-bounds crop: {box} in {image.size}")
        return image.crop((x, y, x + width, y + height))
    result["scope"] = "Unscaled screenshot component crop, all pixels included"
    result["difference"] = metrics(crop(actual, args.actual_box), crop(reference, args.reference_box))
    result["actualSha256"] = hashlib.sha256(args.actual.read_bytes()).hexdigest()
    result["referenceBox"] = args.reference_box
    result["actualBox"] = args.actual_box
    result["exclusions"] = "None; includes text, icons and antialiasing"
encoded = json.dumps(result, indent=2) + "\n"
if args.output:
    args.output.write_text(encoded, encoding="utf-8")
print(encoded, end="")
