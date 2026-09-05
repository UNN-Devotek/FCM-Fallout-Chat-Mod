#!/usr/bin/env python3
"""Validate the structural parts of a Scaleform-compatible SWF artifact.

This is intentionally a small, dependency-free gate for generated artifacts. It verifies the
signature/version/file length, frame header, tag boundaries, and the required End tag. It does not
decompile ABC bytecode; ffdec remains the optional inspection tool for that layer.
"""

from __future__ import annotations

import argparse
import json
import struct
import sys
import zlib
from pathlib import Path


class SwfError(ValueError):
    pass


class BitReader:
    def __init__(self, data: bytes) -> None:
        self.data = data
        self.bit_offset = 0

    def read(self, count: int) -> int:
        if count < 0 or self.bit_offset + count > len(self.data) * 8:
            raise SwfError("truncated SWF bit field")
        value = 0
        for _ in range(count):
            byte = self.data[self.bit_offset // 8]
            bit = 7 - (self.bit_offset % 8)
            value = (value << 1) | ((byte >> bit) & 1)
            self.bit_offset += 1
        return value

    def align(self) -> None:
        self.bit_offset = (self.bit_offset + 7) & ~7


def signed(value: int, bits: int) -> int:
    sign = 1 << (bits - 1)
    return value - (1 << bits) if value & sign else value


def parse_swf(path: Path) -> dict[str, int | str | bool]:
    data = path.read_bytes()
    if len(data) < 12:
        raise SwfError("SWF is shorter than its header")
    signature = data[:3].decode("ascii", errors="replace")
    if signature not in {"FWS", "CWS"}:
        raise SwfError(f"unsupported signature {signature!r}; expected FWS or CWS")
    version = data[3]
    declared_length = struct.unpack_from("<I", data, 4)[0]
    if signature == "CWS":
        try:
            body = zlib.decompress(data[8:])
        except zlib.error as exc:
            raise SwfError(f"CWS body failed to decompress: {exc}") from exc
    else:
        body = data[8:]
    uncompressed_length = 8 + len(body)
    if declared_length != uncompressed_length:
        raise SwfError(
            f"declared file length {declared_length} != uncompressed length {uncompressed_length}"
        )
    if signature == "FWS" and declared_length != len(data):
        raise SwfError(f"FWS declared length {declared_length} != actual length {len(data)}")

    rect_reader = BitReader(body)
    nbits = rect_reader.read(5)
    if nbits < 1 or nbits > 31:
        raise SwfError(f"invalid frame RECT bit width {nbits}")
    rect = [signed(rect_reader.read(nbits), nbits) for _ in range(4)]
    rect_reader.align()
    header_bytes = rect_reader.bit_offset // 8
    if header_bytes + 4 > len(body):
        raise SwfError("truncated SWF frame header")
    frame_rate_raw, frame_count = struct.unpack_from("<HH", body, header_bytes)
    frame_rate = frame_rate_raw / 256.0
    offset = header_bytes + 4
    tag_count = 0
    end_seen = False
    max_tag_code = 0
    while offset + 2 <= len(body):
        tag_header = struct.unpack_from("<H", body, offset)[0]
        offset += 2
        tag_code = tag_header >> 6
        tag_length = tag_header & 0x3F
        if tag_length == 0x3F:
            if offset + 4 > len(body):
                raise SwfError("truncated long SWF tag length")
            tag_length = struct.unpack_from("<I", body, offset)[0]
            offset += 4
        if offset + tag_length > len(body):
            raise SwfError(
                f"tag {tag_code} payload overruns SWF body at offset {offset}"
            )
        tag_count += 1
        max_tag_code = max(max_tag_code, tag_code)
        offset += tag_length
        if tag_code == 0:
            end_seen = True
            break
    if not end_seen:
        raise SwfError("SWF has no End tag")

    return {
        "signature": signature,
        "version": version,
        "declaredLength": declared_length,
        "actualLength": len(data),
        "uncompressedLength": uncompressed_length,
        "frameWidthTwips": rect[1] - rect[0],
        "frameHeightTwips": rect[3] - rect[2],
        "frameRate": frame_rate,
        "frameCount": frame_count,
        "tagCount": tag_count,
        "maxTagCode": max_tag_code,
        "endTag": True,
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("swf", type=Path)
    parser.add_argument("--require-signature", choices=("FWS", "CWS"))
    parser.add_argument("--require-version", type=int)
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()
    try:
        result = parse_swf(args.swf)
        if args.require_signature and result["signature"] != args.require_signature:
            raise SwfError(
                f"signature {result['signature']} != required {args.require_signature}"
            )
        if args.require_version is not None and result["version"] != args.require_version:
            raise SwfError(
                f"version {result['version']} != required {args.require_version}"
            )
    except (OSError, SwfError) as exc:
        print(f"ERROR: {args.swf}: {exc}", file=sys.stderr)
        return 1
    if args.json:
        print(json.dumps(result, sort_keys=True))
    else:
        print(
            f"PASS: {args.swf} {result['signature']} v{result['version']} "
            f"frames={result['frameCount']} tags={result['tagCount']} endTag=yes"
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
