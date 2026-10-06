#!/usr/bin/env python3
"""Bind the reviewed widget source inputs to the checked-in SWF and BA2."""
from __future__ import annotations

import hashlib
import importlib.util
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent
MANIFEST = 'HUD-ARTIFACTS.json'
ARTIFACTS = ('FCMChatWidget.swf', 'FCMChatWidget.ba2')


def source_hashes(root: Path) -> dict[str, str]:
    paths = list(root.glob('*.hx')) + list(root.parent.glob('Fcm*.hx'))
    paths = [p for p in paths if not p.name.startswith('Test')]
    paths += [root / name for name in (
        'build.hxml', 'normalize_swf.py', 'emoji/embed_sprites.py',
        'emoji/sprites.json', 'emoji/sprites.tags', 'emoji/asset-hashes.json',
    )]
    # Text is normalized so a Windows checkout does not invalidate Linux builds.
    return {p.relative_to(root.parent).as_posix(): hashlib.sha256(
        p.read_bytes() if p.suffix == '.tags' else p.read_bytes().replace(b'\r\n', b'\n')
    ).hexdigest() for p in sorted(paths)}


def require_matching_archive(root: Path) -> None:
    spec = importlib.util.spec_from_file_location('fcm_ba2', ROOT.parent / 'hudmenu-chat/ba2tool.py')
    assert spec and spec.loader
    ba2 = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(ba2)
    data, version, _, records, names = ba2._read(root / ARTIFACTS[1])
    if version != 1 or len(names) != 1 or ba2._norm(names[0]) != 'interface/fcmchatwidget.swf':
        raise ValueError('Widget BA2 must be BTDX v1 GNRL with exactly interface/FCMChatWidget.swf')
    if ba2._raw_blob(data, records[0]) != (root / ARTIFACTS[0]).read_bytes():
        raise ValueError('Widget BA2 payload differs from the reviewed SWF; rebuild the BA2')


def snapshot(root: Path) -> dict:
    require_matching_archive(root)
    return {'format': 1, 'sources': source_hashes(root), 'artifacts': {
        name: hashlib.sha256((root / name).read_bytes()).hexdigest() for name in ARTIFACTS
    }}


def stamp(root: Path = ROOT) -> None:
    """Call only after compiling, normalizing, validating, and rebuilding the BA2."""
    (root / MANIFEST).write_text(json.dumps(snapshot(root), indent=2, sort_keys=True) + '\n', encoding='utf-8')


def validate(root: Path = ROOT) -> None:
    try:
        recorded = json.loads((root / MANIFEST).read_text(encoding='utf-8'))
    except (OSError, ValueError) as exc:
        raise ValueError('Missing or invalid HUD artifact manifest; rebuild the widget') from exc
    if recorded != snapshot(root):
        raise ValueError('HUD sources or artifacts changed since the reviewed build; rebuild and stamp the widget')


if __name__ == '__main__':
    validate()
    print('Widget source/artifact manifest and BA2 payload verified')
