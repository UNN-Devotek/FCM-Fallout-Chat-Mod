"""Build both endpoint variants and verify archive contents plus exact SWF payloads."""
import json
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest
from zipfile import ZipFile
import package


class BridgePackageTests(unittest.TestCase):
    def test_targets_and_background_payload(self):
        with TemporaryDirectory() as root:
            root = Path(root)
            for target, host in [('dev', 'dev.falloutchatmod.com'), ('prod', 'falloutchatmod.com')]:
                with self.subTest(target=target):
                    path = root / f'{target}.zip'
                    manifest = package.build(target, path)
                    with ZipFile(path) as archive:
                        names = archive.namelist()
                        self.assertEqual(len(names), len(set(names)))
                        self.assertEqual([n for n in names if n.startswith('Data/')], ['Data/FCMServerBridge.ba2'])
                        self.assertFalse(any(Path(n).suffix in ['.exe', '.dll', '.ps1', '.cmd', '.sh', '.swf'] for n in names))
                        self.assertNotIn('Data/hudmodloader.ini', names)
                        self.assertEqual(archive.read('FCMServerBridge.hudmodloader.ini'), b'FCMServerBridge\n')
                        self.assertEqual(json.loads(archive.read('BUILD.json')), manifest)
                        config = archive.read('examples/ZFE/FCMServerBridge.ini.example').decode()
                        self.assertIn(f'Endpoint=wss://{host}/relay\n', config)
                        self.assertIn('AllowedChannels=server\n', config)
                        self.assertNotIn('OpenChatKey=', config)
                        self.assertIn(f'https://{host}/link', archive.read('INSTALL.txt').decode())
                        ba2file = root / f'{target}.ba2'
                        ba2file.write_bytes(archive.read('Data/FCMServerBridge.ba2'))
                        data, _, _, records, entries = package.ba2._read(ba2file)
                        self.assertEqual(entries, [package.ENTRY])
                        swf = package.ba2._raw_blob(data, records[0])
                        self.assertIn(host.encode() + b'/link', swf)
                        if target == 'prod': self.assertNotIn(b'dev.falloutchatmod.com/link', swf)
                        self.assertLess(len(swf), 100000)  # no widget/emoji/font bundle
                        swf_file = root / f'{target}.swf'; swf_file.write_bytes(swf)
                        package.validate_pair(swf_file, ba2file)
                        swf_file.write_bytes(swf.replace(b'FCMBRIDGE/1;', b'FCMBRIDGE/9;'))
                        with self.assertRaisesRegex(ValueError, 'differs'): package.validate_pair(swf_file, ba2file)

    def test_source_is_a_separate_child_with_no_chat_or_input_ui(self):
        source = (package.ROOT / 'FCMServerBridge.hx').read_text()
        self.assertIn(f'VERSION:String = "{package.VERSION}"', source)
        self.assertNotIn('FCMChatWidget()', source)
        for text in ['TextField', 'TextEdit', 'URLLoader', 'Input.', 'startInput', 'registerPhysicalKey']:
            self.assertNotIn(text, source)
        self.assertIn('mouseEnabled = false', source)
        self.assertIn('mouseChildren = false', source)


if __name__ == '__main__': unittest.main()
