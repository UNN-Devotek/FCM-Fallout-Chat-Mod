#!/usr/bin/env python3
"""Compile and validate the invisible bridge; package an explicit dev/prod target."""
from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import shlex
from pathlib import Path
import struct
import subprocess
from tempfile import TemporaryDirectory
from zipfile import ZipFile, ZIP_DEFLATED
import zlib

ROOT = Path(__file__).resolve().parent
ENTRY = "Interface/FCMServerBridge.swf"
VERSION = "0.1.0"


def module(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    loaded = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(loaded)
    return loaded


ba2 = module("bridge_ba2", ROOT.parent / "hudmenu-chat/ba2tool.py")
swf_validator = module("bridge_swf", ROOT.parent / "tools/validate_swf.py")


def validate_pair(swf: Path, archive: Path) -> dict:
    info = swf_validator.parse_swf(swf)
    if info["signature"] != "FWS" or info["version"] != 32:
        raise ValueError("Expected normalized FWS v32")
    raw, version, kind, records, names = ba2._read(archive)
    if (version, kind, len(records)) != (1, b"GNRL", 1) or names != [ENTRY]:
        raise ValueError("Expected a single child movie in a BTDX v1 GNRL archive")
    if ba2._raw_blob(raw, records[0]) != swf.read_bytes():
        raise ValueError("Archive SWF differs from compiled SWF")
    payload = swf.read_bytes()
    for forbidden in [b"FCMChatWidget", b"flash.text.TextField", b"TextEdit", b"URLLoader", b"Socket"]:
        if forbidden in payload:
            raise ValueError(f"Background build unexpectedly contains {forbidden!r}")
    return info


def build(target: str, output: Path) -> dict:
    host = "dev.falloutchatmod.com" if target == "dev" else "falloutchatmod.com"
    output = output.resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    with TemporaryDirectory(prefix="fcm-server-bridge-") as temp:
        temp = Path(temp)
        swf, archive = temp / "FCMServerBridge.swf", temp / "FCMServerBridge.ba2"
        command = ["haxe", *shlex.split((ROOT / "build.hxml").read_text(), comments=True)]
        command[command.index("--swf") + 1] = str(swf)
        if target == "dev": command += ["-D", "bridge_dev"]
        subprocess.run(command, cwd=ROOT, check=True)
        raw = swf.read_bytes()
        if raw[:3] != b"CWS": raise ValueError("Unexpected compiler SWF format")
        body = zlib.decompress(raw[8:])
        swf.write_bytes(b"FWS\x20" + struct.pack("<I", len(body) + 8) + body)
        ba2.create(archive, [f"{ENTRY}={swf}"])
        info = validate_pair(swf, archive)
        manifest = {"version": VERSION, "target": target, "entry": ENTRY, "swf": info,
                    "swfSha256": hashlib.sha256(swf.read_bytes()).hexdigest(),
                    "ba2Sha256": hashlib.sha256(archive.read_bytes()).hexdigest()}
        with ZipFile(output, "w", ZIP_DEFLATED) as package:
            package.write(archive, "Data/FCMServerBridge.ba2")
            package.writestr("FCMServerBridge.hudmodloader.ini", "FCMServerBridge\n")
            package.writestr("Fallout76Custom.ini.example", "[Archive]\nsResourceArchive2List=HUDModLoader.ba2,FCMServerBridge.ba2\n")
            package.writestr("examples/ZFE/FCMServerBridge.ini.example", f"[TextChat]\nEndpoint=wss://{host}/relay\nDefaultChannel=server\nAllowedChannels=server\nAutoConnect=false\n")
            package.writestr("examples/xScal/xscal.ini.example", f"[Chat]\nenabled=true\nrelayEndpoint=wss://{host}/relay\n")
            package.writestr("BUILD.json", json.dumps(manifest, indent=2) + "\n")
            package.writestr("INSTALL.txt", instructions(host, target))
        print(f"Built {output} ({output.stat().st_size} bytes)")
        return manifest


def instructions(host: str, target: str) -> str:
    return (ROOT / "INSTALL.template.txt").read_text(encoding="utf-8").format(
        version=VERSION, target=target.upper(), host=host,
    )


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--target", choices=("dev", "prod"), required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    print(json.dumps(build(args.target, args.output), indent=2))
