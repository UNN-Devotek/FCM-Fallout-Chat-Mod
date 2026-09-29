#!/usr/bin/env python3
"""Validate production FCM ZIPs consumed by the UNN-Devotek QC2 importer.

Keep this in sync with QuickConfiguration2/src-tauri/src/commands/fcm/import.rs.
This checks package compatibility, not whether a native game install works.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
from pathlib import Path
from zipfile import BadZipFile, ZipFile

PROVIDERS = ("ZFE (Install for ZFE only)", "xScal (Install for xScal only)")
DATA = "Data (drag the contents into data folder)"
VERSION = re.compile(r"(?<!\d)\d{1,3}\.\d{1,3}\.\d{1,3}(?!\d)")


def require(condition: bool, message: str) -> None:
    if not condition:
        raise ValueError(message)


def validate_bridge(archive: ZipFile, prefix: str = "") -> str:
    names = set(archive.namelist())
    manifest_path = prefix + "BUILD.json"
    ba2_path = prefix + "Data/FCMServerBridge.ba2"
    require({manifest_path, ba2_path} <= names, f"missing bridge manifest or BA2 at {prefix!r}")
    metadata = json.loads(archive.read(manifest_path))
    require(isinstance(metadata, dict), "bridge manifest must be an object")
    version = metadata.get("version", "")
    require(isinstance(version, str) and bool(VERSION.fullmatch(version)), "invalid bridge version")
    require(metadata.get("target") == "prod", "bridge must target prod")
    ba2 = archive.read(ba2_path)
    require(ba2.startswith(b"BTDX"), "invalid bridge BA2")
    require(hashlib.sha256(ba2).hexdigest() == metadata.get("ba2Sha256"),
            "bridge BA2 checksum mismatch")
    return version


def validate_hud(archive: ZipFile) -> str:
    names = set(archive.namelist())
    require("README.txt" in names, "missing HUD README")
    versions = set()
    ba2_hashes = set()
    for provider in PROVIDERS:
        root = provider + "/"
        data = root + DATA + "/"
        paths = {root + "INSTALL.txt", root + "Fallout76Custom.ini",
                 data + "FCMChatWidget.ba2", data + "FCMChat.ini", data + "hudmodloader.ini"}
        if provider.startswith("ZFE"):
            paths.add(data + "ZFE/TextChat/fragments/FCMChatWidget.ini")
        else:
            paths.add(root + "xscal.ini")
        require(paths <= names, f"incomplete HUD provider folder {provider}: {sorted(paths - names)}")
        chat_lines = archive.read(data + "FCMChat.ini").decode("utf-8").splitlines()
        input_modes = [line.split("=", 1)[1].strip() for line in chat_lines
                       if "=" in line and line.split("=", 1)[0].strip().lower() == "xscalinputmode"]
        require(input_modes == ["native"],
                f"{provider} must ship exactly one xscalInputMode=native in FCMChat.ini")
        guide_lines = archive.read(root + "INSTALL.txt").decode("utf-8").splitlines()
        require(bool(guide_lines), f"{provider} install guide is empty")
        first_line = guide_lines[0]
        require("PRODUCTION" in first_line, f"{provider} must target production")
        match = VERSION.search(first_line)
        require(match is not None, f"{provider} install guide has no version")
        version = match.group()
        ba2 = archive.read(data + "FCMChatWidget.ba2")
        require(ba2.startswith(b"BTDX") and version.encode("ascii") in ba2,
                f"{provider} BA2 is invalid or has a stale version stamp")
        loader_lines = [line.strip() for line in archive.read(data + "hudmodloader.ini").decode("utf-8").splitlines()]
        require(loader_lines.count("FCMChatWidget") == 1 and "FCMServerBridge" not in loader_lines,
                f"{provider} loader defaults must select the widget exactly once")
        versions.add(version)
        ba2_hashes.add(hashlib.sha256(ba2).hexdigest())
    require(len(versions) == len(ba2_hashes) == 1,
            "HUD provider folders disagree on version or BA2")
    return versions.pop()


def validate_overlay(archive: ZipFile) -> str:
    prefixes = {name[:-len("BUILD.json")] for name in archive.namelist()
                if name.endswith("Optional FCM Bridge/BUILD.json")}
    require(len(prefixes) == 1, "expected one embedded Optional FCM Bridge/BUILD.json")
    return validate_bridge(archive, prefixes.pop())


def validate(path: Path, kind: str) -> str:
    with ZipFile(path) as archive:
        require(archive.testzip() is None, f"corrupt ZIP member in {path}")
        return {"hud": validate_hud, "bridge": validate_bridge,
                "overlay": validate_overlay}[kind](archive)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--hud", type=Path, action="append", default=[])
    parser.add_argument("--bridge", type=Path, action="append", default=[])
    parser.add_argument("--overlay", type=Path, action="append", default=[])
    args = parser.parse_args()
    try:
        require(bool(args.hud or args.bridge or args.overlay), "no ZIPs supplied")
        for kind in ("hud", "bridge", "overlay"):
            for path in getattr(args, kind):
                print(f"{kind}: {path}: {validate(path, kind)}")
    except (OSError, BadZipFile, ValueError, KeyError, UnicodeDecodeError) as error:
        print(f"QC2 package contract failed: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
