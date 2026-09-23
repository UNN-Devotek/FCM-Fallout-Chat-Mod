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
VERSION = "0.2.8"


def module(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    loaded = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(loaded)
    return loaded


ba2 = module("bridge_ba2", ROOT.parent / "hudmenu-chat/ba2tool.py")
swf_validator = module("bridge_swf", ROOT.parent / "tools/validate_swf.py")


def validate_pair(swf: Path, archive: Path, native_prototype: bool = False) -> dict:
    info = swf_validator.parse_swf(swf)
    if info["signature"] != "FWS" or info["version"] != 32:
        raise ValueError("Expected normalized FWS v32")
    raw, version, kind, records, names = ba2._read(archive)
    if (version, kind, len(records)) != (1, b"GNRL", 1) or names != [ENTRY]:
        raise ValueError("Expected a single child movie in a BTDX v1 GNRL archive")
    if ba2._raw_blob(raw, records[0]) != swf.read_bytes():
        raise ValueError("Archive SWF differs from compiled SWF")
    payload = swf.read_bytes()
    forbidden_symbols = [b"FCMChatWidget", b"flash.text.TextField", b"TextEdit", b"URLLoader", b"Socket",
                      b"SharedHUDTools", b"HUDMod::UserEvent", b"ShowMenu", b"CloseMenu",
                      b"BridgeRosterScenario", b"BRIDGE-ROSTER", b"PackagedBridgeHost", b"IsolatedProvider",
                      b"LINK REQUIRED", b"FCMBRIDGE/1;", b"JsonParser"]
    if not native_prototype:
        forbidden_symbols += [b"chat.v1.", b"chatInterface", b"NATIVE-PROTOTYPE"]
    for forbidden in forbidden_symbols:
        if forbidden in payload:
            raise ValueError(f"Background build unexpectedly contains {forbidden!r}")
    return info


def build(target: str, output: Path, diagnostic: bool = False, native_prototype: bool = False) -> dict:
    if native_prototype and (target != "dev" or diagnostic):
        raise ValueError("Native prototype requires dev and cannot use storage performance labels")
    host = "dev.falloutchatmod.com" if target == "dev" else "falloutchatmod.com"
    output = output.resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    with TemporaryDirectory(prefix="fcm-server-bridge-") as temp:
        temp = Path(temp)
        swf, archive = temp / "FCMServerBridge.swf", temp / "FCMServerBridge.ba2"
        command = ["haxe", *shlex.split((ROOT / "build.hxml").read_text(), comments=True)]
        command[command.index("--swf") + 1] = str(swf)
        if target == "dev": command += ["-D", "bridge_dev"]
        if diagnostic: command += ["-D", "bridge_perf"]
        if native_prototype: command += ["-D", "bridge_native_prototype"]
        subprocess.run(command, cwd=ROOT, check=True)
        raw = swf.read_bytes()
        if raw[:3] != b"CWS": raise ValueError("Unexpected compiler SWF format")
        body = zlib.decompress(raw[8:])
        swf.write_bytes(b"FWS\x20" + struct.pack("<I", len(body) + 8) + body)
        ba2.create(archive, [f"{ENTRY}={swf}"])
        info = validate_pair(swf, archive, native_prototype)
        manifest = {"version": VERSION, "target": target, "entry": ENTRY, "swf": info,
                    "swfSha256": hashlib.sha256(swf.read_bytes()).hexdigest(),
                    "ba2Sha256": hashlib.sha256(archive.read_bytes()).hexdigest()}
        if diagnostic: manifest["diagnostic"] = True
        if native_prototype: manifest["nativePrototype"] = True
        with ZipFile(output, "w", ZIP_DEFLATED) as package:
            package.write(archive, "Data/FCMServerBridge.ba2")
            package.writestr("FCMServerBridge.hudmodloader.ini", "FCMServerBridge\n")
            package.writestr("Fallout76Custom.ini.example", "[Archive]\nsResourceArchive2List=HUDModLoader.ba2,FCMServerBridge.ba2\n")
            export_config = {"schemaVersion": 1, "environment": target,
                "zfe": f"Data/ZFE/Storage/FCMServerBridge/{target}-state.json",
                "xscal": f"Data/modsdata/fcmserverbridge-{target}.json"}
            if native_prototype:
                export_config = {"schemaVersion": "native-prototype-1", "environment": "dev",
                    "xscal": "Data/modsdata/fcmserverbridge-dev.json"}
            package.writestr("EXPORT.json", json.dumps(export_config, indent=2) + "\n")
            package.writestr("BUILD.json", json.dumps(manifest, indent=2) + "\n")
            instructions_text = instructions(host, target)
            if native_prototype:
                instructions_text = (ROOT / "NATIVE-PROTOTYPE-INSTALL.txt").read_text(encoding="utf-8")
            if diagnostic:
                instructions_text = ("DIAGNOSTIC TEST BUILD - NOT FOR RELEASE\n"
                    "The c5 candidate coalesces unchanged xScal roster exports to about five seconds.\n"
                    "The export build field contains last/peak poll, encode, and save times in milliseconds.\n"
                    "The save time appears in the next export. No extra storage file is written.\n\n"
                    "For a fair comparison, play once with neither FCM HUD nor Server Bridge loaded\n"
                    "and once with only this bridge. Keep xScal, Improved HUD, world, and settings the same.\n"
                    "After a spike, read only the build field from Data/modsdata/fcmserverbridge-"
                    + target + ".json. Do not share the full export; it contains roster names.\n\n"
                    + instructions_text)
            package.writestr("INSTALL.txt", instructions_text)
        print(f"Built {output} ({output.stat().st_size} bytes)")
        return manifest


def instructions(host: str, target: str) -> str:
    return (ROOT / "INSTALL.template.txt").read_text(encoding="utf-8").format(
        version=VERSION, target=target.upper(), target_lower=target, host=host,
    )


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--target", choices=("dev", "prod"), required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--diagnostic", action="store_true", help="test-only timing build; never publish")
    parser.add_argument("--native-prototype", action="store_true", help="local dev native transport experiment")
    args = parser.parse_args()
    print(json.dumps(build(args.target, args.output, args.diagnostic, args.native_prototype), indent=2))
