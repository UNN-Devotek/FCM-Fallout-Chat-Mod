#!/usr/bin/env python3
"""Fixture checks for the production ZIP contract gate."""

import hashlib
import importlib.util
import json
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest
import warnings
from zipfile import ZipFile


SPEC = importlib.util.spec_from_file_location(
    "qc2_package_contract", Path(__file__).with_name("qc2-package-contract.py")
)
assert SPEC and SPEC.loader
contract = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(contract)


def bridge_entries(prefix="", ba2=b"BTDX bridge"):
    manifest = {"version": "0.2.9", "target": "prod",
                "ba2Sha256": hashlib.sha256(ba2).hexdigest()}
    return {prefix + "BUILD.json": json.dumps(manifest).encode(),
            prefix + "Data/FCMServerBridge.ba2": ba2}


def hud_entries():
    entries = {"README.txt": b"HUD guide"}
    for provider in contract.PROVIDERS:
        root = provider + "/"
        data = root + contract.DATA + "/"
        entries.update({root + "INSTALL.txt": b"Fallout Chat Mod HUD 2.10.134 (PRODUCTION)",
                        root + "Fallout76Custom.ini": b"[Archive]\n",
                        data + "FCMChatWidget.ba2": b"BTDX 2.10.134",
                        data + "FCMChat.ini": b"[FCMChat]\nxscalInputMode=native\n",
                        data + "hudmodloader.ini": b"FCMChatWidget\n"})
        if provider.startswith("ZFE"):
            entries[data + "ZFE/TextChat/fragments/FCMChatWidget.ini"] = b"[TextChat]\n"
        else:
            entries[root + "xscal.ini"] = b"[Chat]\n"
    return entries


