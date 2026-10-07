#!/usr/bin/env python3
"""Reject stale sources, replaced binaries, missing manifests, and wrong BA2 payloads."""
import importlib.util
import tempfile
import unittest
from unittest.mock import patch
import package
from pathlib import Path
import artifact_freshness as freshness

spec = importlib.util.spec_from_file_location('ba2tool', freshness.ROOT.parent / 'hudmenu-chat/ba2tool.py')
ba2 = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ba2)


class ArtifactFreshnessTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name) / 'widget'
        (self.root / 'emoji').mkdir(parents=True)
        for name in ('FCMChatWidget.hx', 'build.hxml', 'normalize_swf.py',
                     'emoji/embed_sprites.py', 'emoji/sprites.json',
                     'emoji/sprites.tags', 'emoji/asset-hashes.json'):
            (self.root / name).write_bytes(b'fixture\n')
        (self.root.parent / 'FcmNativeApi.hx').write_bytes(b'native\n')
        (self.root / 'FCMChatWidget.swf').write_bytes(b'fixture swf')
        self.repack()
        freshness.stamp(self.root)

    def repack(self):
        ba2.create(self.root / 'FCMChatWidget.ba2', [f'interface/FCMChatWidget.swf={self.root / "FCMChatWidget.swf"}'])

    def test_unchanged_and_crlf_checkout_pass(self):
        freshness.validate(self.root)
        (self.root / 'FCMChatWidget.hx').write_bytes(b'fixture\r\n')
        freshness.validate(self.root)

    def test_source_changes_fail_without_version_change(self):
        for name in ('FCMChatWidget.hx', 'FcmNewLogic.hx', '../FcmNativeApi.hx', 'emoji/sprites.tags'):
            with self.subTest(name=name):
                path = self.root / name
                original = path.read_bytes() if path.exists() else None
                path.write_bytes(b'new logic\n')
                with self.assertRaisesRegex(ValueError, 'sources or artifacts changed'):
                    freshness.validate(self.root)
                if original is None:
                    path.unlink()
                else:
                    path.write_bytes(original)

    def test_packaging_rejects_stale_source_before_writing_zip(self):
        (self.root / 'FCMChatWidget.hx').write_bytes(b'changed without a version bump')
        output = self.root / 'candidate.zip'
        with patch.object(package, 'ROOT', self.root):
            with self.assertRaisesRegex(ValueError, 'sources or artifacts changed'):
                package.build_package('dev', output)
        self.assertFalse(output.exists())

    def test_missing_manifest_fails(self):
        (self.root / freshness.MANIFEST).unlink()
        with self.assertRaisesRegex(ValueError, 'Missing or invalid'):
            freshness.validate(self.root)

    def test_replaced_matching_artifacts_fail(self):
        (self.root / 'FCMChatWidget.swf').write_bytes(b'replaced binary')
        self.repack()
        with self.assertRaisesRegex(ValueError, 'sources or artifacts changed'):
            freshness.validate(self.root)

    def test_archive_payload_mismatch_cannot_be_stamped(self):
        (self.root / 'FCMChatWidget.swf').write_bytes(b'new binary with old archive')
        with self.assertRaisesRegex(ValueError, 'payload differs'):
            freshness.stamp(self.root)
        with self.assertRaisesRegex(ValueError, 'payload differs'):
            freshness.validate(self.root)


if __name__ == '__main__':
    unittest.main()
