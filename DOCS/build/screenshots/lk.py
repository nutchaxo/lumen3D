import json,re,sys
def flat(d,p=''):
    o={}
    for k,v in d.items():
        if isinstance(v,dict): o.update(flat(v,p+k+'.'))
        else: o[p+k]=v
    return o
fr=flat(json.load(open('lang/fr.json'))); nl=flat(json.load(open('lang/nl.json')))
src=open('DOCS/admin-guide/GUIDE-ADMINISTRATEUR.md').read()
ui=sorted(set(re.findall(r'\[([^\]]+)\]\{\.ui\}',src)))
def norm(s): return re.sub(r'^[^\w«(]+','',s).strip().lower()
idx={}
for k,v in fr.items():
    if isinstance(v,str): idx.setdefault(norm(v),[]).append(k)
for u in ui:
    ks=idx.get(norm(u),[])
    ks=[k for k in ks if k.startswith(('admin','adm','upd','dupd','types')) or True][:4]
    print(u,'=>',[ (k,nl.get(k)) for k in ks] if ks else 'NOTFOUND')
