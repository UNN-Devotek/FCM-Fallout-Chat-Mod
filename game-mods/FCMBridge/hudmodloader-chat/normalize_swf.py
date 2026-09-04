#!/usr/bin/env python3
"""Normalize a Haxe SWF into the uncompressed FWS v32 form FO76 expects."""

from __future__ import annotations

import struct
import sys
import zlib
from pathlib import Path


def normalize(path: Path) -> None:
    data = path.read_bytes()
    if data[:3] == b"CWS":
        body = zlib.decompress(data[8:])
    elif data[:3] == b"FWS":
        body = data[8:]
    else:
        raise SystemExit(f"unsupported SWF signature in {path}: {data[:3]!r}")

    output = b"FWS" + bytes([32]) + struct.pack("<I", 8 + len(body)) + body
    path.write_bytes(output)
    print(f"normalized {path} -> FWS v32 ({len(output)} bytes)")


if __name__ == "__main__":
    if len(sys.argv) != 2:
        raise SystemExit("usage: normalize_swf.py <swf>")
    normalize(Path(sys.argv[1]))
