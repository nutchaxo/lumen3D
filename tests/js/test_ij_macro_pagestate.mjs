// The page-state built-ins of the Advanced Studio macros (js/modules/studio/advanced-studio/ij-proc-macro.js): what a macro reads comes
// from the worker's mirror, what it changes goes to the page as the write-behind ops / RPC methods of INTEGRATION.md §4 — checked here
// against the scripted page of tests/js/ij_macro_rt_support.mjs with the REAL engine:
//   images (select / close patterns / rename / lists / batch mode display rules), selections and Roi.*, the ROI Manager (ImageJ's actions on
//   the mirror, measure composed as roi.set + run), Results and Table.*, thresholds (setAutoThreshold through the engine's threshold code),
//   dialogs (Dialog.*, getNumber / getString / getBoolean, cancel), setOption, setTool, LUTs, display ranges, imageCalculator (a new image and
//   in place), status / progress, text windows, the clipboard, List.setCommands.
//
// Run: node tests/js/test_ij_macro_pagestate.mjs
import assert from 'node:assert/strict';
import { rt, okRun } from './ij_macro_rt_support.mjs';

const J = (x) => JSON.parse(JSON.stringify(x));
const t = await rt();
const ops = (r) => r.writes.map((w) => w[0]);
const reset = async () => {
  for (const im of t.page.images.slice()) { try { await t.ok('doc.close', { docId: im.docId, discard: true }); } catch (_) { /* gone */ } }
  t.page.images = []; t.page.current = null; t.page.selections = {};
  t.page.tables = { Results: { name: 'Results', size: 0, headings: [], columns: {}, labels: null, rev: 1 } };
  t.page.roiManager = { list: [], selected: [], showAll: false, labels: false };
};

// ---- images
{
  await reset();
  let r = await t.run('newImage("a", "8-bit black", 4, 4, 1); newImage("b", "8-bit black", 5, 5, 1); newImage("c", "8-bit black", 6, 6, 1); selectImage("a"); print(getTitle()); selectImage(-2); print(getTitle()); print(nImages);');
  assert.deepEqual(okRun(r, 'select'), ['a', 'b', '3']);
  assert.ok(r.rpc.filter((m) => m === 'image.select').length === 2);
  r = await t.run('selectImage("nope");');
  assert.equal(r.result.error.message, '"nope" not found');
  r = await t.run('selectImage(-99);');
  assert.equal(r.result.error.message, 'Image -99 not found');
  r = await t.run('selectImage("c"); close("\\\\Others"); print(nImages); print(getTitle());');
  assert.deepEqual(okRun(r, 'others'), ['1', 'c']);
  r = await t.run('newImage("x1", "8-bit black", 4, 4, 1); newImage("x2", "8-bit black", 4, 4, 1); newImage("y", "8-bit black", 4, 4, 1); close("x*"); l = getList("image.titles"); print(l.length + " " + l[0] + " " + l[1]);');
  assert.deepEqual(okRun(r, 'wildcard'), ['2 c y']);
  assert.ok(t.page.closedWindows.length === 0, 'a wildcard closes no tool window');
  r = await t.run('close("Log"); close("Results");');
  assert.deepEqual(J(t.page.closedWindows), ['Log', 'Results']);
  r = await t.run('rename("renamed"); print(getTitle()); print(isOpen("renamed"));');
  assert.deepEqual(okRun(r, 'rename'), ['renamed', '1']);
  assert.equal(t.page.images.find((im) => im.docId === t.page.current).title, 'renamed');
  // batch mode: false shows the current image only, "exit and display" shows every batch image (the current one last)
  await reset();
  r = await t.run('setBatchMode(true); newImage("h1", "8-bit black", 4, 4, 1); newImage("h2", "8-bit black", 4, 4, 1); setBatchMode(false);');
  okRun(r, 'batch false');
  assert.deepEqual(J(t.page.images.map((im) => [im.title, im.hidden])), [['h1', true], ['h2', false]]);
  r = await t.run('setBatchMode(true); newImage("h3", "8-bit black", 4, 4, 1); newImage("h4", "8-bit black", 4, 4, 1); selectImage("h3"); setBatchMode("exit and display");');
  okRun(r, 'exit and display');
  const shown = r.rpc.indexOf('image.show');
  assert.ok(shown >= 0);
  assert.deepEqual(J(t.page.images.map((im) => [im.title, im.hidden])), [['h1', false], ['h2', false], ['h3', false], ['h4', false]], 'every batch image shown');
  // the macro's current image is the worker's: a hidden batch image stays current although the page shows another one
  r = await t.run('setBatchMode(true); newImage("hb", "8-bit black", 3, 3, 1); rename("hb2"); showMessage("x"); print(getTitle()); setBatchMode(false);');
  assert.deepEqual(okRun(r, 'batch current'), ['hb2']);
}

