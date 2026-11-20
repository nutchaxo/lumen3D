#!/usr/bin/env node
// Derives the synchronous twin of the ImageJ macro interpreter (ij-macro-lang.js) mechanically.
//
// The generator code of js/modules/studio/advanced-studio/ij-macro-lang.js (class Interpreter, class
// Functions, the built-ins written as `function*` / `define(...)`) is the ONLY hand-maintained source. This
// script rewrites it into plain functions and writes the result back INTO THE SAME FILE between
//   /* BEGIN GENERATED SYNC TWIN ... */   and   /* END GENERATED SYNC TWIN */
// so the twin can never drift (tests/js/test_ijm_sync_twin.mjs regenerates in memory and compares).
//
//   node tools/gen_ijm_sync.mjs            rewrite the region
//   node tools/gen_ijm_sync.mjs --check    exit 1 when the file's region differs from a fresh generation
//
// What the transformation does (every rule is a text rewrite, nothing is interpreted):
//   *name(...) {...}           ->  name$s(...) {...}             (methods of Interpreter and Functions, installed on
//                                                                  the same prototypes: both paths share ALL state)
//   function* f(...)           ->  function f$s(...)
//   yield* a.b(...)            ->  a.b$s(...)
//   yield SLICE                ->  an abort check every SYNC_TICK_MASK+1 ticks (a sync stretch cannot yield)
//   yield new Sub(gen())       ->  gen$s()                        (native recursion; V8's stack holds ImageJ's 1000 levels)
//   yield promise              ->  syncAwait(promise)             (throws SyncViolation: the analysis keeps a statement that
//                                                                  may await in generator mode, so it is never reached)
//   isIterator(r) ? yield* r : r -> r ; BUILTINS -> BUILTINS_S ; define( -> defineS(
//   a line ending in /*gen-only*/ is dropped; a line `//@twin CODE` becomes CODE
// Anything left over (a `yield`, a `function*`, a generator called without `yield*`) is a hard error here.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

export const TARGET = join(dirname(fileURLToPath(import.meta.url)), '..', 'js', 'modules', 'studio', 'advanced-studio', 'ij-macro-lang.js');
const BEGIN = '/* BEGIN GENERATED SYNC TWIN';
const END = '/* END GENERATED SYNC TWIN */';

const fail = (m) => { throw new Error('gen_ijm_sync: ' + m); };

function classRange(lines, name) {
  const start = lines.findIndex((l) => l === 'class ' + name + ' {');
  if (start < 0) fail('class ' + name + ' not found');
  let end = start + 1;
  while (end < lines.length && lines[end] !== '}') end++;
  if (end >= lines.length) fail('class ' + name + ' has no closing brace at column 0');
  return [start, end];
}

/* The generator methods of a class: { name, text } with the 2-space indentation of the class body. */
function generatorMethods(lines, [start, end]) {
  const out = [];
  for (let i = start + 1; i < end; i++) {
    const m = /^  (\*?)([A-Za-z_$][\w$]*)\(/.exec(lines[i]);
    if (!m) continue;
    let j = i;
    const oneLine = /\}\s*$/.test(lines[i]) && (lines[i].match(/\{/g) || []).length === (lines[i].match(/\}/g) || []).length;
    if (!oneLine) { while (j < end && lines[j] !== '  }') j++; if (j >= end) fail('unterminated method ' + m[2]); }
    if (m[1] === '*') out.push({ name: m[2], text: lines.slice(i, j + 1).join('\n') });
    i = j;
  }
  return out;
}

/* Top-level statements of [from, to): split at lines that begin in column 0 with something other than a closer
 * or a comment continuation. */
function topChunks(lines, from, to) {
  const chunks = [];
  let cur = null;
  for (let i = from; i < to; i++) {
    const l = lines[i];
    const starts = l !== '' && !/^[\s}\])*]/.test(l);
    if (starts) { cur = { from: i, lines: [l] }; chunks.push(cur); } else if (cur) cur.lines.push(l);
  }
  for (const c of chunks) c.text = c.lines.join('\n').replace(/\s+$/, '');
  return chunks;
}

/* Replace `yield EXPR;` (not yield*) by `syncAwait(EXPR);`, EXPR possibly over several lines. */
function rewriteAwaits(text) {
  let out = '';
  let i = 0;
  const re = /\byield\s+(?!\*)/g;
  for (;;) {
    re.lastIndex = i;
    const m = re.exec(text);
    if (!m) { out += text.slice(i); break; }
    if (/^SLICE\b/.test(text.slice(re.lastIndex))) fail('unhandled `yield SLICE` form near: ' + text.slice(m.index - 40, m.index + 40));
    out += text.slice(i, m.index);
    // the expression runs to the first `;` or unmatched `)` at depth 0 (strings are skipped)
    let k = re.lastIndex, depth = 0, q = null;
    for (; k < text.length; k++) {
      const c = text[k];
      if (q) { if (c === '\\') k++; else if (c === q) q = null; continue; }
      if (c === '"' || c === "'" || c === '`') { q = c; continue; }
      if (c === '(' || c === '[' || c === '{') depth++;
      else if (c === ')' || c === ']' || c === '}') { if (depth === 0) break; depth--; }
      else if (c === ';' && depth === 0) break;
    }
    out += 'syncAwait(' + text.slice(re.lastIndex, k) + ')';
    i = k;
  }
  return out;
}

