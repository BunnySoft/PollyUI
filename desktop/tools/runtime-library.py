#!/usr/bin/env python3
"""Resolve a JS dlopen SONAME through the SDK loader, not a guessed package name."""
import ctypes
from pathlib import Path
import sys


class DlInfo(ctypes.Structure):
    _fields_ = [("filename", ctypes.c_char_p), ("base", ctypes.c_void_p),
                ("symbol", ctypes.c_char_p), ("address", ctypes.c_void_p)]


if len(sys.argv) != 3:
    raise ValueError("Usage: runtime-library.py SONAME REQUIRED_SYMBOL")
library = ctypes.CDLL(sys.argv[1])
symbol = ctypes.cast(getattr(library, sys.argv[2]), ctypes.c_void_p)
loader = ctypes.CDLL(None)
loader.dladdr.argtypes = [ctypes.c_void_p, ctypes.POINTER(DlInfo)]
loader.dladdr.restype = ctypes.c_int
info = DlInfo()
if loader.dladdr(symbol, ctypes.byref(info)) != 1 or not info.filename:
    raise RuntimeError("Cannot resolve the loaded runtime symbol: " + sys.argv[2])
filename = Path(info.filename.decode()).resolve(strict=True)
if not filename.is_file():
    raise RuntimeError("Runtime loader did not resolve a regular library: " + str(filename))
print(filename)