// ---- selections and Roi.*
{
  await reset();
  let r = await t.run('newImage("s", "8-bit black", 20, 20, 1); makeRectangle(1, 2, 3, 4); makeOval(2, 2, 5, 5); makeLine(1, 1, 5, 5, 3); makeLine(0, 0, 3, 3, 6, 0); makePolygon(1, 1, 8, 1, 4, 6); makePoint(2.5, 3); makeSelection("angle", newArray(1, 5, 9), newArray(5, 1, 5)); makeSelection("traced", newArray(1, 5, 5), newArray(1, 1, 5)); print(selectionType());');
  assert.deepEqual(okRun(r, 'shapes'), ['4']);
  const rois = r.writes.filter((w) => w[0] === 'roi.set').map((w) => w[1].roi);
  assert.deepEqual(J(rois[0]), { type: 'rect', x: 1, y: 2, w: 3, h: 4 });
  assert.deepEqual(J(rois[1]), { type: 'oval', x: 2, y: 2, w: 5, h: 5 });
  assert.deepEqual(J(rois[2]), { type: 'line', x1: 1, y1: 1, x2: 5, y2: 5, width: 3 });
  assert.deepEqual(J(rois[3]), { type: 'polyline', points: [[0, 0], [3, 3], [6, 0]] });
  assert.deepEqual(J(rois[4]), { type: 'polygon', points: [[1, 1], [8, 1], [4, 6]] });
  assert.deepEqual(J(rois[5]), { type: 'point', points: [[2.5, 3]] });
  assert.deepEqual(J(rois[6]), { type: 'angle', points: [[1, 5], [5, 1], [9, 5]] });
  assert.equal(rois[7].type, 'polygon'); assert.equal(rois[7].ijType, 4);
  r = await t.run('makeRectangle(2, 3, 4, 5); Roi.getBounds(x, y, w, h); print(x+" "+y+" "+w+" "+h); Roi.setStrokeColor("red"); print(Roi.getStrokeColor); Roi.setName("n"); print(Roi.getName); print(Roi.getType); Roi.move(0, 0); Roi.getBounds(x, y, w, h); print(x+" "+y); print(Roi.size); Roi.remove; print(selectionType());');
  assert.deepEqual(okRun(r, 'Roi.*'), ['2 3 4 5', 'red', 'n', 'rectangle', '0 0', '4', '-1']);
  r = await t.run('makeArrow(1, 1, 5, 5);');
  assert.equal(r.result.error.message, 'Arrow selections are not available.');
  r = await t.run('makeRectangle(0, 0, 4, 4, 2);');
  assert.equal(r.result.error.message, 'makeRectangle(…, arcSize) is not available in the browser.');
}

