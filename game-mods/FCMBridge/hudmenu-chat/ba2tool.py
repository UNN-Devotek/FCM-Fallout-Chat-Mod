#!/usr/bin/env python3
"""ba2tool.py - minimal Fallout 76 BA2 (BTDX v1 GNRL) reader + blob-swap packer + creator.

Pure stdlib; no BSArch/Archive2/Wine needed. Three commands:

  extract  <ba2> <internal_name> <out_file>
      Pull one file out of a GNRL .ba2 by its internal path
      (e.g. 'interface/HUDMenu.swf'; case-insensitive, / or \\).

  blobswap <old_ba2> <out_ba2> name1=file1 [name2=file2 ...]
      Rebuild a GNRL .ba2 reusing the original records (name/dir hashes,
      ext, name table) but replacing the data blob of each named entry with
      the given file. Entries not named keep their original data. New blobs
      are stored uncompressed.

  create <out_ba2> name1=file1 [name2=file2 ...]
      Create a NEW GNRL .ba2 from scratch containing the given files.
      name1 must be a full archive path like 'interface/FCMChatWidget.swf'.
      The Bethesda hash is computed automatically (CRC32 IEEE init=0 no-final-xor
      of the lowercased stem / directory). Flags default to 0x00100100 (interface).
      Blobs are stored uncompressed.
      Example: ba2tool.py create FCMChatWidget.ba2 interface/FCMChatWidget.swf=FCMChatWidget.swf

Hash algorithm (verified against HUDModLoader.ba2):
  btdx_hash(s) = CRC32_IEEE(s.lower(), init=0, no_final_xor)
  nameHash = btdx_hash(stem_without_ext_without_dir)
  dirHash  = btdx_hash(directory_component)  -- no trailing slash

Layout (BTDX v1 GNRL):
  header 24B: 'BTDX' u32ver '<type>' u32fileCount u64 nameTableOffset
  record 36B: u32 nameHash, 4s ext, u32 dirHash, u32 flags, u64 offset,
              u32 packedSize, u32 unpackedSize, u32 sentinel(0xBAADF00D)
  name table at nameTableOffset: per file u16 len + name bytes (record order)
"""
import sys, struct, zlib

HDR = '<4sI4sIQ'
REC = '<I4sIIQIII'

# ── Bethesda BA2 GNRL hash (verified against HUDModLoader.ba2 known values) ──
# Algorithm: CRC32 IEEE table, init=0 (no initial XOR), no final XOR, on lowercase bytes.
# Differs from Python's zlib.crc32() which uses init=0xFFFFFFFF + final ^0xFFFFFFFF.
_CRC_TABLE = []
for _i in range(256):
    _c = _i
    for _ in range(8):
        _c = (_c >> 1) ^ 0xEDB88320 if (_c & 1) else (_c >> 1)
    _CRC_TABLE.append(_c)

def _btdx_hash(s: str) -> int:
    """Bethesda BTDX GNRL name/dir hash. Input is lowercased before hashing."""
    crc = 0
    for b in s.lower().encode('latin1'):
        crc = (crc >> 8) ^ _CRC_TABLE[(crc ^ b) & 0xFF]
    return crc & 0xFFFFFFFF

# Sanity check at import time against HUDModLoader.ba2 values:
assert _btdx_hash("hudmenu")      == 0xd345aaf2
assert _btdx_hash("hudmodloader") == 0xaca8af8a
assert _btdx_hash("hudtools")     == 0x02e320a4
assert _btdx_hash("interface")    == 0xd2fdf873


def _read(ba2):
    d = open(ba2, 'rb').read()
    magic, ver, typ, fcount, nameoff = struct.unpack(HDR, d[:24])
    if magic != b'BTDX' or typ != b'GNRL':
        raise SystemExit(f'unsupported archive: magic={magic!r} type={typ!r} (only BTDX GNRL)')
    recs, off = [], 24
    for _ in range(fcount):
        recs.append(list(struct.unpack(REC, d[off:off + 36])))
        off += 36
    names, p = [], nameoff
    for _ in range(fcount):
        ln = struct.unpack('<H', d[p:p + 2])[0]; p += 2
        names.append(d[p:p + ln].decode('latin1')); p += ln
    return d, ver, typ, recs, names


def _norm(n):
    return n.lower().replace('\\', '/')


