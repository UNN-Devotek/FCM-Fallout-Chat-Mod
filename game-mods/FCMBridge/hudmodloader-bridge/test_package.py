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
                        config = json.loads(archive.read('EXPORT.json'))
                        self.assertEqual(config['environment'], target)
                        self.assertIn(f'{target}-state.json', config['zfe'])
                        self.assertIn(f'fcmserverbridge-{target}.json', config['xscal'])
                        self.assertFalse(any('TextChat' in n or 'xscal.ini' in n for n in names))
                        self.assertIn(f'https://{host}', archive.read('INSTALL.txt').decode())
                        install = archive.read('INSTALL.txt').decode()
                        self.assertIn('ZFE INSTALL', install)
                        self.assertIn('XSCAL INSTALL', install)
                        self.assertLess(install.index('ZFE INSTALL'), install.index('XSCAL INSTALL'))
                        self.assertIn('Do not edit xscal.ini for the Server Bridge', install)
                        self.assertIn('[Chat] enabled and\n   relayEndpoint settings are only for the visible FCM in-game HUD', install)
                        self.assertNotIn('named load(name)', install)
                        self.assertNotIn('native-unverified test candidate', install)
                        ba2file = root / f'{target}.ba2'
                        ba2file.write_bytes(archive.read('Data/FCMServerBridge.ba2'))
                        data, _, _, records, entries = package.ba2._read(ba2file)
                        self.assertEqual(entries, [package.ENTRY])
                        swf = package.ba2._raw_blob(data, records[0])
                        self.assertIn(target.encode(), swf)
                        self.assertNotIn(b'/link', swf)
                        self.assertIn(b'FcmJson', swf)
                        self.assertNotIn(b'JsonParser', swf)
                        self.assertNotIn(b'-perf:p', swf)
                        self.assertLess(len(swf), 100000)  # no widget/emoji/font bundle
                        swf_file = root / f'{target}.swf'; swf_file.write_bytes(swf)
                        package.validate_pair(swf_file, ba2file)
                        swf_file.write_bytes(swf.replace(b'writeStorage', b'writeStoragX'))
                        with self.assertRaisesRegex(ValueError, 'differs'): package.validate_pair(swf_file, ba2file)

    def test_diagnostic_package_is_marked_and_keeps_one_export_file(self):
        with TemporaryDirectory() as root:
            path = Path(root) / 'bridge-perf-test.zip'
            manifest = package.build('dev', path, diagnostic=True)
            with ZipFile(path) as archive:
                self.assertTrue(manifest['diagnostic'])
                self.assertIn('DIAGNOSTIC TEST BUILD - NOT FOR RELEASE', archive.read('INSTALL.txt').decode())
                self.assertEqual([name for name in archive.namelist() if name.startswith('Data/')],
                                 ['Data/FCMServerBridge.ba2'])

    def test_source_is_a_separate_child_with_no_chat_or_input_ui(self):
        source = (package.ROOT / 'FCMServerBridge.hx').read_text()
        self.assertIn(f'VERSION:String = "{package.VERSION}"', (package.ROOT / 'FcmBridgeExport.hx').read_text())
        self.assertIn('VERSION:String = FcmBridgeExport.VERSION', source)
        self.assertNotIn('FCMChatWidget()', source)
        for text in ['TextField', 'TextEdit', 'URLLoader', 'Input.', 'startInput', 'registerPhysicalKey',
                     'chat.v1.', 'getAuthState', 'pollEvents', 'Link code']:
            self.assertNotIn(text, source)
        self.assertIn('mouseEnabled = false', source)
        self.assertIn('mouseChildren = false', source)

    def test_native_prototype_is_separate_and_refuses_production(self):
        with TemporaryDirectory() as root:
            path = Path(root) / 'native.zip'
            with self.assertRaisesRegex(ValueError, 'requires dev'):
                package.build('prod', path, native_prototype=True)
            self.assertFalse(path.exists())
            manifest = package.build('dev', path, native_prototype=True)
            self.assertTrue(manifest['nativePrototype'])
            with ZipFile(path) as archive:
                self.assertIsNone(archive.testzip())
                self.assertIn('LOCAL DEVELOPMENT ONLY', archive.read('INSTALL.txt').decode())

    def test_storage_responses_use_gfx_reader(self):
        source = (package.ROOT / 'FcmBridgeStorage.hx').read_text()
        self.assertNotIn('haxe.Json.parse', source)
        self.assertIn('FcmJson.parse', source)

    def test_session_policy_does_not_decode_or_retain_native_payloads(self):
        state = (package.ROOT / 'FcmBridgeState.hx').read_text()
        self.assertIn('observe(observation:FcmRosterObservation)', state)
        self.assertIn('menu(observation:FcmMenuObservation)', state)
        self.assertNotIn('data:Dynamic', state)
        self.assertNotIn('provider:Dynamic', state)
        self.assertNotIn('GetDataFromClient', state)
        self.assertNotIn('rows[i]', state)

    def test_reader_uses_native_accepted_split_not_rejected_unified_decoder(self):
        reader = (package.ROOT.parent / 'hudmodloader-chat/FcmHudRosterReader.hx').read_text()
        payload = reader.split('public function payload(', 1)[1].split('function remember(', 1)[0]
        self.assertIn('FcmRoster.readNames(key, data, localName)', payload)
        self.assertIn('readAuxiliary(', payload)
        self.assertNotIn('switch key', payload)
        self.assertNotIn('FcmRoster.readNative(', reader)
        self.assertNotIn('data:Dynamic, signature:', reader)
        self.assertNotIn('previous.data', reader)


if __name__ == '__main__': unittest.main()