// ---- ROI Manager
{
  let measured = 0;
  t.page.answers.run = (a, page) => {
    if (a.name === 'Measure') {
      measured++;
      const res = page.tables.Results;
      const roi = page.selections[a.current];
      if (res.headings.indexOf('X') < 0) { res.headings.push('X'); res.columns.X = []; }
      res.columns.X.push(roi ? roi.x : -1); res.size++; res.rev++;
    }
    return { status: 'ok', text: '', current: a.current, created: [], closed: [] };
  };
  let r = await t.run('makeRectangle(1,1,2,2); roiManager("add"); makeRectangle(5,5,2,2); roiManager("add"); print(roiManager("count")); roiManager("select", 1); print(roiManager("index")); roiManager("rename", "second"); print(RoiManager.getName(1)); print(call("ij.plugin.frame.RoiManager.getName", 1)); roiManager("deselect"); roiManager("measure"); print(nResults); print(getResult("X", 1));');
  assert.deepEqual(okRun(r, 'roi manager'), ['2', '1', 'second', 'second', '2', '5']);
  assert.equal(measured, 2, 'measure = roi.set + run("Measure") per entry');
  assert.equal(t.page.roiManager.list.length, 2);
  assert.equal(t.page.roiManager.list[0].name, '0002-0002', 'RoiManager.getLabel of an unnamed ROI');
  r = await t.run('roiManager("select", 0); roiManager("delete"); print(roiManager("count")); roiManager("reset"); print(RoiManager.size);');
  assert.deepEqual(okRun(r, 'delete'), ['1', '0']);
  r = await t.run('roiManager("select", 3);');
  assert.equal(r.result.error.message, 'Index (3) is outside of the 0--1 range');
  r = await t.run('roiManager("open", "/a.zip");');
  assert.match(r.result.error.message, /^roiManager\("open"\) is not available yet/);
  r = await t.run('makeRectangle(0,0,0,0); roiManager("add");');
  assert.equal(r.result.error.message, 'The active image does not have a selection.');
  delete t.page.answers.run;
}

// ---- Results and Table.*
{
  t.page.tables.Results = { name: 'Results', size: 0, headings: [], columns: {}, labels: null, rev: 7 };
  let r = await t.run('setResult("A", 0, 1); setResult("B", 0, 2); setResult("A", 1, 3); print(String.getResultsHeadings); IJ.deleteRows(0, 0); print(nResults); print(getResult("A", 0)); IJ.renameResults("Old"); print(nResults); print(Table.size("Old"));');
  assert.deepEqual(okRun(r, 'results'), ['A\tB', '1', '3', '0', '1']);
  assert.ok(t.page.tables.Old && t.page.tables.Old.size === 1);
  r = await t.run('Table.create("T"); Table.set("v", 0, 3); Table.set("v", 1, 1); Table.set("v", 2, 2); Table.set("s", 0, "x"); Table.sort("v"); c = Table.getColumn("v"); print(c[0]+" "+c[1]+" "+c[2]); print(Table.getString("s", 2)); print(Table.title); print(Table.headings); print(Table.columnExists("v")); Table.renameColumn("v", "w"); print(Table.headings); Table.deleteRows(0, 1); print(Table.size); Table.deleteColumn("s"); print(Table.headings);');
  assert.deepEqual(okRun(r, 'Table.*'), ['1 2 3', 'x', 'T', 'v\ts', '1', 'w\ts', '1', 'w']);
  assert.deepEqual(J(t.page.tables.T.columns.w), [3]);
  r = await t.run('x = Table.get("nope", 0, "Missing");');
  assert.equal(r.result.error.message, '"Missing" table not found');
  r = await t.run('Table.save("/x.csv");');
  assert.match(r.result.error.message, /^Table\.save is not available yet/);
  r = await t.run('Array.show("arr", newArray(1, 2, 3));');
  okRun(r, 'Array.show');
  assert.deepEqual(J(t.page.tables.arr.columns.Value), [1, 2, 3]);
}

