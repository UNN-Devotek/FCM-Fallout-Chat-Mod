#!/usr/bin/env python3
"""Rebuild and record the widget artifact pair without publishing or installing it."""
import subprocess
import sys
import tempfile
from pathlib import Path
from artifact_freshness import ROOT, source_hashes, stamp, validate


def main():
    before = source_hashes(ROOT)
    for command in (
        ['haxe', 'build.hxml'],
        [sys.executable, 'normalize_swf.py', 'FCMChatWidget.swf'],
        [sys.executable, '../tools/validate_swf.py', 'FCMChatWidget.swf', '--require-signature', 'FWS', '--require-version', '32'],
        [sys.executable, 'emoji/test_embedded.py'],
    ):
        subprocess.run(command, cwd=ROOT, check=True)
    with tempfile.TemporaryDirectory(prefix='fcm-widget-build-') as temporary:
        archive = Path(temporary) / 'FCMChatWidget.ba2'
        extracted = Path(temporary) / 'FCMChatWidget.swf'
        subprocess.run([sys.executable, '../hudmenu-chat/ba2tool.py', 'blobswap', 'FCMChatWidget.ba2', str(archive),
                        'interface/FCMChatWidget.swf=FCMChatWidget.swf'], cwd=ROOT, check=True)
        subprocess.run([sys.executable, '../hudmenu-chat/ba2tool.py', 'extract', str(archive),
                        'interface/FCMChatWidget.swf', str(extracted)], cwd=ROOT, check=True)
        if extracted.read_bytes() != (ROOT / 'FCMChatWidget.swf').read_bytes():
            raise ValueError('Rebuilt BA2 does not contain the compiled SWF')
        if source_hashes(ROOT) != before:
            raise ValueError('Widget inputs changed during compilation; rebuild again')
        (ROOT / 'FCMChatWidget.ba2').write_bytes(archive.read_bytes())
    stamp()
    validate()
    print('Rebuilt and verified SWF, BA2, and source/artifact manifest')


if __name__ == '__main__':
    main()
