import sys
from PIL import Image
L=sys.argv[1]; names=sys.argv[2:]
S='/tmp/claude-0/-home-user-lumen3D/5ffff1c0-bcbf-5d42-83df-ee43f5e6cbc6/scratchpad/admin-i18n'
for n in names:
    a=Image.open(f'/home/user/lumen3D/DOCS/admin-guide/img/{n}.png').convert('RGB')
    b=Image.open(f'{S}/{L}/{n}.png').convert('RGB')
    W=900
    a2=a.resize((W,int(a.height*W/a.width))); b2=b.resize((W,int(b.height*W/b.width)))
    im=Image.new('RGB',(W*2+10,max(a2.height,b2.height)),'white'); im.paste(a2,(0,0)); im.paste(b2,(W+10,0))
    im.save(f'{S}/cmp_{n}.png')