class ContractTests(unittest.TestCase):
    def check(self, entries, kind):
        with TemporaryDirectory() as directory:
            path = Path(directory) / "release.zip"
            with warnings.catch_warnings():
                warnings.simplefilter("ignore", UserWarning)
                with ZipFile(path, "w") as archive:
                    for name, value in (entries.items() if isinstance(entries, dict) else entries):
                        archive.writestr(name, value)
            return contract.validate(path, kind)

    def test_supported_production_shapes(self):
        self.assertEqual(self.check(hud_entries(), "hud"), "2.10.134")
        self.assertEqual(self.check(bridge_entries(), "bridge"), "0.2.9")
        self.assertEqual(self.check(bridge_entries("Outer/Optional FCM Bridge/"), "overlay"), "0.2.9")

    def test_missing_provider_and_stale_hud_stamp_fail(self):
        entries = hud_entries()
        del entries["xScal (Install for xScal only)/xscal.ini"]
        with self.assertRaisesRegex(ValueError, "incomplete HUD"):
            self.check(entries, "hud")
        entries = hud_entries()
        entries["ZFE (Install for ZFE only)/" + contract.DATA + "/FCMChatWidget.ba2"] = b"BTDX old"
        with self.assertRaisesRegex(ValueError, "stale version"):
            self.check(entries, "hud")
        entries = hud_entries()
        entries["ZFE (Install for ZFE only)/" + contract.DATA + "/hudmodloader.ini"] = b"FCMChatWidget\nFCMChatWidget\n"
        with self.assertRaisesRegex(ValueError, "exactly once"):
            self.check(entries, "hud")
        entries = hud_entries()
        entries["ZFE (Install for ZFE only)/" + contract.DATA + "/hudmodloader.ini"] = b"FCMChatWidget.swf\nFCMChatWidget\n"
        with self.assertRaisesRegex(ValueError, "exactly once"):
            self.check(entries, "hud")
        entries = hud_entries()
        entries["ZFE (Install for ZFE only)/" + contract.DATA + "/hudmodloader.ini"] = b"FCMServerBridge.swf\nFCMChatWidget\n"
        with self.assertRaisesRegex(ValueError, "exactly once"):
            self.check(entries, "hud")
        entries = hud_entries()
        entries["ZFE (Install for ZFE only)/INSTALL.txt"] = b"Fallout Chat Mod HUD 2.10.134.5 (PRODUCTION)"
        with self.assertRaisesRegex(ValueError, "no valid version"):
            self.check(entries, "hud")

    def test_all_hud_provider_configs_require_native_xscal_input(self):
        for provider in contract.PROVIDERS:
            path = provider + "/" + contract.DATA + "/FCMChat.ini"
            for invalid in (b"[FCMChat]\nxscalInputMode=shared\n",
                            b"[FCMChat]\n",
                            b"[FCMChat]\nxscalInputMode=native\nxscalInputMode=shared\n",
                            b"[FCMChat]\nxscalInputMode=native\n xscalInputMode = shared\n"):
                entries = hud_entries()
                entries[path] = invalid
                with self.assertRaisesRegex(ValueError, "xscalInputMode=native"):
                    self.check(entries, "hud")

    def test_bridge_hash_and_production_are_required(self):
        entries = bridge_entries()
        entries["Data/FCMServerBridge.ba2"] = b"BTDX changed"
        with self.assertRaisesRegex(ValueError, "checksum mismatch"):
            self.check(entries, "bridge")
        entries = bridge_entries()
        metadata = json.loads(entries["BUILD.json"])
        metadata["target"] = "dev"
        entries["BUILD.json"] = json.dumps(metadata).encode()
        with self.assertRaisesRegex(ValueError, "target prod"):
            self.check(entries, "bridge")

    def test_overlay_requires_bridge(self):
        with self.assertRaisesRegex(ValueError, "embedded Optional FCM Bridge"):
            self.check({"INSTALL-LINUX.txt": b"guide"}, "overlay")
        entries = bridge_entries("Optional FCM Bridge/")
        entries.update(bridge_entries("Other Bridge/"))
        with self.assertRaisesRegex(ValueError, "exactly one bridge package"):
            self.check(entries, "overlay")
        entries = hud_entries()
        entries["extras/FCMChatWidget.ba2"] = b"BTDX 2.10.134"
        with self.assertRaisesRegex(ValueError, "exactly two provider HUD BA2"):
            self.check(entries, "hud")

    def test_importer_rejects_duplicate_unsafe_and_oversized_members(self):
        entries = list(bridge_entries().items())
        with self.assertRaisesRegex(ValueError, "duplicate path"):
            self.check(entries + [("BUILD.json", entries[0][1])], "bridge")
        for unsafe in ("../note.txt", "/absolute.txt", "folder\\note.txt", "C:/note.txt"):
            with self.subTest(unsafe=unsafe), self.assertRaisesRegex(ValueError, "unsafe path"):
                self.check(entries + [(unsafe, b"note")], "bridge")
        with self.assertRaisesRegex(ValueError, "too many entries"):
            self.check(entries + [(f"extra/{index}", b"") for index in range(contract.MAX_ENTRIES)], "bridge")
        with self.assertRaisesRegex(ValueError, "FCMServerBridge.ba2 size"):
            self.check(bridge_entries(ba2=b"BTDX" + b"x" * (contract.BRIDGE_BA2_LIMIT - 3)), "bridge")
        oversized_manifest = bridge_entries()
        oversized_manifest["BUILD.json"] = oversized_manifest["BUILD.json"] + b" " * 10_000
        with self.assertRaisesRegex(ValueError, "BUILD.json size"):
            self.check(oversized_manifest, "bridge")
        oversized_hud = hud_entries()
        oversized_hud[contract.PROVIDERS[0] + "/" + contract.DATA + "/FCMChat.ini"] += b";" * 100_000
        with self.assertRaisesRegex(ValueError, "FCMChat.ini size"):
            self.check(oversized_hud, "hud")
        oversized_hud = hud_entries()
        oversized_hud[contract.PROVIDERS[0] + "/" + contract.DATA + "/FCMChatWidget.ba2"] = (
            b"BTDX 2.10.134" + b"x" * contract.HUD_BA2_LIMIT
        )
        with self.assertRaisesRegex(ValueError, "FCMChatWidget.ba2 size"):
            self.check(oversized_hud, "hud")


if __name__ == "__main__":
    unittest.main()
