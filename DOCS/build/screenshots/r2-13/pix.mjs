import fs from 'fs';
const src = fs.readFileSync('/home/user/lumen3D/js/workers/pixel-ops-2d.js','utf8');
const Ops = new Function(src + '; return PixelOps2D;')();
const W=1920,H=1440;
const full = new Uint8ClampedArray(fs.readFileSync('d2/full.rgba'));
const s4 = new Uint8ClampedArray(fs.readFileSync('d2/s4.rgba'));
const s8 = new Uint8ClampedArray(fs.readFileSync('d2/s8.rgba'));
const t=Ops.tissueSampleSize(W,H), f=Ops.flatSampleSize(W,H);
console.log('tissue sample', t, 'flat sample', f);
const ctx = Ops.tissueContext(s4, t.w, t.h);
fs.writeFileSync('d2/ctx.f32', Buffer.from(ctx.data.buffer));
const iso = new Uint8ClampedArray(full); Ops.applyIsolation(iso, W, H, ctx);
fs.writeFileSync('d2/iso.rgba', Buffer.from(iso.buffer));
const flat = Ops.flattenMap(s8, f.w, f.h);
fs.writeFileSync('d2/gain.f32', Buffer.from(flat.gain.buffer));
const lut = Ops.channelLuts({brightness:0,contrast:0,gamma:1,wbRed:1,wbBlue:1});
const out = new Uint8ClampedArray(full); Ops.applyAdjust(out, W, H, lut, flat);
fs.writeFileSync('d2/flat.rgba', Buffer.from(out.buffer));
let gmin=1e9,gmax=-1e9; for (const g of flat.gain){gmin=Math.min(gmin,g);gmax=Math.max(gmax,g);} console.log('gain', gmin, gmax);
// LUT curves
const curves={};
for (const [k,a] of Object.entries({id:{brightness:0,contrast:0,gamma:1,wbRed:1,wbBlue:1}, bright:{brightness:30,contrast:0,gamma:1,wbRed:1,wbBlue:1}, contrast:{brightness:0,contrast:50,gamma:1,wbRed:1,wbBlue:1}, gamma2:{brightness:0,contrast:0,gamma:2,wbRed:1,wbBlue:1}, blue14:{brightness:0,contrast:0,gamma:1,wbRed:1,wbBlue:1.4}})) {
  const l=Ops.channelLuts(a); curves[k]={g:Array.from(l.g), b:Array.from(l.b)};
}
fs.writeFileSync('d2/curves.json', JSON.stringify(curves));
