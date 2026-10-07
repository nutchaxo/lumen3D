import {launch,newPage,openViewer,E95,LIVE,sleep} from './lib.mjs';
const b=await launch(); const p=await newPage(b);
await openViewer(p,E95,2000);
const r=await p.evaluate(async()=>{
  const st=ViewerApp.getWorkspaceState(); const json=JSON.stringify(st);
  const enc=await UrlState.encodeState(st);
  const keys=Object.keys(st.viewer||{}); 
  const ls=Object.keys(localStorage);
  return {jsonLen:json.length, encLen:enc.length, keys, top:Object.keys(st), plugins:Object.keys(st.plugins||{}), ls, ch:JSON.stringify(st.viewer.channels).length, cam:JSON.stringify(st.viewer.camera)};
});
console.log(JSON.stringify(r,null,1));
await b.close();
