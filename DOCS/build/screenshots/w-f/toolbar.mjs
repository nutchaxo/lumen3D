import {launch,newPage,shot,openViewer,E95,t,boxes} from './lib.mjs';
const b=await launch(); const p=await newPage(b);
await openViewer(p,E95,3000);
const q=(id)=>`[data-plugin-id="${id}"]`;
const T=[
 ['[data-tool="navigate"]',1],['[data-tool="slice"]',2],['[data-tool="measure"]',3],
 [q('download-center'),4],[q('screenshot-sandboxed'),5],[q('screenshot'),6],
 [q('toggle-grid'),7],[q('toggle-axes'),8],[q('orientation-axes'),9],[q('toggle-volume'),10],[q('chunk-debug'),11],
 [q('presentation-mode'),12],[q('decompose-channels'),13],[q('zstack-browser'),14],
];
T.push(['a[href="about.html"]',15],['[data-action="colorblind"]',16],['#theme-toggle',17],['#btn-center-sample',18],['#btn-reset-view',19],['#btn-export-view',20],['#btn-reset-workspace',21],['#channel-container',22]);
const targets=await boxes(p,T.map(([sel,n])=>({sel,n,dx:n==17?-18:0,side:(n>=18&&n<22)?'left':n==22?'tr':'bottom',pad:2})));
const ids=await p.evaluate(()=>[...document.querySelectorAll('header button')].map(b=>b.outerHTML.slice(0,120)).slice(-6));
console.log(ids.join('\n'));
await shot(p,'barre-outils',{clip:{x:0,y:0,width:1600,height:950},targets:targets});
await b.close();
