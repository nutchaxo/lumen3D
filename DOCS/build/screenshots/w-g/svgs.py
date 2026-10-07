import os
D='/home/user/lumen3D/DOCS/documentation/img'
C={'blue':('#3b5bdb','#e8edff'),'green':('#2b8a3e','#ebfbee'),'amber':('#e67700','#fff4e6'),'violet':('#7048e8','#f3f0ff'),'teal':('#0c8599','#e3fafc'),'red':('#c92a2a','#fff0f0'),'grey':('#4a5468','#f1f3f7')}
def esc(s): return s.replace('&','&amp;').replace('<','&lt;')
def head(h,title):
    return f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 {h}" font-family="Inter, sans-serif">
<defs><marker id="arr" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="#4a5468"/></marker>
<marker id="arrr" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="#c92a2a"/></marker></defs>
<rect width="800" height="{h}" rx="16" fill="#f8f9fd"/>
<text x="400" y="30" text-anchor="middle" font-size="17" font-weight="800" fill="#1c2333">{esc(title)}</text>
'''
def box(x,y,w,h,title,lines=(),col='blue',emoji=None,fs=12.5):
    s,f=C[col]
    o=f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="12" fill="{f}" stroke="{s}" stroke-width="1.6"/>\n'
    ty=y+22
    if emoji:
        o+=f'<text x="{x+w/2}" y="{y+30}" text-anchor="middle" font-size="24">{emoji}</text>\n'; ty=y+54
    o+=f'<text x="{x+w/2}" y="{ty}" text-anchor="middle" font-size="13.5" font-weight="800" fill="{s}">{esc(title)}</text>\n'
    for i,l in enumerate(lines):
        o+=f'<text x="{x+w/2}" y="{ty+19+i*16}" text-anchor="middle" font-size="{fs}" fill="#1c2333">{esc(l)}</text>\n'
    return o
def arrow(x1,y1,x2,y2,red=False,dash=False):
    m='arrr' if red else 'arr'; c='#c92a2a' if red else '#4a5468'
    d=' stroke-dasharray="6 4"' if dash else ''
    return f'<line x1="{x1}" y1="{y1}" x2="{x2}" y2="{y2}" stroke="{c}" stroke-width="2.2"{d} marker-end="url(#{m})"/>\n'
def text(x,y,t,size=12.5,col='#4a5468',w='400',anchor='middle'):
    return f'<text x="{x}" y="{y}" text-anchor="{anchor}" font-size="{size}" font-weight="{w}" fill="{col}">{esc(t)}</text>\n'
def pill(x,y,w,t,col):
    s,f=C[col]
    return f'<rect x="{x}" y="{y}" width="{w}" height="22" rx="11" fill="#fff" stroke="{s}"/><text x="{x+w/2}" y="{y+15}" text-anchor="middle" font-size="12" font-weight="700" fill="{s}">{esc(t)}</text>\n'
def save(path,body,h,title):
    open(f'{D}/{path}','w').write(head(h,title)+body+'</svg>\n')

# ---------- ch13 dataset flow
b=''
b+=text(30,64,'VOIE A · Copier à la main (FTP / SFTP)',13.5,'#e67700','800','start')
b+=box(30,76,200,84,'Dossier du pipeline',['DATA_WEB/3d/mon-embryon/'],'amber','📁')
b+=arrow(232,118,288,118)
b+=box(290,76,220,84,'Copie dans DATA_WEB',['dans 3d/, 2d/ ou live/'],'amber','🗂️')
b+=arrow(512,118,568,118)
b+=box(570,76,200,84,'Dans le catalogue',['aussitôt, sans rien régénérer'],'green','✅')
b+=text(30,196,'VOIE B · Onglet Import (depuis le navigateur, sans FTP)',13.5,'#3b5bdb','800','start')
xs=[30,182,334,486,638]
items=[('Glisser',['le dossier ; le type','est détecté seul'],'blue','🖱️'),
       ('Envoi par paliers',['blocs de 8 Mio','reprise si coupure'],'blue','☁️'),
       ('Éditable tôt',['renommer, canaux,','en quelques minutes'],'violet','✏️'),
       ('Vérifier',['intégrité complète','du dataset reçu'],'teal','🔍'),
       ('Publier',['un clic ; masqué','jusqu\u2019à l\u2019œil'],'green','🚀')]
for x,(t,l,c,e) in zip(xs,items):
    b+=box(x,208,132,112,t,l,c,e,fs=11.5)
for x in xs[:-1]:
    b+=arrow(x+134,264,x+150,264)
b+='<rect x="30" y="340" width="740" height="52" rx="12" fill="#fff" stroke="#c5cbd8"/>\n'
b+=text(400,362,'Pendant tout le transfert, les fichiers restent dans une zone privée (uploads/staging/),',12.5,'#1c2333','600')
b+=text(400,380,'jamais accessible par URL. Un dataset publié par l’Import est masqué par défaut.',12.5,'#1c2333','600')
save('ch13/flux-dataset.svg',b,412,'Mettre un dataset en ligne : deux chemins')

# ---------- ch13 migrations
b=''
xs=[24,226,428,630]
for i,(x,t,sub,c) in enumerate(zip(xs,['Format 1','Format 2','Format 3','Format 4'],
   ['briques seules','+ planes/','+ mips/','briques v3 (66³)'],['grey','blue','violet','green'])):
    b+=box(x,52,146,74,t,[sub],c,None,fs=12.5)
steps=[('1 → 2','plans XY','planes/'),('2 → 3','projections de couches','mips/'),('3 → 4','briques reconstruites','bricks/ v3 + index.bin')]
for i,(a,t,d) in enumerate(steps):
    x1=xs[i]+148
    b+=arrow(x1,89,xs[i+1]-2,89)
    b+=text(xs[i]+174,48 if False else 146,a,12,'#1c2333','800')
    b+=text(xs[i]+174,162,t,11.5,'#4a5468')
b+=text(400,196,'La nouvelle version se calcule à côté de l’ancienne ; elle ne la remplace qu’à la toute fin (version du dataset changée en dernier).',12,'#4a5468')
b+=text(30,230,'Qui fait le travail ? Vous choisissez, dataset par dataset :',13.5,'#1c2333','800','start')
b+=box(30,244,300,112,'Ce navigateur',['télécharge les briques,','les redécoupe, renvoie le résultat'],'blue','🖥️',fs=11.5)
b+=box(470,244,300,112,'Le serveur',['convertit par petites requêtes ;','grisé s’il en est incapable'],'teal','🗄️',fs=11.5)
b+=text(400,298,'⇄',30,'#4a5468','800')
b+=text(400,320,'même journal',11.5,'#4a5468')
b+=text(400,336,'sur le serveur',11.5,'#4a5468')
b+=box(30,376,360,70,'Test de vitesse (5 s)',['les deux exécutants convertissent le même','bloc : le plus rapide devient le défaut'],'amber',None,fs=11.5)
b+=box(410,376,360,70,'Régulateur réseau',['6 requêtes en vol au plus, 10 à 16/s ;','il ralentit si l\u2019hébergeur répond 429 ou 503'],'violet',None,fs=11.5)
save('ch13/migrations.svg',b,462,'Mises à jour des données : formats 1 → 4')

# ---------- ch13 platform update
b=''
st=[('1 Sauvegarde','zip de contrôle',0),('2 Téléchargement','somme + signature',1),('3 Préparation','copie à côté (staging)',2),('4 Autotest','démarrage à blanc',3)]
x=24
for i,(t,l,_) in enumerate(st):
    b+=box(x,54,166,74,t,[l],['grey','blue','violet','teal'][i],None,fs=11.5)
    if i<3: b+=arrow(x+168,91,x+190,91)
    x+=192
b+=arrow(400,130,400,160)
b+=box(24,162,340,112,'5 Bascule',['arrêt propre, échange des fichiers','un à un (journalisé), redémarrage'],'amber','🔁',fs=11.5)
b+=arrow(366,218,430,218)
b+=box(432,162,344,112,'6 Contrôle de santé (~30 s)',['la page /api/health doit annoncer','la version attendue'],'blue','🩺',fs=11.5)
b+=arrow(500,276,350,318)
b+=arrow(708,276,708,318)
b+=box(24,320,380,100,'ÉCHEC → retour automatique',['l’ancienne version est restaurée','et redémarrée ; l’admin l’affiche'],'red','↩️',fs=11.5)
b+=box(430,320,346,100,'SUCCÈS → terminé',['journal et copie temporaire effacés ;','vos données ne sont jamais touchées'],'green','✅',fs=11.5)
b+=text(400,446,'Protégés pendant la mise à jour : DATA_WEB, config/, uploads/, identifiants, statistiques, plugins installés.',12,'#4a5468')
save('ch13/mise-a-jour-plateforme.svg',b,466,'Mettre à jour la plateforme : bascule avec filet de sécurité')

# ---------- ch14 password
b=''
b+=box(30,52,170,108,'Votre mot de passe',['tapé une seule fois','dans le formulaire'],'blue','🔑',fs=11.5)
b+=arrow(202,106,262,106)
b+=box(264,52,200,108,'Broyeur à sens unique',['PBKDF2-HMAC-SHA256','600 000 tours + sel'],'violet','⚙️',fs=11.5)
b+=arrow(466,106,526,106)
b+=box(528,52,242,108,'Empreinte enregistrée',['api/admin_credential.json','jamais servi par le web'],'green','🔏',fs=11.5)
b+=text(400,188,'On ne stocke jamais le mot de passe : seulement son « empreinte digitale ». On ne remonte pas d\u2019une empreinte à un mot de passe.',12,'#4a5468')
b+=text(30,222,'Contre les essais répétés',13.5,'#1c2333','800','start')
for i,(t,sub,c) in enumerate([('10 essais','par adresse, par fenêtre de 15 min','amber'),('Blocage 15 min','réponse « Trop de tentatives »','red'),('Session de 8 h','fermée au changement de mot de passe','green')]):
    x=30+i*250
    b+=box(x,234,226,72,t,[sub],c,None,fs=11)
    if i<2: b+=arrow(x+228,270,x+248,270)
save('ch14/mot-de-passe.svg',b,324,'Le mot de passe administrateur')

# ---------- ch14 CSP
b=''
b+=box(30,50,230,120,'Le serveur sert la page',['tire au sort un code à','usage unique, le nonce,','nouveau à chaque chargement'],'blue','🎟️',fs=11.5)
b+=arrow(262,110,318,110)
b+=box(320,50,200,120,'Liste d\u2019invités',['le navigateur n\u2019exécute que','les scripts qui portent','le bon code'],'violet','📋',fs=11.5)
b+=arrow(522,110,578,110)
b+=box(580,50,190,120,'Script du site',['code + bon nonce','→ il entre'],'green','✅',fs=11.5)
b+=box(320,204,200,108,'Script injecté',['pas de code valide','→ refusé à la porte'],'red','🚫',fs=11.5)
b+=arrow(420,172,420,202,red=True)
b+=box(30,204,260,108,'Pourquoi ça compte',['une légende d\u2019image piégée ne','peut pas faire exécuter de code'],'amber','💡',fs=11.5)
b+=box(550,204,220,108,'Aussi interdits',['eval(), scripts venus d\u2019un','autre site, objets embarqués'],'grey',None,fs=11.5)
save('ch14/csp.svg',b,332,'La politique de sécurité du contenu (CSP)')

# ---------- ch14 uploads
b=''
b+=box(24,52,140,104,'Navigateur',['glisse le dossier'],'blue','🖥️',fs=11.5)
b+=arrow(166,104,196,104)
b+=box(198,52,160,104,'Liste blanche',['pas de .php, .js,','fichier caché ni « .. »'],'amber','🛂',fs=11)
b+=arrow(360,104,390,104)
b+=box(392,52,170,104,'Zone privée',['uploads/staging/,','aucune URL possible'],'violet','🔒',fs=11)
b+=arrow(564,104,594,104)
b+=box(596,52,180,104,'Publication',['validée, puis un','simple déplacement'],'green','🚀',fs=11)
b+=text(400,186,'Chaque bloc est vérifié (SHA-256) avant d\u2019être écrit ; l\u2019aperçu administrateur lit la zone privée par un relais protégé par la session.',11.5,'#4a5468')
save('ch14/import-prive.svg',b,206,'Les fichiers importés ne sont jamais servis par URL')

# ---------- ch14 plugin trust
b=''
b+=text(30,60,'Les plugins : par défaut, on n\u2019ouvre pas',13.5,'#1c2333','800','start')
tiers=[('Intégré / catalogue','signé, vérifié','green'),('Approuvé','par vous, lié à une empreinte','blue'),('Développement','avec --dev-trust-local','grey'),('Non fiable','non chargé','red')]
for i,(t,s_,c) in enumerate(tiers):
    x=30+i*185
    b+=box(x,72,170,70,t,[s_],c,None,fs=11)
b+=box(30,166,356,134,'Approbation liée à une empreinte',['Vous approuvez ce contenu précis. Si un','seul fichier change, l\u2019empreinte change :','le plugin redevient non fiable. Votre mot','de passe est demandé pour approuver.'],'violet','🔖',fs=11)
b+=box(414,166,356,134,'Bac à sable (iframe isolée)',['Un plugin tiers peut tourner dans une','cage : sans accès à la page, il ne parle','que par messages, avec des permissions','déclarées et un débit limité.'],'teal','📦',fs=11)
save('ch14/plugins.svg',b,320,'Confiance accordée aux plugins')

# ---------- ch14 signatures
b=''
b+=box(24,52,230,118,'Éditeur (CI)',['teste tout, puis signe la liste','SHA256SUMS avec la clé','privée (secrète)'],'blue','🖊️',fs=11.5)
b+=arrow(256,110,296,110)
b+=box(298,52,200,118,'Version publiée',['archive + SHA256SUMS','+ SHA256SUMS.sig','(le « sceau de cire »)'],'amber','📦',fs=11.5)
b+=arrow(500,110,540,110)
b+=box(542,52,234,118,'Votre serveur',['vérifie le sceau avec la clé','publique de son code ; sinon','refus, aucune mise à jour'],'green','🔍',fs=11.5)
b+=text(400,204,'Seconde clé, distincte : elle signe le catalogue de plugins (avec un numéro de série qui empêche de revenir à un catalogue plus ancien).',11.5,'#4a5468')
save('ch14/signatures.svg',b,224,'Versions et catalogue signés (Ed25519)')
print('ok')
