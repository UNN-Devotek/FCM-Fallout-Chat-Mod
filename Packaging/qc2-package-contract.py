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
VERSION = re.compile(r"\d+\.\d+\.\d+")
MAX_ENTRIES = 20_000
BRIDGE_BA2_LIMIT = 2 * 1024 * 1024
HUD_BA2_LIMIT = 20 * 1024 * 1024


def require(condition: bool, message: str) -> None:
    if not condition:
        raise ValueError(message)


def validate_members(archive: ZipFile) -> None:
    """Apply the fork importer's ZIP entry count, path, and duplicate checks."""
    members = archive.infolist()
    require(len(members) <= MAX_ENTRIES, "archive has too many entries")
    files = set()
    for member in members:
        name = member.filename
        require(bool(name) and not name.startswith(("/", "./")) and name != "."
                and "\\" not in name and ".." not in name.split("/")
                and not re.match(r"^[A-Za-z]:", name),
                f"archive contains an unsafe path: {name!r}")
        if not member.is_dir():
            require(name not in files, f"archive contains a duplicate path: {name!r}")
            files.add(name)


def read_limited(archive: ZipFile, name: str, limit: int) -> bytes:
    """Reject members the fork would refuse to read before loading their contents."""
    member = archive.getinfo(name)
    require(not member.is_dir() and member.file_size <= limit,
            f"invalid {name} size (limit {limit} bytes)")
    with archive.open(member) as source:
        data = source.read(limit + 1)
    require(len(data) <= limit, f"invalid {name} size (limit {limit} bytes)")
    return data


def bridge_package_prefixes(names: set[str]) -> set[str]:
    prefixes = set()
    for name in names:
        if name.endswith("BUILD.json"):
            prefix = name[:-len("BUILD.json")]
            if prefix + "Data/FCMServerBridge.ba2" in names:
                prefixes.add(prefix)
    return prefixes


def validate_bridge(archive: ZipFile, prefix: str = "") -> str:
    names = set(archive.namelist())
    manifest_path = prefix + "BUILD.json"
    ba2_path = prefix + "Data/FCMServerBridge.ba2"
    require({manifest_path, ba2_path} <= names, f"missing bridge manifest or BA2 at {prefix!r}")
    require(bridge_package_prefixes(names) == {prefix}, "expected exactly one bridge package")
    require(not any(name.endswith("FCMChatWidget.ba2") for name in names),
            "bridge ZIP also contains a HUD package")
    metadata = json.loads(read_limited(archive, manifest_path, 10_000))
    require(isinstance(metadata, dict), "bridge manifest must be an object")
    version = metadata.get("version", "")
    require(isinstance(version, str) and bool(VERSION.fullmatch(version)), "invalid bridge version")
    require(metadata.get("target") == "prod", "bridge must target prod")
    ba2 = read_limited(archive, ba2_path, BRIDGE_BA2_LIMIT)
    require(ba2.startswith(b"BTDX"), "invalid bridge BA2")
    require(hashlib.sha256(ba2).hexdigest() == metadata.get("ba2Sha256"),
            "bridge BA2 checksum mismatch")
    return version


def validate_hud(archive: ZipFile) -> str:
    names = set(archive.namelist())
    require("README.txt" in names, "missing HUD README")
    expected_ba2s = {provider + "/" + DATA + "/FCMChatWidget.ba2" for provider in PROVIDERS}
    require({name for name in names if name.endswith("FCMChatWidget.ba2")} == expected_ba2s,
            "expected exactly two provider HUD BA2 paths")
    require(not bridge_package_prefixes(names), "HUD ZIP also contains a bridge package")
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
        chat_lines = read_limited(archive, data + "FCMChat.ini", 100_000).decode("utf-8").splitlines()
        input_modes = [line.split("=", 1)[1].strip() for line in chat_lines
                       if "=" in line and line.split("=", 1)[0].strip().lower() == "xscalinputmode"]
        require(input_modes == ["native"],
                f"{provider} must ship exactly one xscalInputMode=native in FCMChat.ini")
        guide_lines = read_limited(archive, root + "INSTALL.txt", 200_000).decode("utf-8").splitlines()
        require(bool(guide_lines), f"{provider} install guide is empty")
        first_line = guide_lines[0]
        require("PRODUCTION" in first_line, f"{provider} must target production")
        version = next((word for word in first_line.split() if VERSION.fullmatch(word)), None)
        require(version is not None, f"{provider} install guide has no valid version")
        ba2 = read_limited(archive, data + "FCMChatWidget.ba2", HUD_BA2_LIMIT)
        require(ba2.startswith(b"BTDX") and version.encode("ascii") in ba2,
                f"{provider} BA2 is invalid or has a stale version stamp")
        loader_lines = [line.strip().casefold() for line in read_limited(
            archive, data + "hudmodloader.ini", 100_000).decode("utf-8").splitlines()]
        widget_entries = sum(line in {"fcmchatwidget", "fcmchatwidget.swf"} for line in loader_lines)
        bridge_entries = sum(line in {"fcmserverbridge", "fcmserverbridge.swf"} for line in loader_lines)
        require(widget_entries == 1 and bridge_entries == 0,
                f"{provider} loader defaults must select the widget exactly once")
        if provider.startswith("ZFE"):
            read_limited(archive, data + "ZFE/TextChat/fragments/FCMChatWidget.ini", 100_000)
        else:
            read_limited(archive, root + "xscal.ini", 10_000)
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
        validate_members(archive)
        version = {"hud": validate_hud, "bridge": validate_bridge,
                   "overlay": validate_overlay}[kind](archive)
        require(archive.testzip() is None, f"corrupt ZIP member in {path}")
        return version


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
