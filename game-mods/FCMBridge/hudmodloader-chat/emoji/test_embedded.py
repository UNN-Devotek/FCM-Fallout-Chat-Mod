"""Verify built emoji symbols are display-list sprites, not BitmapData classes."""
import json, struct
from pathlib import Path
from embed_sprites import embed
root=Path(__file__).resolve().parent
swf=(root.parent/'FCMChatWidget.swf').read_bytes()
assert swf[:4]==b'FWS\x20'
assert b'BitmapData' not in swf and b'setImageSubstitutions' not in swf
body=swf[8:];pos=(5+4*(body[0]>>3)+7)//8+4
symbols={};characters={}
while pos<len(body):
    head=struct.unpack_from('<H',body,pos)[0];pos+=2;code=head>>6;size=head&63
    if size==63:size=struct.unpack_from('<I',body,pos)[0];pos+=4
    payload=body[pos:pos+size];pos+=size
    assert len(payload)==size
    if code in (36,32,39):
        char=struct.unpack_from('<H',payload)[0]
        assert char not in characters
        characters[char]=code
    if code==76:
        n=struct.unpack_from('<H',payload)[0];i=2
        for _ in range(n):
            char=struct.unpack_from('<H',payload,i)[0];i+=2
            end=payload.index(b'\0',i);name=payload[i:end].decode();i=end+1
            symbols[name]=char
for char,name in json.loads((root/'sprites.json').read_text())['links']:
    assert symbols[name]==char
    assert characters[char]==39 and characters[char-1]==32 and characters[char-2]==36
assert embed(body)==body, 'normalization must not duplicate emoji symbols'
print('All 4057 native emoji sprite linkages and idempotent embedding passed')
