import sys
from PIL import Image
a,b=int(sys.argv[1]),int(sys.argv[2])
ims=[Image.open(f'hi/p-{i:02d}.png') for i in range(a,b+1)]
w,h=ims[0].size; s=0.55
ims=[i.resize((int(w*s),int(h*s))) for i in ims]; w,h=ims[0].size
M=Image.new('RGB',(w*len(ims),h),'white')
for k,i in enumerate(ims): M.paste(i,(k*w,0))
M.save(f'm_{a}_{b}.png')
