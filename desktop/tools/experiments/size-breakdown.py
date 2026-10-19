#!/usr/bin/env python3
"""Summarize Polly Live manifest package sizes.

Usage: size-breakdown.py path/to/live-manifest.json
"""
import json
import re
import sys

if len(sys.argv) != 2:
    raise SystemExit("usage: size-breakdown.py live-manifest.json")

items = json.load(open(sys.argv[1]))["sizeReport"]["packages"]
print("packages", len(items))
print("installed total MiB", round(sum(i["installedSizeBytes"] for i in items) / 2**20, 1))
print("regular total MiB", round(sum(i["regularFileBytes"] for i in items) / 2**20, 1))

patterns = {
    "mesa/llvm/gallium/vulkan/gl": r"mesa|llvm|gallium|vulkan|libgl|libegl|libgles|gbm|dri|z3",
    "noto": r"^fonts-noto|noto",
    "fonts (all)": r"^fonts-|fontconfig",
    "kernel/modules": r"^linux-|^kmod|^libkmod|^firmware",
    "python": r"^python|^libpython",
}
for label, pattern in patterns.items():
    subset = [i for i in items if re.search(pattern, i["name"])]
    print(label, "count", len(subset), "MiB",
          round(sum(i["installedSizeBytes"] for i in subset) / 2**20, 1))

print("\nTop 30 by installed size:")
for item in sorted(items, key=lambda row: -row["installedSizeBytes"])[:30]:
    print(f'{item["installedSizeBytes"] / 2**20:8.1f} MiB  {item["name"]:45s} {item["version"]}')
