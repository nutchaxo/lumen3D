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
for q in sys.argv[1:]:
    for k,v in fr.items():
        if isinstance(v,str) and q.lower() in v.lower():
            print(f'{k}\n   FR: {v}\n   EN: {en.get(k)}')