def extract(ba2, name, out):
    d, ver, typ, recs, names = _read(ba2)
    target = _norm(name)
    for r, nm in zip(recs, names):
        if _norm(nm) == target:
            _, _, _, _, foff, packed, unpacked, _ = r
            blob = d[foff:foff + (packed if packed else unpacked)]
            raw = zlib.decompress(blob) if packed else blob
            if len(raw) != unpacked:
                raise SystemExit(f'size mismatch {len(raw)} != {unpacked}')
            open(out, 'wb').write(raw)
            print(f'extracted {nm} -> {out} ({len(raw)} bytes, {"zlib" if packed else "stored"})')
            return
    raise SystemExit(f'not found: {name}. candidates: ' +
                     ', '.join(n for n in names if name.split("/")[-1].lower() in n.lower())[:300])


def blobswap(old_ba2, out_ba2, swaps):
    d, ver, typ, recs, names = _read(old_ba2)
    new = {}
    for kv in swaps:
        k, _, v = kv.partition('=')
        new[_norm(k)] = open(v, 'rb').read()
    fcount = len(recs)
    blobs = []
    for r, nm in zip(recs, names):
        key = _norm(nm)
        if key in new:
            blobs.append(new[key])
        else:
            _, _, _, _, foff, packed, unpacked, _ = r
            blobs.append(d[foff:foff + (packed if packed else unpacked)])
    cur = 24 + 36 * fcount
    recbytes, databytes = b'', b''
    for r, blob in zip(recs, blobs):
        nh, ext, dh, fl, _, _, _, sent = r
        recbytes += struct.pack(REC, nh, ext, dh, fl, cur, 0, len(blob), sent)
        databytes += blob; cur += len(blob)
    nameoff_new = cur
    nt = b''.join(struct.pack('<H', len(nm.encode('latin1'))) + nm.encode('latin1') for nm in names)
    out = struct.pack(HDR, b'BTDX', ver, typ, fcount, nameoff_new) + recbytes + databytes + nt
    open(out_ba2, 'wb').write(out)
    swapped = ', '.join(sorted(new.keys()))
    print(f'wrote {out_ba2} ({len(out)} bytes, {fcount} files; swapped: {swapped})')


def create(out_ba2, entries):
    """Create a new BTDX GNRL ba2 from scratch.

    entries: list of 'archive/path/name.ext=localfile' strings.
    The archive path is used to compute nameHash (stem) and dirHash (directory).
    Flags default to 0x00100100 (standard interface SWF flags from HUDModLoader.ba2).
    """
    DEFAULT_FLAGS = 0x00100100
    SENTINEL      = 0xBAADF00D

    recs, blobs, names = [], [], []
    for kv in entries:
        archive_path, _, local_file = kv.partition('=')
        archive_path = archive_path.replace('\\', '/')
        parts = archive_path.rsplit('/', 1)
        if len(parts) == 2:
            dir_part, file_part = parts
        else:
            dir_part, file_part = '', parts[0]
        stem, _, ext_str = file_part.rpartition('.')
        if not stem:
            stem = file_part; ext_str = ''

        name_hash = _btdx_hash(stem)
        dir_hash  = _btdx_hash(dir_part) if dir_part else 0
        ext_bytes = (ext_str.lower() + '\x00')[:4].ljust(4, '\x00').encode('latin1')

        blob = open(local_file, 'rb').read()
        blobs.append(blob)
        recs.append((name_hash, ext_bytes, dir_hash, DEFAULT_FLAGS, SENTINEL))
        names.append(archive_path)
        print(f'  adding {archive_path!r}  nameHash={name_hash:#010x}  dirHash={dir_hash:#010x}  size={len(blob)}')

    fcount  = len(recs)
    cur_off = 24 + 36 * fcount
    recbytes, databytes = b'', b''
    for (nh, ext, dh, fl, sent), blob in zip(recs, blobs):
        recbytes += struct.pack(REC, nh, ext, dh, fl, cur_off, 0, len(blob), sent)
        databytes += blob
        cur_off   += len(blob)

    nameoff = cur_off
    nt = b''.join(struct.pack('<H', len(nm.encode('latin1'))) + nm.encode('latin1') for nm in names)
    out = struct.pack(HDR, b'BTDX', 1, b'GNRL', fcount, nameoff) + recbytes + databytes + nt
    open(out_ba2, 'wb').write(out)
    print(f'wrote {out_ba2} ({len(out)} bytes, {fcount} file(s))')


def main(argv):
    if len(argv) >= 5 and argv[1] == 'extract':
        extract(argv[2], argv[3], argv[4])
    elif len(argv) >= 5 and argv[1] == 'blobswap':
        blobswap(argv[2], argv[3], argv[4:])
    elif len(argv) >= 4 and argv[1] == 'create':
        create(argv[2], argv[3:])
    else:
        print(__doc__); raise SystemExit(2)


if __name__ == '__main__':
    main(sys.argv)