function transform(text, ctx) {
  const { genMethods, genFuncs, funcMethods } = ctx;
  // 1. line markers
  text = text.split('\n').filter((l) => !/\/\*gen-only\*\/\s*$/.test(l)).map((l) => l.replace(/^(\s*)\/\/@twin /, '$1')).join('\n');
  // 2. the cooperative yield points
  text = text.replace(/\(\+\+this\.ticks & TICK_MASK\) === 0\) yield SLICE;/g, '(++this.ticks & SYNC_TICK_MASK) === 0) this.syncCheck();');
  text = text.replace(/yield new Sub\(([^;]*)\);/g, 'yield* $1;');
  // 3. dynamic iterator drives of the dispatch table (twin tables hold plain functions)
  // (syncResult throws SyncViolation for a built-in that returned an iterator instead of a value: never a wrong answer)
  text = text.replace(/isIterator\(r\) \? yield\* r : r/g, 'syncResult(r)').replace(/if \(isIterator\(r\)\) yield\* r;/g, 'syncResult(r);');
  // 4. awaits (before yield* is touched: a `yield` followed by `*` is skipped by the regex)
  text = rewriteAwaits(text);
  // 5. yield* callee(...)  ->  callee$s(...)
  text = text.replace(/yield\*\s+((?:[A-Za-z_$][\w$]*\.)*)([A-Za-z_$][\w$]*)\(/g, (all, path, name) => {
    if (!genMethods.has(name) && !genFuncs.has(name)) fail('yield* of an unknown generator `' + path + name + '` in:\n' + text.slice(0, 200));
    return path + name + '$s(';
  });
  // 6. a generator built-in written as `(f) => f.method(...)` is driven by the dispatcher in the generator path
  text = text.replace(/=> f\.([A-Za-z_$][\w$]*)\(/g, (all, name) => (funcMethods.has(name) ? '=> f.' + name + '$s(' : all));
  // 7. definitions and names
  text = text.replace(/^  \*([A-Za-z_$][\w$]*)\(/gm, '  $1$s(');
  text = text.replace(/\bfunction\* ([A-Za-z_$][\w$]*)\(/g, 'function $1$s(').replace(/\bfunction\*\s*\(/g, 'function (');
  for (const n of genFuncs) text = text.replace(new RegExp('\\b' + n.replace(/\$/g, '\\$') + '\\b(?!\\$)', 'g'), n + '$s');
  text = text.replace(/\bBUILTINS\b(?!_)/g, 'BUILTINS_S').replace(/\bdefine\(/g, 'defineS(');
  // 8. nothing generator-shaped may be left
  const left = /\byield\b|function\*|^\s*\*[A-Za-z_$]|isIterator|new Sub\b/m.exec(text);
  if (left) fail('left over `' + left[0] + '` near: ' + text.slice(Math.max(0, left.index - 60), left.index + 60));
  // 9. a generator method called on an interpreter / Functions receiver without its `$s` twin would return an iterator
  //    object in the twin (a built-in written `(f) => { return f.getArg(); }`, `(fn) => fn.getArg()` ...): refuse it here.
  const names = [...genMethods].map((n) => n.replace(/\$/g, '\\$')).join('|');
  const bare = new RegExp('(?<![\\w$.])(?:f|fn|it|this|this\\.func|this\\.interp|f\\.interp|it\\.func|outer|nested)\\.(?:' + names + ')\\(', 'g');
  const m9 = bare.exec(text);
  if (m9) fail('a generator method is called without `yield*` (its twin would return an iterator): `' + m9[0] + '` near: ' + text.slice(Math.max(0, m9.index - 60), m9.index + 60));
  return text;
}

/* Names whose generators can await (directly, or by calling one that can): the closure the defines are checked against. */
function awaitingNames(units) {
  const awaiting = new Set();
  for (const u of units) if (/\byield\s+(?!\*|SLICE\b|new Sub\b)/.test(u.text)) awaiting.add(u.name);
  for (let changed = true; changed;) {
    changed = false;
    for (const u of units) {
      if (awaiting.has(u.name)) continue;
      for (const a of awaiting) if (new RegExp('\\b' + a + '\\(').test(u.text)) { awaiting.add(u.name); changed = true; break; }
    }
  }
  return awaiting;
}

export function generate(src) {
  const eol = src.includes('\r\n') ? '\r\n' : '\n';
  const lines = src.split(/\r?\n/);
  const [iS, iE] = classRange(lines, 'Interpreter');
  const [fS, fE] = classRange(lines, 'Functions');
  const interpM = generatorMethods(lines, [iS, iE]);
  const funcM = generatorMethods(lines, [fS, fE]);
  const driver = lines.findIndex((l, i) => i > fE && /^ \* The driver\b/.test(l));
  if (driver < 0) fail('"The driver" banner not found');
  const begin = lines.findIndex((l) => l.startsWith(BEGIN));
  const end = lines.findIndex((l) => l === END);
  if (begin < 0 || end < begin) fail('generated-region markers missing');
  if (!(fE < begin && end < driver)) fail('the generated region must sit between class Functions and the driver');
  // everything that is not the generated region is the source
  const srcLines = lines.slice(0, begin).concat(lines.slice(end + 1));
  const rebase = (n) => (n > end ? n - (end - begin + 1) : n);
  void rebase;

  const chunks = topChunks(lines, fE + 1, begin).concat(topChunks(lines, end + 1, driver - 1));
  const genFuncChunks = chunks.filter((c) => /^function\* [A-Za-z_$]/.test(c.text));
  const genFuncs = new Set(genFuncChunks.map((c) => /^function\* ([A-Za-z_$][\w$]*)/.exec(c.text)[1]));
  const genMethods = new Set([...interpM, ...funcM].map((m) => m.name));
  const funcMethods = new Set(funcM.map((m) => m.name));
  const ctx = { genMethods, genFuncs, funcMethods };

  // suspension closure over everything that is a generator
  const units = [...interpM, ...funcM, ...genFuncChunks.map((c) => ({ name: /^function\* ([\w$]+)/.exec(c.text)[1], text: c.text }))];
  const awaiting = awaitingNames(units);
  const defineChunks = chunks.filter((c) => /\bdefine\(/.test(c.text) || /^function\* /.test(c.text));
  const needsSuspend = (t) => /\byield\s+(?!\*)/.test(t) || [...awaiting].some((a) => new RegExp('\\b' + a + '\\(').test(t));
  for (const c of defineChunks) {
    if (!/\bdefine\(/.test(c.text)) continue;
    const where = 'the built-in registered at source line ' + (c.from + 1) + ' (' + c.lines[0].slice(0, 60) + ')';
    if ((c.text.match(/\bdefine\(/g) || []).length > 1) fail(where + ' shares its top-level statement with another define(): one define( per statement, so each carries its own { suspends }');
    if (needsSuspend(c.text) && !/suspends\s*:/.test(c.text))
      fail(where + ' can await (' + [...awaiting].filter((a) => new RegExp('\\b' + a + '\\(').test(c.text)).join(', ') + ') but is not registered with { suspends: ... }');
    // a namespace built-in ({ suspends: { sub: 'host', ... } }): every sub-function that can reach the host must be keyed
    const map = /suspends\s*:\s*\{([^}]*)\}/.exec(c.text);
    if (map) {
      const keys = new Set([...map[1].matchAll(/([A-Za-z_$][\w$]*)\s*:/g)].map((m) => m[1]));
      const labels = [...c.text.matchAll(/case\s+'([\w$]+)'\s*:|\bname\s*===\s*'([\w$]+)'/g)];
      labels.forEach((m, i) => {
        const sub = m[1] || m[2];
        const body = c.text.slice(m.index, i + 1 < labels.length ? labels[i + 1].index : c.text.length);
        if (needsSuspend(body) && !keys.has(sub)) fail(where + ': sub-function `' + sub + '` can reach the host / await but is missing from its { suspends: { ... } } map');
      });
    }
  }

  const out = [];
  out.push(BEGIN + ': written by tools/gen_ijm_sync.mjs from the generator code of this file. GENERATED, DO NOT EDIT.');
  out.push(' * Plain-function twin of class Interpreter / class Functions and of the built-ins, installed on the same prototypes');
  out.push(' * (suffix $s) so both paths share every state object. Run `node tools/gen_ijm_sync.mjs` after any edit above;');
  out.push(' * tests/js/test_ijm_sync_twin.mjs fails when this region is stale. */');
  out.push('Object.assign(Interpreter.prototype, {');
  for (const m of interpM) out.push(transform(m.text, ctx) + ',');
  out.push('});');
  out.push('Object.assign(Functions.prototype, {');
  for (const m of funcM) out.push(transform(m.text, ctx) + ',');
  out.push('});');
  for (const c of chunks) {
    if (!(/^function\* /.test(c.text) || /\bdefine\(/.test(c.text))) continue;
    out.push(transform(c.text, ctx));
  }
  out.push(END);
  const head = lines.slice(0, begin);
  const tail = lines.slice(end + 1);
  void srcLines;
  return head.concat(out, tail).join(eol).split(/\r?\n/).join(eol);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const src = readFileSync(TARGET, 'utf8');
  const next = generate(src);
  if (process.argv.includes('--check')) {
    if (next !== src) { console.error('ij-macro-lang.js: the generated sync twin is stale; run node tools/gen_ijm_sync.mjs'); process.exit(1); }
    console.log('sync twin up to date');
  } else if (next !== src) { writeFileSync(TARGET, next); console.log('sync twin written (' + next.split('\n').length + ' lines)'); }
  else console.log('sync twin already up to date');
}
