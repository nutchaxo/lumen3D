import os
from PIL import Image
lang=os.environ.get('UI_LANG','fr')
d='/home/user/lumen3D/DOCS/documentation/'+os.environ.get('IMG_DIR','img-en/ch12' if lang=='en' else 'img/ch12')
a=Image.open(d+'/2d-avant.png').convert('RGB').crop((390,110,1450,905))
b=Image.open(d+'/2d-isolation.png').convert('RGB').crop((390,110,1450,905))
W=790;H=int(795*W/1060)
a=a.resize((W,H),Image.LANCZOS);b=b.resize((W,H),Image.LANCZOS)
out=Image.new('RGB',(W*2+20,H),(255,255,255)); out.paste(a,(0,0)); out.paste(b,(W+20,0)); out.save(d+'/2d-avant-apres.png')