// ---- thresholds, options, tools, LUTs, ranges, status
{
  await reset();
  let r = await t.run('newImage("t", "8-bit ramp", 64, 4, 1); setThreshold(10, 200, "black & white"); getThreshold(l, u); print(l+" "+u); setOption("BlackBackground", true); setOption("Area", false); setOption("Show All", true); setTool("polygon"); print(toolID); showStatus("hello"); showProgress(1, 4);');
  assert.deepEqual(okRun(r, 'state'), ['10 200', '2']);
  assert.deepEqual(J(ops(r)), ['thr.set', 'thr.mode', 'setting.set', 'measurements.set', 'rm.show', 'tool.set', 'status.show', 'progress.show']);
  assert.equal(t.page.settings['thr.blackBackground'], true);
  assert.ok(t.page.measurements.groups.indexOf('area') < 0);
  assert.equal(t.page.thrMode, 'bw');
  assert.deepEqual(J(t.page.progress), [0.5]);
  r = await t.run('setOption("NoSuchOption", true);');
  assert.equal(r.result.error.message, 'Invalid option');
  r = await t.run('setOption("ExpandableArrays", true); setOption("QueueMacros", true); print("ok");');
  assert.deepEqual(okRun(r, 'noop options'), ['ok']);
  // the page changes the threshold (a waitForUser in the Threshold window): the next mirror carries it
  t.page.answers['dialog.waitForUser'] = (a, page) => { page.thresholds[page.current] = { 0: { lower: 3, upper: 4, dark: false } }; return { ok: true }; };
  r = await t.run('waitForUser("adjust"); getThreshold(l, u); print(l+" "+u);');
  delete t.page.answers['dialog.waitForUser'];
  assert.deepEqual(okRun(r, 'mirror after waitForUser'), ['3 4']);
  // setAutoThreshold through the engine's threshold code
  const id = t.page.current;
  r = await t.run('setAutoThreshold("Otsu dark"); getThreshold(l, u); print(l+" "+u);');
  const want = await t.ok('doc.threshold', { docId: id, channel: 0, method: 'Otsu', dark: true });
  assert.deepEqual(okRun(r, 'auto threshold'), [want.lower + ' ' + want.upper]);
  r = await t.run('setAutoThreshold("Nope");');
  assert.equal(r.result.error.message, 'Invalid method ("Nope")');
  // LUT / range
  r = await t.run('r = newArray(256); g = newArray(256); b = newArray(256); for (i=0;i<256;i++) { r[i]=i; g[i]=0; b[i]=255-i; } setLut(r, g, b); getLut(r2, g2, b2); print(r2[10]+" "+g2[10]+" "+b2[10]); setMinAndMax(5, 99); getMinAndMax(lo, hi); print(lo+" "+hi);');
  assert.deepEqual(okRun(r, 'lut'), ['10 0 245', '5 99']);
  assert.deepEqual(J(ops(r)), ['display.lut', 'display.set']);
  assert.equal(r.writes[0][1].table.length, 768);
  const info = await t.ok('doc.info', { docId: id });
  assert.equal((info.info || info).channels[0].display.max, 99, 'the range reached the engine through the page');
}

