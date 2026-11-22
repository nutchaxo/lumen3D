// Shared helpers of the run() bridge table tests (not a test: no `test_` prefix): ij-macro-cmds.js in its own context, the real
// IJViewPure, a translator over the plugin's English strings, and the ImageJ 1.54p fixtures (absent fixture = null).
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { ROOT } from './harness.mjs';
import { DIR, EN, loadViewModules } from './ij_harness.mjs';

export const FIX = path.join(ROOT, 'tests', 'fixtures', 'ij-macro');
export const CMDS_FILE = path.join(DIR, 'ij-macro-cmds.js');

/** { IJMacroOptions, IJMacroCmds } from a fresh context, or null when the file is absent. */
export function loadCmds(sandbox = {}) {
  if (!fs.existsSync(CMDS_FILE)) return null;
  const ctx = Object.assign({ console }, sandbox);
  ctx.self = ctx;
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(CMDS_FILE, 'utf8'), ctx, { filename: 'ij-macro-cmds.js' });
  return { IJMacroOptions: ctx.IJMacroOptions, IJMacroCmds: ctx.IJMacroCmds, ctx };
}

export const IJViewPure = loadViewModules().IJViewPure;

const lookup = (k) => String(k).split('.').reduce((a, c) => (a && a[c] !== undefined ? a[c] : undefined), EN);
/** The page's tr over lang/en.json; a key no file has comes back as the key (the tests check the keys they need exist). */
export function tr(k, p) {
  const v = lookup(k);
  const s = typeof v === 'string' ? v : String(k);
  return s.replace(/\{(\w+)\}/g, (m, n) => (p && p[n] !== undefined ? String(p[n]) : m));
}
export const hasKey = (k) => typeof lookup(k) === 'string';

export function fixture(name) {
  const f = path.join(FIX, name);
  return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null;
}
/** A JSON number of the goldens: NaN / ±Infinity are written as strings. */
export const jnum = (v) => (v === 'NaN' ? NaN : v === 'Infinity' ? Infinity : v === '-Infinity' ? -Infinity : v);
