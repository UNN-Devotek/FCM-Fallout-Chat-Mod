"""Insert reviewed display-list sprite tags/linkage into the widget SWF."""
import hashlib,json,struct
from pathlib import Path
ROOT=Path(__file__).resolve().parent
def tag(code,payload): return struct.pack('<HI',code<<6|63,len(payload))+payload
def embed(body):
    offset=(5+4*(body[0]>>3)+7)//8+4
    records=[]; pos=offset; found=False
    while pos<len(body):
        head=struct.unpack_from('<H',body,pos)[0];pos+=2;code=head>>6;length=head&63
        if length==63: length=struct.unpack_from('<I',body,pos)[0];pos+=4
        payload=body[pos:pos+length];pos+=length
        if code==82 and b'FCMChatWidget' in payload and b'FcmEmojiImage0' in payload: found=True
        records.append((code,payload))
    if not found: return body # Other project SWFs share the normalizer.
    if any(code==76 and b'FcmEmojiImage0\0' in payload for code,payload in records): return body
    meta=json.loads((ROOT/'sprites.json').read_text());sprites=(ROOT/'sprites.tags').read_bytes()
    if hashlib.sha256((ROOT/'asset-hashes.json').read_bytes()).hexdigest()!=meta['sources']: raise ValueError('Sprite inputs changed; rebuild native sprite archive')
    if hashlib.sha256(sprites).hexdigest()!=meta['sha256']: raise ValueError('Sprite archive checksum mismatch')
    output=bytearray(body[:offset]); inserted=False
    for code,payload in records:
        if not inserted and code in (82,76): output+=sprites;inserted=True
        if code==76:
            n=struct.unpack_from('<H',payload)[0]
            payload=struct.pack('<H',n+len(meta['links']))+payload[2:]+b''.join(struct.pack('<H',i)+name.encode()+b'\0' for i,name in meta['links'])
        output+=tag(code,payload)
    return bytes(output)
