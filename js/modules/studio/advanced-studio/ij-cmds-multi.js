/* ij-cmds-multi.js — menu commands of package P4 (multi): Image Calculator, Split / Merge / Arrange
 * Channels, Rename. Runs on the page only, before IJApp.mount; talks to the app through the documented
 * extension API (IJApp.EXT_API_MEMBERS) and to the worker through the registry operations of
 * ij-proc-multi.js (imageCalculator, splitChannels, mergeChannels, arrangeChannels).
 *
 * Dialogs mirror ImageJ's (ij.plugin.ImageCalculator, RGBStackMerge, ChannelArranger, SimpleCommands.rename):
 *   Image Calculator   Image1, Operation, Image2, Create new window (here: the result is ALWAYS a new image),
 *                      32-bit (float) result; + which channels when the images are multichannel
 *   Merge Channels     C1 (red) ... C7 (yellow) from the open images or *None*, Create composite (always: the
 *                      result is a multichannel image), Keep source images (always: the sources stay open),
 *                      Ignore source LUTs
 *   Arrange Channels   New channel order: a string of digits ("321"); fewer digits drop channels
 *   Rename             Title
 * No operation of this package previews: Image Calculator / Split / Merge create new images, Arrange
 * only reorders channels.
 */
(function () {
  'use strict';
  if (typeof IJApp === 'undefined' || typeof IJApp.extend !== 'function') return;

  const CALC_OPTIONS = [
    { value: 'add', labelKey: 'dlg.multi.opAdd' },
    { value: 'subtract', labelKey: 'dlg.multi.opSubtract' },
    { value: 'multiply', labelKey: 'dlg.multi.opMultiply' },
    { value: 'divide', labelKey: 'dlg.multi.opDivide' },
    { value: 'and', labelKey: 'dlg.multi.opAnd' },
    { value: 'or', labelKey: 'dlg.multi.opOr' },
    { value: 'xor', labelKey: 'dlg.multi.opXor' },
    { value: 'min', labelKey: 'dlg.multi.opMin' },
    { value: 'max', labelKey: 'dlg.multi.opMax' },
    { value: 'average', labelKey: 'dlg.multi.opAverage' },
    { value: 'difference', labelKey: 'dlg.multi.opDifference' },
    { value: 'copy', labelKey: 'dlg.multi.opCopy' },
    { value: 'transparent-zero', labelKey: 'dlg.multi.opZero' }
  ];
  // RGBStackMerge.maxChannels = 7; the slot labels of its dialog ("C1 (red):" ...).
  const SLOT_LABEL_KEYS = ['dlg.multi.c1', 'dlg.multi.c2', 'dlg.multi.c3', 'dlg.multi.c4', 'dlg.multi.c5', 'dlg.multi.c6', 'dlg.multi.c7'];
  const SLOT_WORDS = ['red', 'green', 'blue', 'gray', 'cyan', 'magenta', 'yellow'];
  const MAX_ARRANGE = 9;   // ChannelArranger: "This command does not work with more than 9 channels."

  const nChan = (info) => (info && Array.isArray(info.channels) ? info.channels.length : 0);
  const docsOf = (st) => (st && Array.isArray(st.docs) ? st.docs : []);
  const idle = (st) => !!(st && st.doc) && !st.busy;

  /**
   * RGBStackMerge.getInitialNames: C<n> is pre-filled with the last image whose title starts with "C<n>" (and
   * shares the first title's tail), else the last one naming its colour; no match for C1 switches the
   * pre-fill off. `docs` = [{ docId, name }], returns one docId | null per slot.
   */
  function initialSources(docs) {
    let firstName = null, disabled = false;
    const nameOf = (channel) => {
      if (disabled) return null;
      const str = 'C' + channel;
      let hit = null;
      for (let i = docs.length - 1; i >= 0; i--) {
        const t = docs[i].name;
        if (t.indexOf(str) === 0 && (firstName === null || t.indexOf(firstName) >= 0)) {
          hit = docs[i];
          if (channel === 1) {
            if (t.length < 3) return null;
            firstName = t.substring(3);
          }
          break;
        }
      }
      if (hit === null) {
        for (let i = docs.length - 1; i >= 0; i--) {
          const t = docs[i].name;
          const index = t.indexOf(SLOT_WORDS[channel - 1]);
          if (index !== -1 && (firstName === null || t.indexOf(firstName) >= 0)) {
            hit = docs[i];
            if (channel === 1 && index > 0) firstName = t.substring(0, index - 1);
            break;
          }
        }
      }
      if (channel === 1 && hit === null) disabled = true;
      return hit;
    };
    const out = [];
    for (let channel = 1; channel <= SLOT_LABEL_KEYS.length; channel++) { const h = nameOf(channel); out.push(h ? h.docId : null); }
    return out;
  }

  const commands = [
    {
      id: 'procImageCalculator', menu: ['Process'], order: 100, separatorBefore: true, long: true,
      enabled: (st) => idle(st),
      async run(api) {
        const st = api.state();
        const docs = docsOf(st);
        if (!docs.length) return;
        const byId = new Map(docs.map((d) => [d.docId, d]));
        const count = (id) => nChan(byId.get(id));
        const sameCount = (v) => count(v.image1) === count(v.image2) && count(v.image1) > 1;
        const other = docs.find((d) => st.doc && d.docId !== st.doc.docId) || docs[0];
        const v = await api.dialog({
          title: api.tr('dlg.multi.calcTitle'), okLabel: api.tr('dlg.ok'),
          fields: [
            { type: 'doc', id: 'image1', labelKey: 'dlg.multi.image1' },
            { type: 'choice', id: 'op', labelKey: 'dlg.multi.operation', value: 'add', options: CALC_OPTIONS },
            { type: 'doc', id: 'image2', labelKey: 'dlg.multi.image2', value: other.docId },
            { type: 'check', id: 'allChannels', labelKey: 'dlg.allChannels', value: true, visibleIf: (x) => sameCount(x) },
            { type: 'channel', id: 'channel1', docField: 'image1', labelKey: 'dlg.multi.channel1', visibleIf: (x) => count(x.image1) > 1 && !(sameCount(x) && x.allChannels) },
            { type: 'channel', id: 'channel2', docField: 'image2', labelKey: 'dlg.multi.channel2', value: 0, visibleIf: (x) => count(x.image2) > 1 && !(sameCount(x) && x.allChannels) },
            { type: 'check', id: 'float32', labelKey: 'dlg.multi.float32', value: false },
            {
              type: 'message', id: 'sizeNote', labelKey: 'dlg.multi.sizeNote',
              visibleIf: (x) => { const a = byId.get(x.image1), b = byId.get(x.image2); return !!(a && b && (a.width !== b.width || a.height !== b.height)); }
            },
            { type: 'message', id: 'newWindowNote', labelKey: 'dlg.multi.newWindowNote' }
          ]
        });
        if (!v) return;
        const id1 = v.image1, id2 = v.image2;
        const all = sameCount(v) && v.allChannels !== false;
        // a hidden channel field keeps its initial value, which may not exist in the image picked now
        const pick = (c, id) => (Number.isInteger(c) && c >= 0 && c < count(id) ? c : 0);
        const params = { op: v.op, float32: !!v.float32, all };
        if (!all) { params.channel1 = pick(v.channel1, id1); params.channel2 = pick(v.channel2, id2); }
        // ImageCalculator.calculate on a stack: "Process all N images?" (Yes / No / Cancel, no sentence about Undo — the result is a new image). Image 2 is a single
        // image or a stack of the same length; a hyperstack is processed whole, it asks nothing. A macro answers with the word `stack` (params.stack).
        const a = byId.get(id1), b = byId.get(id2);
        const planesOf = (d) => (d && d.nZ ? d.nZ * d.nT : 1);
        if (a && planesOf(a) > 1) {
          if (planesOf(b) > 1 && planesOf(b) !== planesOf(a)) { const err = new Error('stack depth'); err.code = 'IJ_CALC_STACKS'; throw err; }
          const dimAware = !!a.hyperstack || nChan(a) > 1;
          const answer = dimAware ? 'all' : await api.askStack({ docId: id1, stack: v.stack });
          if (answer === null) return;
          if (answer === 'all') params.slices = 'all';
        }
        // Edit > Options > Misc. "Divide by zero value:" (FloatBlitter.divideByZeroValue): carried only when it is not the default, so
        // a journal written without it replays as before
        const dz = api.settings.get('misc.divZero');
        if (v.op === 'divide' && typeof dz === 'string' && dz.trim().toLowerCase() !== 'infinity') params.divZero = dz;
        // the result opens beside the images it was made from (PLAN-wave3 §2.3)
        await api.run('imageCalculator', params, { docId: id1, docIds: id1 === id2 ? [id1] : [id1, id2], noRoi: true, labelKey: 'op.imageCalculator', placement: 'splitRight' });
      }
    },
    {
      id: 'colorSplitChannels', menu: ['Image', 'Color'], order: 10, long: true,
      enabled: (st) => idle(st) && nChan(st.doc) > 1,
      async run(api) {
        const st = api.state();
        if (!st.doc) return;
        // the source stays open: it and its channels share one grid of views (PLAN-wave3 §2.3)
        await api.run('splitChannels', {}, { docId: st.doc.docId, noRoi: true, labelKey: 'op.splitChannels', placement: 'gridWithSource' });
      }
    },
    {
      id: 'colorMergeChannels', menu: ['Image', 'Color'], order: 20, long: true,
      enabled: (st) => !!st && !st.busy && docsOf(st).filter((d) => nChan(d) === 1).length >= 1,
      async run(api) {
        const st = api.state();
        // RGBStackMerge: "Source hyperstacks cannot have more than 1 channel": only single-channel images are offered.
        const docs = docsOf(st).filter((d) => nChan(d) === 1);
        if (docs.length < 1) return;
        const byId = new Map(docs.map((d) => [d.docId, d]));
        const initial = initialSources(docs);
        const options = [{ value: 'none', labelKey: 'dlg.multi.none' }].concat(docs.map((d) => ({ value: d.docId, label: d.name })));
        const fields = SLOT_LABEL_KEYS.map((labelKey, i) => ({ type: 'choice', id: 'c' + (i + 1), labelKey, options, value: initial[i] === null ? 'none' : initial[i] }));
        fields.push({ type: 'check', id: 'createComposite', ijKey: 'create', labelKey: 'dlg.multi.createComposite', value: true });
        fields.push({ type: 'check', id: 'ignoreLuts', ijKey: 'ignore', labelKey: 'dlg.multi.ignoreLuts', value: false });
        fields.push({ type: 'message', id: 'mergeNote', labelKey: 'dlg.multi.mergeNote' });
        const chosen = (x) => { const out = []; SLOT_LABEL_KEYS.forEach((k, i) => { const id = x['c' + (i + 1)]; if (id !== undefined && id !== 'none') out.push({ docId: id, slot: i }); }); return out; };
        const v = await api.dialog({
          title: api.tr('dlg.multi.mergeTitle'), okLabel: api.tr('dlg.ok'), fields,
          validate(x) {
            const src = chosen(x);
            if (src.length < 2) return { c1: 'dlg.multi.needTwo' };
            const first = byId.get(src[0].docId);
            for (const s of src) {
              const d = byId.get(s.docId);
              if (d.width !== first.width || d.height !== first.height) return { ['c' + (s.slot + 1)]: 'dlg.multi.sizeMismatch' };
              // ImageJ: "The source images must have the same bit depth" only when a composite is made; an RGB merge converts each source
              if (x.createComposite !== false && d.bitDepth !== first.bitDepth) return { ['c' + (s.slot + 1)]: 'dlg.multi.depthMismatch' };
            }
            return null;
          }
        });
        if (!v) return;
        const sources = chosen(v);
        const ids = [];
        for (const s of sources) if (ids.indexOf(s.docId) < 0) ids.push(s.docId);
        await api.run('mergeChannels', { sources, ignoreLuts: !!v.ignoreLuts, rgb: v.createComposite === false }, { docId: sources[0].docId, docIds: ids, noRoi: true, labelKey: 'op.mergeChannels', placement: 'splitRight' });
      }
    },
    {
      id: 'colorArrangeChannels', menu: ['Image', 'Color'], order: 30,
      enabled: (st) => idle(st) && nChan(st.doc) > 1 && nChan(st.doc) <= MAX_ARRANGE,
      async run(api) {
        const st = api.state();
        const info = st.doc;
        if (!info) return;
        const n = nChan(info);
        const identity = Array.from({ length: n }, (_, i) => String(i + 1)).join('');
        // ChannelArranger.textValueChanged: only the digits 1..n, none twice, at most n of them.
        const parse = (text) => {
          const s = String(text || '').trim();
          if (!s.length || s.length > n) return null;
          const seen = new Set();
          const order = [];
          for (const ch of s) {
            const d = ch.charCodeAt(0) - 48;
            if (!(ch >= '0' && ch <= '9') || d < 1 || d > n || seen.has(d)) return null;
            seen.add(d);
            order.push(d - 1);
          }
          return order;
        };
        const v = await api.dialog({
          title: api.tr('dlg.multi.arrangeTitle'), okLabel: api.tr('dlg.ok'),
          fields: [
            { type: 'string', id: 'order', labelKey: 'dlg.multi.newOrder', value: identity },
            { type: 'message', id: 'dropNote', labelKey: 'dlg.multi.dropNote', visibleIf: (x) => { const o = parse(x.order); return !!o && o.length < n; } }
          ],
          validate: (x) => (parse(x.order) ? null : { order: 'dlg.multi.orderInvalid' })
        });
        if (!v) return;
        const order = parse(v.order);
        if (!order) return;
        await api.run('arrangeChannels', { order }, { docId: info.docId, noRoi: true, labelKey: 'op.arrangeChannels' });
      }
    },
    {
      id: 'imageRename', menu: ['Image'], order: 95,
      enabled: (st) => idle(st),
      async run(api) {
        const st = api.state();
        if (!st.doc) return;
        const v = await api.dialog({
          title: api.tr('dlg.multi.renameTitle'), okLabel: api.tr('dlg.ok'),
          fields: [{ type: 'string', id: 'name', labelKey: 'dlg.multi.title', value: st.doc.name }],
          validate: (x) => (String(x.name || '').trim() ? null : { name: 'dlg.multi.nameEmpty' })
        });
        if (!v) return;
        await api.rename(st.doc.docId, String(v.name).trim());
      }
    }
  ];

  IJApp.extend({
    pkg: 'multi',
    commands,
    errors: {
      IJ_MULTI_SINGLE_CHANNEL: 'err.multiSingleChannel',
      IJ_MULTI_NOT_SINGLE: 'err.multiNotSingle',
      IJ_MULTI_DEPTH_MISMATCH: 'err.multiDepthMismatch',
      IJ_CALC_STACKS: 'err.calcStacks',
      IJ_MULTI_NEED_TWO: 'err.multiNeedTwo',
      IJ_MULTI_TOO_MANY: 'err.multiTooMany'
    }
  });
})();
