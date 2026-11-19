/* ij-cmds-ana.js — menu commands of package ana (wave 3): Process › Repeat Command, Plugins › Utilities › Find Commands, Edit › Options ›
 * Input/Output and Plots. Page only, before IJApp.mount; talks to the app through the documented extension API (IJApp.EXT_API_MEMBERS).
 *
 * The measuring commands themselves (Measure, Analyze Particles, Set Measurements, Histogram, Plot Profile, the Results window) are the rows of ij-app.js:
 * their code reads the settings this file writes (api.settings, prefix `ana.`):
 *   ana.ext (".csv")  ana.copyHeaders (false)  ana.copyRowNumbers (true)  ana.saveHeaders (true)  ana.saveRowNumbers (true)    Input/Output
 *   ana.fixedScale (false)  ana.ymin (0)  ana.ymax (0)  ana.vertical (false)  ana.interpolate (true)                              Plots
 * (ana.decimals and ana.particles belong to Set Measurements and Analyze Particles.)
 *
 *   Repeat Command   ij.Executer: "if (!(cmd.equals("Undo")||cmd.equals("Close"))) previousCommand = cmd;" — the last command runs again through
 *                    api.runCommand: its dialog comes back with the values of that run, nothing is replayed silently.
 *   Find Commands    ij.plugin.CommandFinder: a search field over api.commands(); every word must be part of the command name or of its menu path.
 *   Input/Output…    ij.plugin.Options.io: the Results table subset (the JPEG quality, the transparent index and the file chooser options have no meaning here).
 *   Plots…           ij.plugin.Profiler.doOptions: the Profile Plot subset (the plot size, font size, ticks, auto-close, list values and live plots have none here).
 */
