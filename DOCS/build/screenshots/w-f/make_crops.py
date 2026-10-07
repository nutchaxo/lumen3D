# Smaller crops of some screenshots (so the chapter stays compact). Same UI_LANG / IMG_DIR convention as lib.mjs.
import os
from PIL import Image
lang=os.environ.get('UI_LANG','fr')
d='/home/user/lumen3D/DOCS/documentation/'+os.environ.get('IMG_DIR','img-en/ch12' if lang=='en' else 'img/ch12')
CROPS={
 'zstack-coupe':(700,59,1600,950),
 'decomposer':(900,59,1600,950),
 'timeline':(0,600,1600,950),
 'suivi-trajectoires':(0,59,640,870),
 'export-vue':(1000,59,1600,480),
 '2d-affichage':(0,640,330,950),
 'suivi-distance':(780,200,1560,870),
 'suivi-graphiques':(320,59,1100,420),
 'suivi-inspecteur':(0,300,1100,870),
}
for n,b in CROPS.items():
    Image.open(f'{d}/{n}.png').crop(b).save(f'{d}/{n}-c.png')