// ---- dialogs
{
  let spec = null;
  t.page.answers['dialog.show'] = (a) => { spec = a; return { values: { f0: 7.5, f1: 'typed', f2: false, f3: 'b', f4: 'two' } }; };
  let r = await t.run('Dialog.create("Opts"); Dialog.addNumber("Size:", 3); Dialog.addString("Name:", "abc"); Dialog.addCheckbox("Go", true); Dialog.addChoice("Mode", newArray("a", "b")); Dialog.addRadioButtonGroup("Pick", newArray("one", "two"), 1, 2, "one"); Dialog.addMessage("note"); Dialog.show(); print(Dialog.getNumber()); print(Dialog.getString()); print(Dialog.getCheckbox()); print(Dialog.getChoice()); print(Dialog.getRadioButton());');
  delete t.page.answers['dialog.show'];
  assert.deepEqual(okRun(r, 'dialog'), ['7.5', 'typed', '0', 'b', 'two']);
  assert.equal(spec.title, 'Opts');
  assert.equal(spec.cancel, true);
  assert.deepEqual(J(spec.fields.map((f) => [f.id, f.type, f.label])), [['f0', 'number', 'Size:'], ['f1', 'string', 'Name:'], ['f2', 'check', 'Go'], ['f3', 'choice', 'Mode'], ['f4', 'radio', 'Pick'], ['f5', 'message', 'note']]);
  assert.equal(spec.fields[0].decimals, 0);
  r = await t.run('Dialog.create("x"); Dialog.addNumber("n", 1); Dialog.show(); a = Dialog.getNumber(); b = Dialog.getNumber();');
  assert.equal(r.result.error.message, 'Dialog error', 'a read past the last field');
  t.page.answers['dialog.show'] = () => ({ cancelled: true });
  r = await t.run('Dialog.create("x"); Dialog.show(); print("after");');
  delete t.page.answers['dialog.show'];
  assert.equal(r.result.aborted, true, 'Cancel stops the macro ("Macro canceled")');
  assert.deepEqual(r.log, []);
  t.page.answers['dialog.number'] = () => ({ cancelled: true });
  r = await t.run('v = getNumber("n", 4); print("after");');
  delete t.page.answers['dialog.number'];
  assert.deepEqual(r.log, [], 'getNumber cancelled: the macro stops (interp.done)');
  r = await t.run('v = getBoolean("ok?"); print(v); s = getString("s", "d"); print(s);');
  assert.deepEqual(okRun(r, 'boolean/string'), ['1', 'd']);
  r = await t.run('Dialog.addNumber("n", 1);');
  assert.equal(r.result.error.message, 'No dialog created with Dialog.create()');
  r = await t.run('Dialog.create("x"); Dialog.nope();');
  assert.equal(r.result.error.message, 'Unrecognized Dialog function nope');
}

// ---- text windows, clipboard, commands
{
  let r = await t.run('print("[Notes]", "hello"); String.show("shown"); String.copy("clip"); List.setCommands; print(List.get("Invert"));');
  assert.deepEqual(okRun(r, 'windows'), ['core']);
  assert.deepEqual(J(t.page.printed.slice(-2)), [['Notes', 'hello'], ['Untitled', 'shown']]);
  t.page.answers['clipboard.copy'] = () => ({ ok: false });
  r = await t.run('String.copy("x");');
  delete t.page.answers['clipboard.copy'];
  assert.equal(r.result.error.message, 'The clipboard can only be used from a click.');
  r = await t.run('s = String.paste;');
  assert.equal(r.result.error.message, 'The clipboard can only be used from a click.');
}

// ---- imageCalculator (the op of Image Calculator…, package multi)
{
  await reset();
  let r = await t.run('newImage("p", "8-bit black", 4, 4, 1); setPixel(0, 0, 100); newImage("q", "8-bit black", 4, 4, 1); setPixel(0, 0, 50); imageCalculator("Add create", "p", "q"); print(getTitle()); print(getPixel(0, 0)); print(nImages);');
  const out = okRun(r, 'calculator create');
  assert.notEqual(out[0], 'q', 'the result is the current image');
  assert.equal(out[1], '150');
  assert.equal(out[2], '3', 'a new image');
  r = await t.run('imageCalculator("Subtract", "p", "q"); selectImage("p"); print(getPixel(0, 0)); print(nImages);');
  assert.deepEqual(okRun(r, 'calculator in place'), ['50', '3'], 'image 1 changed in place, no new image left');
  r = await t.run('imageCalculator("Nonsense", "p", "q");');
  okRun(r, 'calculator no operator');
  assert.equal(t.page.dialogs[t.page.dialogs.length - 1][1].text, 'No valid operator');
  r = await t.run('imageCalculator("Add", "p", "zz");');
  assert.equal(r.result.error.message, 'Image not found');
}
t.close();
console.log('test_ij_macro_pagestate: ok');