(function () {
  'use strict';
  if (typeof IJApp === 'undefined' || typeof IJApp.extend !== 'function') return;

  const idle = (st) => !!st && !st.busy;

  /** A tiny element builder (the panel is built with the DOM of the page). */
  function el(tag, props) {
    const e = document.createElement(tag);
    if (props) {
      for (const k of Object.keys(props)) {
        const v = props[k];
        if (v === null || v === undefined || v === false) continue;
        if (k === 'class') e.className = v;
        else if (k === 'text') e.textContent = v;
        else if (k === 'on') { for (const ev of Object.keys(v)) e.addEventListener(ev, v[ev]); }
        else if (k === 'attrs') { for (const a of Object.keys(v)) e.setAttribute(a, v[a]); }
        else e[k] = v;
      }
    }
    for (let i = 2; i < arguments.length; i++) {
      const kids = Array.isArray(arguments[i]) ? arguments[i] : [arguments[i]];
      for (const kid of kids) if (kid !== null && kid !== undefined && kid !== false) e.appendChild(typeof kid === 'string' ? document.createTextNode(kid) : kid);
    }
    return e;
  }

  // ── Find Commands ────────────────────────────────────────────────────────────────────────────────────────────────
  /**
   * CommandFinder.populateList: "String[] words = matchingSubstring.toLowerCase().split("\s+"); … if (!(command.contains(word) || menuPath.contains(word)))" —
   * IJAna.searchWords / IJAna.rankMatches. The list is "Arrays.sort(commands)" (CommandFinder.java:472): a plain String sort, upper case before
   * lower case, which is the comparison of two JS strings. → rows { id, label, path, shortcut, enabled }.
   */
  function findMatches(list, text) {
    const A = typeof IJAna !== 'undefined' ? IJAna : null;
    if (!A) return [];
    const words = A.searchWords(text);
    const out = list.filter((c) => A.rankMatches(words, c.label, (c.path || []).join('>')));
    out.sort((a, b) => (String(a.label) < String(b.label) ? -1 : String(a.label) > String(b.label) ? 1 : 0));
    return out;
  }

  function buildFinder(root, papi) {
    const input = el('input', { type: 'text', class: 'ij-search', attrs: { 'aria-label': papi.tr('dlg.ana.findPlaceholder'), placeholder: papi.tr('dlg.ana.findPlaceholder') } });
    const list = el('div', { class: 'ij-list', attrs: { role: 'listbox' } });
    let rows = [], selected = -1;
    const closeBox = el('input', { type: 'checkbox' });
    closeBox.checked = papi.settings.get('ana.findClose') === true;
    function paint() {
      list.textContent = '';
      rows.forEach((c, i) => {
        const item = el('div', {
          class: 'ij-list-row' + (i === selected ? ' is-selected' : '') + (c.enabled ? '' : ' is-disabled'), attrs: { role: 'option', 'aria-selected': i === selected ? 'true' : 'false' },
          on: { click: () => { selected = i; paint(); }, dblclick: () => run(i) }
        },
        el('span', { text: c.label }), el('span', { class: 'ij-note', text: (c.path || []).join(' › ') }), el('span', { class: 'ij-note', text: c.shortcut || '' }));
        item.__row = c;
        list.appendChild(item);
      });
      if (!rows.length) list.appendChild(el('p', { class: 'ij-note', text: papi.tr('dlg.ana.findNone') }));
    }
    function refreshList() {
      rows = findMatches(papi.commands(), input.value);
      if (selected >= rows.length) selected = rows.length - 1;
      paint();
    }
    function run(i) {
      const c = rows[i];
      if (!c || !c.enabled) return;
      papi.settings.set('ana.findClose', !!closeBox.checked);
      papi.toast('dlg.ana.findRunning', { name: c.label });
      Promise.resolve(papi.runCommand(c.id)).catch((err) => papi.error(err));
      if (closeBox.checked) papi.closePanel('findCommands');
    }
    function move(delta) {
      if (!rows.length) return;
      selected = selected < 0 ? (delta > 0 ? 0 : rows.length - 1) : (selected + delta + rows.length) % rows.length;
      paint();
    }
    // CommandFinder.keyPressed: Enter in the field runs the only match; the arrows move into the list; Enter in the list runs the selection; Escape closes
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { if (rows.length === 1) run(0); else if (selected >= 0) run(selected); e.preventDefault && e.preventDefault(); }
      else if (e.key === 'ArrowDown') { move(1); e.preventDefault && e.preventDefault(); }
      else if (e.key === 'ArrowUp') { move(-1); e.preventDefault && e.preventDefault(); }
      else if (e.key === 'Escape') { papi.closePanel('findCommands'); e.stopPropagation && e.stopPropagation(); }
    });
    input.addEventListener('input', () => { selected = -1; refreshList(); });
    root.appendChild(el('div', { class: 'ij-panel-ext' }, input, list,
      el('label', { class: 'ij-check' }, closeBox, el('span', { text: papi.tr('dlg.ana.findCloseAfter') })),
      el('div', { class: 'ij-row' },
        el('button', { type: 'button', class: 'ij-btn ij-btn--primary', text: papi.tr('dlg.ana.findRun'), on: { click: () => run(selected >= 0 ? selected : (rows.length === 1 ? 0 : -1)) } }),
        el('button', { type: 'button', class: 'ij-btn', text: papi.tr('dlg.ana.findCloseButton'), on: { click: () => papi.closePanel('findCommands') } }))));
    refreshList();
    if (typeof input.focus === 'function') input.focus();
    return {
      // the enabled state of the commands follows the images, the selection and the results
      refresh() { refreshList(); },
      dispose() {},
      // for the tests
      _state: () => ({ rows: rows.slice(), selected, input })
    };
  }

  const commands = [
    {
      // Menus.java:207 addItem(process, "Repeat Command", KeyEvent.VK_R, false). Ctrl+R reloads the page: the plain key (PLAN-wave3 §1.1).
      id: 'procRepeatCommand', menu: ['Process'], order: 120, shortcut: 'r', repeatable: false,
      enabled: idle,
      async run(api) {
        const last = api.lastCommand();
        if (!last || !last.id) { api.toast('dlg.ana.repeatNone'); return; }
        await api.runCommand(last.id);
      }
    },
    {
      id: 'utilFindCommands', menu: ['Plugins', 'Utilities'], order: 10, shortcut: 'l',
      enabled: () => true,
      async run(api) { await api.openPanel('findCommands', { focus: true }); }
    },
    {
      // Options.io(): "File extension for tables (.csv, .tsv or .txt):" + the four Results Table Options
      id: 'optInputOutput', menu: ['Edit', 'Options'], order: 80,
      enabled: () => true,
      async run(api) {
        const s = api.settings;
        const v = await api.dialog({
          title: api.tr('dlg.ana.ioTitle'), okLabel: api.tr('dlg.ok'),
          fields: [
            { type: 'string', id: 'ext', labelKey: 'dlg.ana.ioExt', value: String(s.get('ana.ext') || '.csv') },
            { type: 'message', id: 'tableOptions', labelKey: 'dlg.ana.ioTableOptions' },
            { type: 'check', id: 'copyHeaders', labelKey: 'dlg.ana.ioCopyHeaders', value: s.get('ana.copyHeaders') === true },
            { type: 'check', id: 'copyRowNumbers', labelKey: 'dlg.ana.ioCopyRowNumbers', value: s.get('ana.copyRowNumbers') !== false },
            { type: 'check', id: 'saveHeaders', labelKey: 'dlg.ana.ioSaveHeaders', value: s.get('ana.saveHeaders') !== false },
            { type: 'check', id: 'saveRowNumbers', labelKey: 'dlg.ana.ioSaveRowNumbers', value: s.get('ana.saveRowNumbers') !== false }
          ]
        });
        if (!v) return;
        // "if (!extension.startsWith(".")) extension = "." + extension;" — an empty field becomes "." (Options.java:148-151), nothing else is added
        let ext = String(v.ext === undefined || v.ext === null ? '' : v.ext);
        if (!ext.startsWith('.')) ext = '.' + ext;
        s.set('ana.ext', ext);
        s.set('ana.copyHeaders', !!v.copyHeaders);
        s.set('ana.copyRowNumbers', !!v.copyRowNumbers);
        s.set('ana.saveHeaders', !!v.saveHeaders);
        s.set('ana.saveRowNumbers', !!v.saveRowNumbers);
      }
    },
    {
      // Profiler.doOptions(): the Profile Plot options of "Plot Defaults"
      id: 'optPlots', menu: ['Edit', 'Options'], order: 120,
      enabled: () => true,
      async run(api) {
        const s = api.settings;
        const lo0 = Number(s.get('ana.ymin') || 0), hi0 = Number(s.get('ana.ymax') || 0);
        // "boolean fixedScale = ymin!=0.0 || ymax!=0.0; boolean wasFixedScale = fixedScale;"
        const was = lo0 !== 0 || hi0 !== 0;
        const v = await api.dialog({
          title: api.tr('dlg.ana.plotsTitle'), okLabel: api.tr('dlg.ok'),
          fields: [
            { type: 'check', id: 'fixedScale', labelKey: 'dlg.ana.plotsFixed', value: was },
            { type: 'number', id: 'ymin', labelKey: 'dlg.ana.plotsYMin', value: lo0, step: 'any', decimals: 2 },
            { type: 'number', id: 'ymax', labelKey: 'dlg.ana.plotsYMax', value: hi0, step: 'any', decimals: 2 },
            { type: 'check', id: 'vertical', labelKey: 'dlg.ana.plotsVertical', value: s.get('ana.vertical') === true },
            { type: 'check', id: 'interpolate', labelKey: 'dlg.ana.plotsInterpolate', value: s.get('ana.interpolate') !== false }
          ]
        });
        if (!v) return;
        let fixed = !!v.fixedScale, lo = Number(v.ymin), hi = Number(v.ymax);
        // "if (!fixedScale && !wasFixedScale && (ymin!=0.0 || ymax!=0.0)) fixedScale = true;
        //  if (!fixedScale) { ymin = 0.0; ymax = 0.0; } else if (ymin>ymax) { swap }"
        if (!fixed && !was && (lo !== 0 || hi !== 0)) fixed = true;
        if (!fixed) { lo = 0; hi = 0; } else if (lo > hi) { const t = lo; lo = hi; hi = t; }
        s.set('ana.fixedScale', fixed);
        s.set('ana.ymin', lo);
        s.set('ana.ymax', hi);
        s.set('ana.vertical', !!v.vertical);
        s.set('ana.interpolate', !!v.interpolate);
      }
    }
  ];

  IJApp.extend({
    pkg: 'ana',
    commands,
    panels: { findCommands: { titleKey: 'dlg.ana.findTitle', build: buildFinder, defaultSize: { w: 520, h: 360 } } }
  });
})();
