import subprocess, sys, glob, os
from PIL import Image
pdf='preview.pdf'
os.makedirs('hi',exist_ok=True)
for f in glob.glob('hi/*'): os.remove(f)
subprocess.run(['pdftoppm','-r','72','-png',pdf,'hi/p'],check=True,stderr=subprocess.DEVNULL)
fs=sorted(glob.glob('hi/p-*.png'))[1:]
os.makedirs('sp',exist_ok=True)
for f in glob.glob('sp/*'): os.remove(f)
for k in range(0,len(fs),2):
    ims=[Image.open(f).convert('RGB') for f in fs[k:k+2]]
    w,h=ims[0].size
    m=Image.new('RGB',(w*2+8,h),(80,80,80))
    for i,im in enumerate(ims): m.paste(im,(i*(w+8),0))
    m.save(f'sp/s{k//2+1:02d}.png')
print(len(fs), Image.open(fs[0]).size)
