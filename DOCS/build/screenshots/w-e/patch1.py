s=open('common.mjs').read()
i=s.index('export async function openViewer')
s=s[:i]+'''export async function openViewer(page, id, wait = 5000) {
  await page.goto(`${BASE}/viewer.html?id=${id}`, { waitUntil: 'domcontentloaded', timeout: 120000 });
  // wait for the final level: histograms present and the progress line hidden again
  const t0 = Date.now();
  while (Date.now() - t0 < 360000) {
    await sleep(4000);
    const ok = await page.evaluate(() => { try { return VolumeViewer.getChannelHistograms().length > 0 && document.querySelector('#quality-stream-progress')?.classList.contains('hidden'); } catch (_) { return false; } }).catch(() => false);
    if (ok) break;
  }
  await sleep(wait);
}
'''
open('common.mjs','w').write(s)
s=open('s_chan.mjs').read()
s=s.replace("""'[data-channel-action="auto"][data-channel-idx="0"]'""","""'#channel-item-0 [data-channel-action="auto"]'""")
s=s.replace("clip: { x: 0, y: 60, width: 320, height: 660 }, targets","clip: { x: 0, y: 60, width: 660, height: 660 }, targets")
s=s.replace("A(1, 'Visibilité + couleur', 'Visibility + colour', '#channel-item-0 .channel-name', 'right', { dx: 30 })","A(1, 'Afficher / masquer + nom', 'Show / hide + name', '#channel-item-0 .channel-name', 'right', { dx: 70 })")
s=s.replace("'bottom', { dx: -10 })","'right', { dx: 8 })")
s=s.replace("'right', { dx: -150, dy: 0 })","'right', { dx: -10, dy: -40 })")
s=s.replace("'#lbl-mid-0', 'bottom', { dx: 0 }","'#lbl-mid-0', 'right', { dx: 70 }")
s=s.replace("'bottom', { dx: 60, dy: -2 }","'right', { dx: 20 }").replace("'#ch-denoise-0', 'bottom', { dx: 20 }","'#ch-denoise-0', 'right', { dx: 50 }")
s=s.replace("'3d/Embryo-E95-Em2-Pecam1-Sox2', 50000","'3d/Embryo-E95-Em2-Pecam1-Sox2', 8000")
open('s_chan.mjs','w').write(s)
t=open('s_modes2.mjs').read().replace("'3d/Embryo-E95-Em2-Pecam1-Sox2', 50000","'3d/Embryo-E95-Em2-Pecam1-Sox2', 8000"); open('s_modes2.mjs','w').write(t)
t=open('s_live.mjs').read().replace("40000","20000"); open('s_live.mjs','w').write(t)
