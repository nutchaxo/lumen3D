// Minimal loader for the platform's browser IIFE modules under Node, without a
// browser. Each module is `const Name = (() => { ... })();` in a classic script
// (top-level `const` is NOT attached to the global object), so we append a line
// that copies the binding onto globalThis to retrieve it.
//
// Usage:
//   import { loadModule } from './harness.mjs';
//   const Mod = loadModule('js/core/export-manager.js', 'ExportManager', { Utils });
import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export function loadModule(relPath, globalName, sandbox = {}) {
  const src = readFileSync(path.join(ROOT, relPath), 'utf8');
  const ctx = vm.createContext({ console, setTimeout, clearTimeout, ...sandbox });
  const tail = `\n;globalThis.__MODULE__ = (typeof ${globalName} !== 'undefined') ? ${globalName} : undefined;`;
  vm.runInContext(src + tail, ctx, { filename: relPath });
  return ctx.__MODULE__;
}

// A faithful copy of Utils.escapeHtml (js/core/utils.js) for module stubs.
export function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
