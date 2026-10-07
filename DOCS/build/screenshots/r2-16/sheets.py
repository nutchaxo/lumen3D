import glob
from PIL import Image
fs=sorted(glob.glob('hi/p-*.png'))[1:]
import os
for f in glob.glob('sh*.png'): os.remove(f)
sc=0.62
for k in range(0,len(fs),8):
    ims=[Image.open(f).convert('RGB') for f in fs[k:k+8]]
    w,h=ims[0].size; tw,th=int(w*sc),int(h*sc)
    m=Image.new('RGB',(tw*4+30,th*2+10),(70,70,70))
    for i,im in enumerate(ims): m.paste(im.resize((tw,th)),((i%4)*(tw+10),(i//4)*(th+10)))
    m.save(f'sh{k//8}.png')
print(len(fs))
