import json,glob,sys,os
def flat(d,p=''):
    for k,v in d.items():
        if isinstance(v,dict): yield from flat(v,p+k+'.')
        else: yield p+k,v
fr={};en={}
for f in glob.glob('lang/fr.json')+glob.glob('js/modules/*/*/lang/fr.json'):
    pre='' if f=='lang/fr.json' else f.split('/')[3]+':'
    for k,v in flat(json.load(open(f,encoding='utf8'))): fr[pre+k]=v
    e=f.replace('fr.json','en.json')
    if os.path.exists(e):
        for k,v in flat(json.load(open(e,encoding='utf8'))): en[pre+k]=v
for q in open(sys.argv[1],encoding='utf8').read().split('\n'):
    q=q.strip()
    if not q: continue
    seen=[]
    for k,v in fr.items():
        if v==q and en.get(k) not in seen: seen.append(en.get(k))
    print(q,'=>',seen)
