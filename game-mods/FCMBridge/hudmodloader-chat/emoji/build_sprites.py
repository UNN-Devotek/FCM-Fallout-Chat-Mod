#!/usr/bin/env python3
"""Offline PNG -> native SWF bitmap-filled sprites; no AS3 BitmapData dependency.
Requires Pillow only when refreshing artwork, not for ordinary Haxe/CI builds.
"""
import hashlib, json, struct, zlib
from pathlib import Path
from PIL import Image
ROOT=Path(__file__).resolve().parent
class Bits:
    def __init__(self): self.bits=[]
    def put(self,n,value): self.bits.extend((value >> i)&1 for i in range(n-1,-1,-1))
    def data(self):
        self.bits += [0]*((-len(self.bits))%8)
        return bytes(sum(self.bits[i+j]<<(7-j) for j in range(8)) for i in range(0,len(self.bits),8))
def tag(code,data): return struct.pack('<HI',(code<<6)|63,len(data))+data
def rect(w,h):
    b=Bits();n=max(w,h).bit_length()+1;b.put(5,n)
    for v in (0,w,0,h): b.put(n,v)
    return b.data()
def shape(image,w,h):
    matrix=Bits();matrix.put(1,1);matrix.put(5,22);matrix.put(22,20*65536);matrix.put(22,20*65536)
    matrix.put(1,0);matrix.put(5,0)
    b=Bits();b.put(4,1);b.put(4,0)
    b.put(1,0);b.put(5,5);b.put(5,1);b.put(1,0);b.put(1,0);b.put(1,1)
    for vertical,delta in ((0,w),(1,h),(0,-w),(1,-h)):
        n=abs(delta).bit_length()+1
        b.put(1,1);b.put(1,1);b.put(4,n-2);b.put(1,0);b.put(1,vertical);b.put(n,delta)
    b.put(6,0)
    return rect(w,h)+b'\x01\x41'+struct.pack('<H',image)+matrix.data()+b'\x00'+b.data()
def main():
    output=bytearray(); links=[]
    for i,p in enumerate(sorted((ROOT/'images').glob('*.png'))):
        image_id=1000+i*3; shape_id=image_id+1; sprite_id=image_id+2
        image=Image.open(p).convert('RGBA');w,h=image.size
        pixels=bytearray()
        for r,g,b,a in image.get_flattened_data(): pixels.extend((a,(r*a+127)//255,(g*a+127)//255,(b*a+127)//255))
        output+=tag(36,struct.pack('<HBHH',image_id,5,w,h)+zlib.compress(pixels,9))
        output+=tag(32,struct.pack('<H',shape_id)+shape(image_id,w*20,h*20))
        placed=tag(26,b'\x06'+struct.pack('<HH',1,shape_id)+b'\x00')
        output+=tag(39,struct.pack('<HH',sprite_id,1)+placed+tag(1,b'')+tag(0,b''))
        links.append([sprite_id,'FcmEmojiImage'+str(i)])
    (ROOT/'sprites.tags').write_bytes(output)
    (ROOT/'sprites.json').write_text(json.dumps({'sha256':hashlib.sha256(output).hexdigest(),'sources':hashlib.sha256((ROOT/'asset-hashes.json').read_bytes()).hexdigest(),'links':links},separators=(',',':'))+'\n')
    print('Built',len(links),'native sprites')
if __name__=='__main__': main()
