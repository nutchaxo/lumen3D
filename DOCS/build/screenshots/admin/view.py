import sys,subprocess,glob,os
from PIL import Image
a,b=int(sys.argv[1]),int(sys.argv[2]); dpi=sys.argv[3] if len(sys.argv)>3 else '50'
d='/tmp/claude-0/-home-user-lumen3D/5ffff1c0-bcbf-5d42-83df-ee43f5e6cbc6/scratchpad/admin/png/'
for f in glob.glob(d+'v-*.png'): os.remove(f)
subprocess.run(['pdftoppm','-r',dpi,'-f',str(a),'-l',str(b),'-png','/home/user/lumen3D/DOCS/261007 - GUIDE-ADMIN - FR.pdf',d+'v'],stderr=subprocess.DEVNULL)
fs=sorted(glob.glob(d+'v-*.png')); w,h=Image.open(fs[0]).size; cols=min(6,len(fs)); rows=(len(fs)+cols-1)//cols
m=Image.new('RGB',(cols*w,rows*h),'white')
for k,f in enumerate(fs): m.paste(Image.open(f),((k%cols)*w,(k//cols)*h))
m.save(d+'view.png'); print(len(fs))
