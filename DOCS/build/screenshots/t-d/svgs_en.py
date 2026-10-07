import os
src='/home/user/lumen3D/DOCS/documentation/img/ch12/'
dst='/home/user/lumen3D/DOCS/documentation/img-en/ch12/'
M={
'pick':[
("Où se pose le point quand vous cliquez ?","Where does the point land when you click?"),
("Le rayon de votre clic","The ray of your click"),
("voile faible","faint haze"),("structure vive","bright structure"),
("● point enregistré","● recorded point"),
("Ce que l'écran montre le long du rayon","What the screen shows along the ray"),
("profondeur le long du rayon →","depth along the ray →"),
("valeur affichée","displayed value"),
("pic m (étape 1)","peak m (step 1)"),
("55 % de m","55% of m"),
("premier franchissement","first crossing"),
("= le point mesuré","= the measured point"),
("le voile reste","the haze stays"),("sous le seuil","below the threshold"),
],
'voxels':[
("Un voxel du jeu de démonstration n'est pas un cube","A voxel of the demo dataset is not a cube"),
("1,2 µm (X)","1.2 µm (X)"),("1,2 µm (Y)","1.2 µm (Y)"),("3,0 µm (Z)","3.0 µm (Z)"),
("Z est 2,5 fois plus long que X et Y.","Z is 2.5 times longer than X and Y."),
("Deux points séparés de 50 · 30 · 20 voxels (X · Y · Z)","Two points 50 · 30 · 20 voxels apart (X · Y · Z)"),
("Bon calcul (µm)","Correct calculation (µm)"),
("√((50×1,2)² + (30×1,2)² + (20×3,0)²) = √8 496 ≈ 92,2 µm","√((50×1.2)² + (30×1.2)² + (20×3.0)²) = √8,496 ≈ 92.2 µm"),
("Faux calcul (tous les voxels = 1,2 µm)","Wrong calculation (every voxel = 1.2 µm)"),
("√(50² + 30² + 20²) × 1,2 = 61,6 × 1,2 ≈ 74,0 µm  (−20 %)","√(50² + 30² + 20²) × 1.2 = 61.6 × 1.2 ≈ 74.0 µm  (−20%)"),
],
'perspective':[
("Pourquoi la barre d'échelle 3D n'est exacte qu'à une profondeur","Why the 3D scale bar is exact at one depth only"),
("plus près","nearer"),
("100 µm paraissent","100 µm look"),("plus grands","larger"),("plus petits","smaller"),
("centre de l'échantillon","centre of the specimen"),
("la barre est exacte ici","the bar is exact here"),
("plus loin","farther"),
(">barre<",">bar<"),
("Même longueur réelle, trois profondeurs : la perspective la rétrécit avec la distance.","Same real length, three depths: perspective shrinks it with distance."),
],
'xgal':[
("« Isoler le marquage » : trois étapes pour chaque pixel","“Isolate the staining”: three steps for every pixel"),
("1 · Où est le tissu jaune ?","1 · Where is the yellow tissue?"),
("« jaunisme » d'un pixel =","a pixel's “yellowness” ="),
("(rouge + vert) / 2 − bleu","(red + green) / 2 − blue"),
("On le moyenne sur un carré","It is averaged over a square"),
("d'environ 40 px de côté (image","about 40 px wide (image"),
("réduite 4 fois, flou de rayon 5).","reduced 4 times, blur radius 5)."),
("fond mat : 2 à 6","matte background: 2 to 6"),
("tronc coloré large : 6 à 9","broad yellow trunk: 6 to 9"),
("2 · Le pixel est-il bleu ?","2 · Is the pixel blue?"),
("rapport  bleu / (rouge + 1)","ratio  blue / (red + 1)"),
("Tissu non coloré : ≈ 0,6","Unstained tissue: ≈ 0.6"),
("Cœur très coloré : 2 à 4","Strongly stained core: 2 to 4"),
("force v : 0 si rapport ≤ 1,0","strength v: 0 if ratio ≤ 1.0"),
("1 si rapport ≥ 1,8, linéaire entre","1 if ratio ≥ 1.8, linear between"),
("et seulement si le « jaunisme »","and only if the local “yellowness”"),
("local dépasse 5 (sinon v = 0)","exceeds 5 (otherwise v = 0)"),
("3 · On repeint","3 · Repaint"),
("gris = luminosité × 0,35 × (1 − v)","grey = brightness × 0.35 × (1 − v)"),
("rouge  = gris + 90 × v","red   = grey + 90 × v"),
("vert    = gris + 160 × v","green = grey + 160 × v"),
("bleu    = gris + 255 × v","blue  = grey + 255 × v"),
("v = 0 : gris sombre","v = 0: dark grey"),
("v = 1 : bleu vif (90, 160, 255)","v = 1: vivid blue (90, 160, 255)"),
("Micro-exemple","Worked example"),
("Pixel (R, V, B) = (60, 90, 170) : 170 / 61 = 2,8 → v = 1, dans un tissu à « jaunisme » 8 : il devient bleu vif.","Pixel (R, G, B) = (60, 90, 170): 170 / 61 = 2.8 → v = 1, in tissue with “yellowness” 8: it turns vivid blue."),
("Pixel (200, 190, 120) : 120 / 201 = 0,6 → v = 0 : il devient gris sombre (0,35 × sa luminosité).","Pixel (200, 190, 120): 120 / 201 = 0.6 → v = 0: it turns dark grey (0.35 × its brightness)."),
],
}
for n,subs in M.items():
    t=open(src+n+'.svg',encoding='utf8').read()
    for a,b in subs:
        assert a in t,(n,a)
        t=t.replace(a,b)
    open(dst+n+'.svg','w',encoding='utf8').write(t)
