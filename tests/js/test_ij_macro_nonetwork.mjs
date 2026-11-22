// Macros never use the network and never reach the site's datasets (INTEGRATION.md §8, user decision U6):
//   • the three macro files (ij-proc-macro.js, ij-macro-cmds.js, ij-cmds-macro.js — the last two may still be absent) contain no
//     fetch / XMLHttpRequest / sendBeacon / WebSocket / EventSource / importScripts / new Worker / window.open / location / E.fetch /
//     eval / new Function / WebAssembly (comments stripped first);
//   • a runtime spy: every built-in family of the runtime corpus (tests/fixtures/ij-macro/runtime), the call() whitelist, the refusals and
//     the page-state built-ins run in the worker with fetch / XMLHttpRequest / WebSocket / EventSource / importScripts / Worker / E.fetch
//     instrumented: zero calls.
//
// Run: node tests/js/test_ij_macro_nonetwork.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './harness.mjs';
import { rt, DIR } from './ij_macro_rt_support.mjs';

// ---- static: the source of the three files
function stripComments(src) {
  let out = '', i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i], d = src[i + 1];
    if (c === '/' && d === '*') { const e = src.indexOf('*/', i + 2); i = e < 0 ? n : e + 2; continue; }
    if (c === '/' && d === '/') { const e = src.indexOf('\n', i + 2); i = e < 0 ? n : e; continue; }
    if (c === "'" || c === '"' || c === '`') {
      const q = c; let j = i + 1;
      while (j < n && src[j] !== q) { if (src[j] === '\\') j++; j++; }
      out += '""'; i = j + 1; continue;   // a string literal (an error text, a refused built-in's name) is never a call
    }
    out += c; i++;
  }
  // property keys (a dialog key named `location`) are data too
  return out.replace(/([{,]\s*)[A-Za-z_$][\w$]*\s*:(?!:)/g, '$1:');
}
const FORBIDDEN = [/\bfetch\s*\(/, /\bXMLHttpRequest\b/, /\bsendBeacon\b/, /\bWebSocket\b/, /\bEventSource\b/, /\bimportScripts\b/, /\bnew\s+Worker\b/,
  /\bwindow\.open\b/, /\blocation\b/, /\bE\.fetch\b/, /\beval\s*\(/, /\bnew\s+Function\b/, /\bWebAssembly\b/];
let checked = 0;
for (const f of ['ij-proc-macro.js', 'ij-macro-cmds.js', 'ij-cmds-macro.js']) {
  const p = path.join(DIR, f);
  if (!fs.existsSync(p)) { console.log('SKIP static check of ' + f + ': absent'); continue; }
  const code = stripComments(fs.readFileSync(p, 'utf8'));
  for (const rx of FORBIDDEN) {
    const m = code.match(rx);
    if (m) {
      const at = code.indexOf(m[0]);
      assert.fail(f + ': forbidden ' + rx + ' in: ' + code.slice(code.lastIndexOf('\n', at) + 1, code.indexOf('\n', at)).trim());
    }
  }
  checked++;
}
assert.ok(checked >= 1);

// ---- runtime spy
const t = await rt();
const W = t.W;
const calls = [];
const spy = (name) => function () { calls.push(name); throw new Error(name + ' is forbidden'); };
W.fetch = spy('fetch');
W.XMLHttpRequest = spy('XMLHttpRequest');
W.WebSocket = spy('WebSocket');
W.EventSource = spy('EventSource');
W.importScripts = spy('importScripts');
W.Worker = spy('Worker');
W.navigator = Object.assign(W.navigator || {}, { sendBeacon: spy('sendBeacon') });

const corpus = path.join(ROOT, 'tests', 'fixtures', 'ij-macro', 'runtime');
const sources = [];
if (fs.existsSync(corpus)) {
  for (const g of fs.readdirSync(corpus).sort()) for (const c of fs.readdirSync(path.join(corpus, g)).sort()) sources.push(fs.readFileSync(path.join(corpus, g, c), 'utf8'));
}
sources.push(
  'print(call("ij.IJ.pad","7","3")); call("ij.Prefs.set","macro.k","v"); print(call("ij.IJ.freeMemory"));',
  'open("https://example.org/x.tif");', 'open("/a.tif");', 'x = File.openUrlAsString("https://example.org");', 'x = exec("curl x");', 'run("URL...", "url=https://x");',
  'x = eval("js", "fetch(1)");', 'x = getDir("home");', 'Ext.foo();', 'x = call("java.net.URL.openStream", "https://x");',
  'newImage("a", "8-bit ramp", 16, 16, 1); makeRectangle(1,1,4,4); roiManager("add"); roiManager("select", 0); setResult("A", 0, 1); updateResults(); Table.create("T"); Table.set("c", 0, 2, "T"); Dialog.create("d"); Dialog.addNumber("n", 1); Dialog.show(); n = Dialog.getNumber(); setThreshold(1, 100); setOption("BlackBackground", true); setTool("oval"); setBatchMode(true); newImage("b", "16-bit black", 4, 4, 3); setBatchMode("exit and display"); close("*");'
);
let runs = 0;
for (const src of sources) {
  await t.run(src);
  runs++;
}
assert.deepEqual(calls, [], 'no network API was touched by ' + runs + ' macros');
t.close();
console.log('test_ij_macro_nonetwork: ok (' + runs + ' macros)');
