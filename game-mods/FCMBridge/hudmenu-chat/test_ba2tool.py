#!/usr/bin/env python3
"""Regression tests for BA2 blob replacement and missing-entry insertion."""
import importlib.util
import pathlib
import tempfile


HERE = pathlib.Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location('ba2tool', HERE / 'ba2tool.py')
ba2tool = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(ba2tool)


def write(path, data):
    path.write_bytes(data)
    return str(path)


def main():
    with tempfile.TemporaryDirectory(prefix='fcm-ba2-test-') as temp:
        root = pathlib.Path(temp)
        original = write(root / 'original.swf', b'original-hud')
        replacement = write(root / 'replacement.swf', b'replaced-hud')
        fragment_bytes = b'[TextChat]\nEndpoint=wss://dev.example/relay\n'
        fragment = write(root / 'FCM.ini', fragment_bytes)
        base = root / 'base.ba2'
        output = root / 'output.ba2'
        extracted_hud = root / 'extracted-hud.swf'
        extracted_fragment = root / 'extracted-FCM.ini'

        ba2tool.create(str(base), [f'interface/HUDMenu.swf={original}'])
        ba2tool.blobswap(str(base), str(output), [
            f'interface/HUDMenu.swf={replacement}',
            f'Data/ZFE/TextChat/fragments/FCM.ini={fragment}',
        ])

        ba2tool.extract(str(output), 'interface/HUDMenu.swf', str(extracted_hud))
        ba2tool.extract(
            str(output),
            'Data/ZFE/TextChat/fragments/FCM.ini',
            str(extracted_fragment),
        )
        assert extracted_hud.read_bytes() == b'replaced-hud'
        assert extracted_fragment.read_bytes() == fragment_bytes

        _, _, _, records, names = ba2tool._read(str(output))
        assert len(records) == 2, (records, names)
        assert {ba2tool._norm(name) for name in names} == {
            'interface/hudmenu.swf',
            'data/zfe/textchat/fragments/fcm.ini',
        }

    print('BA2 blob-swap tests passed')


if __name__ == '__main__':
    main()
