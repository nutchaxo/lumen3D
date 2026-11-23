/* ij-macro-params.js — IJMacroParams: SciJava script parameters (`#@`) of ImageJ macros, and the macro sets of
 * Plugins › Macros › Install (DOCS/studio-advanced/macros/EXTRAS.md §6, §7).
 *
 * Classic script, page AND engine worker (the third `pre` file of package `macro`) and Node: pure, no DOM, no IndexedDB, no
 * network. Two halves:
 *
 *   `#@` parameters follow Fiji (ImageJ 2.18.0, imagej-legacy 3.0.0, scijava-common 2.101.0), observed by running its public API
 *   (ScriptInfo, ScriptService.run with the IJ1 macro engine): which lines are parameters, the attribute grammar, type
 *   resolution, defaults and conversions, the widget label, and the text the IJ1 macro engine actually runs (a prefix on line 1,
 *   an initialisation function appended after the script).
 *     parse(source) → Parsed            check(parsed, ctx?) → [{ key, params }]
 *     dialogSpec(parsed, ctx) → spec    valuesOf(parsed, dialogValues) → { values, problems }
 *     persistId(name)                   persistable(parsed) → [name]
 *     headlessValues(parsed, persisted) → { [name]: value }        missing(parsed, values) → [name]
 *     inject(parsed, values, ctx) → source                          outputs(parsed) → [name]
 *     formatOutput(parsed, name, v) → string                        javaDoubleString(x) / javaFloatString(x)
 *
 *   Macro sets follow ImageJ 1.54p (ij.plugin.MacroInstaller.install / addShortcut, ij.Menus.convertShortcutToCode) and the
 *   tokenizer of ij.macro.Tokenizer (java.io.StreamTokenizer configured for macros):
 *     scanMacros(source) → [{ name, line, index }]                  installPlan(source, opts) → Plan
 */
(function (root) {
  'use strict';

  // ════════════════════════════════════════════════════════════════════════════════════════════════
  //  Java number text
  // ════════════════════════════════════════════════════════════════════════════════════════════════

  /** Shortest decimal digits of x and the decimal exponent of the first one (x = 0.d1d2… × 10^(exp+1)). */
  function digitsOf(text) {
    const m = /^(\d)(?:\.(\d+))?e([+-]\d+)$/.exec(text);
    return { digits: (m[1] + (m[2] || '')).replace(/0+$/, '') || '0', exp: Number(m[3]) };
  }
  /** Java's Double.toString / Float.toString layout (JDK 19+: shortest digits) from shortest digits. */
  function javaLayout(neg, digits, exp) {
    const sign = neg ? '-' : '';
    if (exp >= -3 && exp < 7) {
      if (exp >= 0) {
        const intPart = digits.length > exp + 1 ? digits.slice(0, exp + 1) : digits + '0'.repeat(exp + 1 - digits.length);
        const frac = digits.length > exp + 1 ? digits.slice(exp + 1) : '0';
        return sign + intPart + '.' + frac;
      }
      return sign + '0.' + '0'.repeat(-exp - 1) + digits;
    }
    return sign + digits[0] + '.' + (digits.length > 1 ? digits.slice(1) : '0') + 'E' + exp;
  }
  function javaDoubleString(x) {
    x = Number(x);
    if (Number.isNaN(x)) return 'NaN';
    if (x === Infinity) return 'Infinity';
    if (x === -Infinity) return '-Infinity';
    if (x === 0) return Object.is(x, -0) ? '-0.0' : '0.0';
    const d = digitsOf(Math.abs(x).toExponential());
    return javaLayout(x < 0, d.digits, d.exp);
  }
  function javaFloatString(x) {
    const f = Math.fround(Number(x));
    if (Number.isNaN(f) || !Number.isFinite(f) || f === 0) return javaDoubleString(f);
    const a = Math.abs(f);
    let text = a.toExponential();
    for (let p = 1; p <= 9; p++) {
      const t = a.toExponential(p - 1);
      if (Math.fround(Number(t)) === a) { text = t; break; }
    }
    const d = digitsOf(text);
    return javaLayout(f < 0, d.digits, d.exp);
  }

  // ════════════════════════════════════════════════════════════════════════════════════════════════
  //  Types (Fiji's ScriptService resolution: simple names it aliases, fully qualified names, primitives)
  // ════════════════════════════════════════════════════════════════════════════════════════════════

  const INT = (bits) => ({ kind: 'number', integer: true, bits });
  const TYPES = {
    'int': ['int', INT(32)], 'Integer': ['java.lang.Integer', INT(32)],
    'long': ['long', INT(64)], 'Long': ['java.lang.Long', INT(64)],
    'short': ['short', INT(16)], 'Short': ['java.lang.Short', INT(16)],
    'byte': ['byte', INT(8)], 'Byte': ['java.lang.Byte', INT(8)],
    'BigInteger': ['java.math.BigInteger', INT(0)],
    'float': ['float', { kind: 'number', integer: false, float: true }], 'Float': ['java.lang.Float', { kind: 'number', integer: false, float: true }],
    'double': ['double', { kind: 'number', integer: false }], 'Double': ['java.lang.Double', { kind: 'number', integer: false }],
    'BigDecimal': ['java.math.BigDecimal', { kind: 'number', integer: false, big: true }],
    'String': ['java.lang.String', { kind: 'string' }], 'string': ['java.lang.String', { kind: 'string' }],
    'boolean': ['boolean', { kind: 'boolean' }], 'Boolean': ['java.lang.Boolean', { kind: 'boolean' }],
    'File': ['java.io.File', { kind: 'file' }],
    'ColorRGB': ['org.scijava.util.ColorRGB', { kind: 'color' }],
    'ImagePlus': ['ij.ImagePlus', { kind: 'image' }], 'Dataset': ['net.imagej.Dataset', { kind: 'image', byTitle: true }],
    'char': ['char', { kind: 'char' }], 'Character': ['java.lang.Character', { kind: 'char' }],
    // resolved by Fiji, no browser meaning (an ImgPlus reaches a macro as an object identity string, "net.imagej.ImgPlus@1a2b")
    'ImgPlus': ['net.imagej.ImgPlus', { kind: 'unknown' }],
    'Date': ['java.util.Date', { kind: 'unknown' }], 'Number': ['java.lang.Number', { kind: 'unknown' }],
    'Object': ['java.lang.Object', { kind: 'unknown' }], 'ColorRGBA': ['org.scijava.util.ColorRGBA', { kind: 'unknown' }],
    'Img': ['net.imglib2.img.Img', { kind: 'unknown' }], 'ImageDisplay': ['net.imagej.display.ImageDisplay', { kind: 'unknown' }],
    'DatasetView': ['net.imagej.display.DatasetView', { kind: 'unknown' }], 'Overlay': ['net.imagej.overlay.Overlay', { kind: 'unknown' }],
    'RoiManager': ['ij.plugin.frame.RoiManager', { kind: 'unknown' }], 'ResultsTable': ['ij.measure.ResultsTable', { kind: 'unknown' }],
    'Context': ['org.scijava.Context', { kind: 'service' }], 'Logger': ['org.scijava.log.Logger', { kind: 'service' }]
  };
  const FQCN = {};
  for (const k of Object.keys(TYPES)) if (TYPES[k][0].indexOf('.') > 0) FQCN[TYPES[k][0]] = k;
  const SERVICE_PKG = {
    UIService: 'org.scijava.ui', LogService: 'org.scijava.log', StatusService: 'org.scijava.app', CommandService: 'org.scijava.command',
    ScriptService: 'org.scijava.script', PluginService: 'org.scijava.plugin', OpService: 'net.imagej.ops', DatasetService: 'net.imagej',
    ConvertService: 'org.scijava.convert', DisplayService: 'org.scijava.display', ModuleService: 'org.scijava.module',
    PrefService: 'org.scijava.prefs', IOService: 'org.scijava.io', ThreadService: 'org.scijava.thread', EventService: 'org.scijava.event'
  };

  /** { java, kind, integer?, bits?, float?, big? } | null (Fiji: "Ignoring invalid parameter", the line is dropped). */
  function resolveType(declared) {
    let t = String(declared);
    if (/\[\]$/.test(t)) {
      const dims = (t.match(/(\[\])+$/)[0].length) / 2;
      const base = resolveType(t.replace(/(\[\])+$/, ''));
      if (!base) return null;
      const prim = { int: 'I', long: 'J', short: 'S', byte: 'B', float: 'F', double: 'D', boolean: 'Z', char: 'C' }[base.java];
      return { java: '['.repeat(dims) + (prim || 'L' + base.java + ';'), kind: 'unknown' };
    }
    if (TYPES[t]) return Object.assign({ java: TYPES[t][0] }, TYPES[t][1]);
    if (FQCN[t]) return Object.assign({ java: t }, TYPES[FQCN[t]][1]);
    const simple = t.slice(t.lastIndexOf('.') + 1);
    if (/Service$/.test(simple) && /^[A-Za-z_][\w.]*$/.test(t))
      return { java: t.indexOf('.') > 0 ? t : (SERVICE_PKG[t] ? SERVICE_PKG[t] + '.' : '') + t, kind: 'service' };
    if (/^java\.lang\.[A-Z]\w*$/.test(t) && TYPES[simple]) return Object.assign({ java: t }, TYPES[simple][1]);
    if (/^[a-z_]\w*(\.[a-z_]\w*)+\.[A-Z]\w*$/.test(t)) return { java: t, kind: 'unknown' };
    return null;
  }

  // ════════════════════════════════════════════════════════════════════════════════════════════════
  //  Attribute lists: `(key=value, …)`, evaluated like SciJava's ParseService (Parsington): numbers, strings with Java escapes,
  //  bare identifiers (their own name), {lists}, unary +/-, arithmetic, string concatenation with +. A malformed list makes
  //  the whole script unreadable in Fiji (ScriptInfo throws), never just the line.
  // ════════════════════════════════════════════════════════════════════════════════════════════════

  class AttrError extends Error { constructor(msg) { super(msg); this.name = 'AttrError'; } }
  const num = (v, int) => ({ t: 'n', v, int: !!int });
  const str = (v) => ({ t: 's', v });

  function lexAttrs(text) {
    const toks = [];
    let i = 0;
    const n = text.length;
    while (i < n) {
      const c = text[i];
      if (/\s/.test(c)) { i++; continue; }
      const rest = text.slice(i);
      let m;
      if ((m = /^0[xX][0-9a-fA-F]+[lL]?/.exec(rest))) {
        toks.push({ k: 'v', val: num(parseInt(m[0].replace(/[lL]$/, ''), 16), true) }); i += m[0].length; continue;
      }
      if ((m = /^0[bB][01]+[lL]?/.exec(rest))) {
        toks.push({ k: 'v', val: num(parseInt(m[0].slice(2).replace(/[lL]$/, ''), 2), true) }); i += m[0].length; continue;
      }
      if ((m = /^(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?([lLfFdD])?/.exec(rest))) {
        const body = m[1] + (m[2] || ''), suf = (m[3] || '').toLowerCase();
        const isInt = !/[.eE]/.test(body) && (suf === '' || suf === 'l');
        let v = Number(body);
        if (suf === 'f') v = Math.fround(v);
        toks.push({ k: 'v', val: num(v, isInt) }); i += m[0].length; continue;
      }
      if (c === '"' || c === "'") {
        let s = '', j = i + 1, closed = false;
        while (j < n) {
          const d = text[j];
          if (d === c) { closed = true; j++; break; }
          if (d === '\\') {
            const e = text[j + 1];
            const map = { b: '\b', t: '\t', n: '\n', f: '\f', r: '\r', '"': '"', "'": "'", '\\': '\\' };
            if (e !== undefined && Object.prototype.hasOwnProperty.call(map, e)) { s += map[e]; j += 2; continue; }
            throw new AttrError('Invalid escape sequence at index ' + j);
          }
          s += d; j++;
        }
        if (!closed) throw new AttrError('Unclosed string literal at index ' + i);
        toks.push({ k: 'v', val: str(s) }); i = j; continue;
      }
      if ((m = /^[A-Za-z_$][\w$]*/.exec(rest))) { toks.push({ k: 'id', name: m[0] }); i += m[0].length; continue; }
      if ('=,{}()+-*/%^'.indexOf(c) >= 0) { toks.push({ k: c }); i++; continue; }
      throw new AttrError('Invalid character at index ' + i);
    }
    toks.push({ k: 'end' });
    return toks;
  }

  function javaText(v) {
    if (v.t === 's') return v.v;
    if (v.t === 'n') return v.int ? String(v.v) : javaDoubleString(v.v);
    if (v.t === 'l') return '[' + v.v.map(javaText).join(', ') + ']';
    return String(v.v);
  }

  function parseAttrs(text) {
    const toks = lexAttrs(text);
    let p = 0;
    const peek = () => toks[p], next = () => toks[p++];
    const expect = (k) => { if (peek().k !== k) throw new AttrError('Expected ' + k); p++; };
    function primary() {
      const t = next();
      if (t.k === 'v') return t.val;
      if (t.k === 'id') return str(t.name);
      if (t.k === '(') { const v = assign(); expect(')'); return v; }
      if (t.k === '{') {
        const items = [];
        if (peek().k !== '}') {
          items.push(assign());
          while (peek().k === ',') { p++; if (peek().k === '}') break; items.push(assign()); }
        }
        expect('}');
        return { t: 'l', v: items };
      }
      if (t.k === '-' || t.k === '+') {
        const v = unary(t.k);
        return v;
      }
      throw new AttrError('Unexpected token');
    }
    function unary(op) {
      const v = power();
      if (v.t !== 'n') throw new AttrError('Unary ' + op + ' on a non-number');
      return op === '-' ? num(-v.v, v.int) : v;
    }
    function power() {
      const a = primary();
      if (peek().k === '^') {
        p++;
        const b = power();
        if (a.t !== 'n' || b.t !== 'n') throw new AttrError('^ on a non-number');
        return num(Math.pow(a.v, b.v), a.int && b.int && b.v >= 0);
      }
      return a;
    }
    function mul() {
      let a = power();
      while (peek().k === '*' || peek().k === '/' || peek().k === '%') {
        const op = next().k, b = power();
        if (a.t !== 'n' || b.t !== 'n') throw new AttrError(op + ' on a non-number');
        const int = a.int && b.int;
        if (op === '*') a = num(int ? Math.trunc(a.v * b.v) : a.v * b.v, int);
        else if (op === '/') {
          if (int && b.v === 0) throw new AttrError('/ by zero');
          a = num(int ? Math.trunc(a.v / b.v) : a.v / b.v, int);
        } else a = num(int ? a.v % b.v : a.v % b.v, int);
      }
      return a;
    }
    function add() {
      let a = mul();
      while (peek().k === '+' || peek().k === '-') {
        const op = next().k, b = mul();
        if (op === '+' && (a.t === 's' || b.t === 's') && a.t !== 'l' && b.t !== 'l') { a = str(javaText(a) + javaText(b)); continue; }
        if (a.t !== 'n' || b.t !== 'n') throw new AttrError(op + ' on a non-number');
        a = num(op === '+' ? a.v + b.v : a.v - b.v, a.int && b.int);
      }
      return a;
    }
    function assign() {
      if (peek().k === 'id' && toks[p + 1].k === '=') {
        const key = next().name; p++;
        const v = assign();
        return { t: 'a', key, v };
      }
      return add();
    }
    const out = [];
    if (peek().k !== 'end') {
      out.push(assign());
      while (peek().k === ',') { p++; if (peek().k === 'end') break; out.push(assign()); }
    }
    if (peek().k !== 'end') throw new AttrError('Invalid character');
    const map = new Map();
    for (const it of out) {
      if (it.t !== 'a') continue;
      let v = it.v;
      while (v.t === 'a') v = v.v;
      map.set(it.key.toLowerCase(), v);
    }
    return map;
  }

  // ════════════════════════════════════════════════════════════════════════════════════════════════
  //  Conversions to an item's type (SciJava ConvertService as observed: Integer from 3.7 → 3, Byte from 300 → 44, String from
  //  3 → "3" and from 3.0 → "3.0", Boolean from text = Boolean.parseBoolean, an unconvertible text → no value)
  // ════════════════════════════════════════════════════════════════════════════════════════════════

  function narrow(v, bits) {
    const t = Math.trunc(v);
    if (bits === 32) return t | 0;
    if (bits === 16) return ((t | 0) << 16) >> 16;
    if (bits === 8) return ((t | 0) << 24) >> 24;
    return t;
  }
  function toNumber(v, item) {
    if (!v) return null;
    let x;
    if (v.t === 'n') x = v.v;
    else if (v.t === 's') {
      const s = v.v.trim();
      if (item.integer ? !/^[+-]?\d+$/.test(s) : !/^[+-]?(NaN|Infinity|(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?[fFdD]?)$/.test(s)) return null;
      x = Number(s.replace(/[fFdD]$/, ''));
    } else return null;
    if (item.integer) return Number.isFinite(x) ? narrow(x, item.bits) : null;
    return item.float ? Math.fround(x) : x;
  }
  const parseBool = (s) => String(s).toLowerCase() === 'true';

  const CSS_COLORS = (
    'aliceblue:f0f8ff antiquewhite:faebd7 aqua:00ffff aquamarine:7fffd4 azure:f0ffff beige:f5f5dc bisque:ffe4c4 black:000000 ' +
    'blanchedalmond:ffebcd blue:0000ff blueviolet:8a2be2 brown:a52a2a burlywood:deb887 cadetblue:5f9ea0 chartreuse:7fff00 ' +
    'chocolate:d2691e coral:ff7f50 cornflowerblue:6495ed cornsilk:fff8dc crimson:dc143c cyan:00ffff darkblue:00008b ' +
    'darkcyan:008b8b darkgoldenrod:b8860b darkgray:a9a9a9 darkgreen:006400 darkgrey:a9a9a9 darkkhaki:bdb76b darkmagenta:8b008b ' +
    'darkolivegreen:556b2f darkorange:ff8c00 darkorchid:9932cc darkred:8b0000 darksalmon:e9967a darkseagreen:8fbc8f ' +
    'darkslateblue:483d8b darkslategray:2f4f4f darkslategrey:2f4f4f darkturquoise:00ced1 darkviolet:9400d3 deeppink:ff1493 ' +
    'deepskyblue:00bfff dimgray:696969 dimgrey:696969 dodgerblue:1e90ff firebrick:b22222 floralwhite:fffaf0 forestgreen:228b22 ' +
    'fuchsia:ff00ff gainsboro:dcdcdc ghostwhite:f8f8ff gold:ffd700 goldenrod:daa520 gray:808080 grey:808080 green:008000 ' +
    'greenyellow:adff2f honeydew:f0fff0 hotpink:ff69b4 indianred:cd5c5c indigo:4b0082 ivory:fffff0 khaki:f0e68c lavender:e6e6fa ' +
    'lavenderblush:fff0f5 lawngreen:7cfc00 lemonchiffon:fffacd lightblue:add8e6 lightcoral:f08080 lightcyan:e0ffff ' +
    'lightgoldenrodyellow:fafad2 lightgray:d3d3d3 lightgreen:90ee90 lightgrey:d3d3d3 lightpink:ffb6c1 lightsalmon:ffa07a ' +
    'lightseagreen:20b2aa lightskyblue:87cefa lightslategray:778899 lightslategrey:778899 lightsteelblue:b0c4de lightyellow:ffffe0 ' +
    'lime:00ff00 limegreen:32cd32 linen:faf0e6 magenta:ff00ff maroon:800000 mediumaquamarine:66cdaa mediumblue:0000cd ' +
    'mediumorchid:ba55d3 mediumpurple:9370db mediumseagreen:3cb371 mediumslateblue:7b68ee mediumspringgreen:00fa9a ' +
    'mediumturquoise:48d1cc mediumvioletred:c71585 midnightblue:191970 mintcream:f5fffa mistyrose:ffe4e1 moccasin:ffe4b5 ' +
    'navajowhite:ffdead navy:000080 oldlace:fdf5e6 olive:808000 olivedrab:6b8e23 orange:ffa500 orangered:ff4500 orchid:da70d6 ' +
    'palegoldenrod:eee8aa palegreen:98fb98 paleturquoise:afeeee palevioletred:db7093 papayawhip:ffefd5 peachpuff:ffdab9 ' +
    'peru:cd853f pink:ffc0cb plum:dda0dd powderblue:b0e0e6 purple:800080 red:ff0000 rosybrown:bc8f8f royalblue:4169e1 ' +
    'saddlebrown:8b4513 salmon:fa8072 sandybrown:f4a460 seagreen:2e8b57 seashell:fff5ee sienna:a0522d silver:c0c0c0 ' +
    'skyblue:87ceeb slateblue:6a5acd slategray:708090 slategrey:708090 snow:fffafa springgreen:00ff7f steelblue:4682b4 tan:d2b48c ' +
    'teal:008080 thistle:d8bfd8 tomato:ff6347 turquoise:40e0d0 violet:ee82ee wheat:f5deb3 white:ffffff whitesmoke:f5f5f5 ' +
    'yellow:ffff00 yellowgreen:9acd32').split(' ').reduce((m, e) => { const [k, h] = e.split(':'); m[k] = h; return m; }, Object.create(null));

  const hexRgb = (h) => [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
  /** ColorRGB.fromHTMLColor as observed: lower-case CSS names, #rrggbb / #rgb, else "r,g,b" with each part an int (bad = 0). */
  function colorOf(s) {
    s = String(s);
    if (s === '') return null;
    if (CSS_COLORS[s]) return hexRgb(CSS_COLORS[s]);
    if (/^#[0-9a-fA-F]{6}$/.test(s)) return hexRgb(s.slice(1));
    if (/^#[0-9a-fA-F]{3}$/.test(s)) return hexRgb(s.slice(1).replace(/./g, (c) => c + c));
    const parts = s.split(',');
    const out = [0, 0, 0];
    for (let k = 0; k < 3 && k < parts.length; k++) out[k] = /^[+-]?\d+$/.test(parts[k]) ? Number(parts[k]) : 0;
    return out;
  }
  /** The dialog's stricter reading: a CSS name, #hex, or three integers 0–255 (spaces allowed). */
  function strictColor(s) {
    s = String(s).trim();
    if (CSS_COLORS[s.toLowerCase()]) return hexRgb(CSS_COLORS[s.toLowerCase()]);
    if (/^#([0-9a-fA-F]{6}|[0-9a-fA-F]{3})$/.test(s)) return colorOf(s.toLowerCase());
    const m = /^(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})$/.exec(s);
    if (!m) return null;
    const c = [Number(m[1]), Number(m[2]), Number(m[3])];
    return c.every((x) => x <= 255) ? c : null;
  }

  function convert(v, item) {
    if (!v) return null;
    switch (item.kind) {
      case 'number': return toNumber(v, item);
      case 'string': return javaText(v);
      case 'char': { const t = javaText(v); return t.length === 1 ? t : null; }
      case 'boolean': return v.t === 's' ? parseBool(v.v) : null;
      case 'file': return v.t === 's' ? v.v : javaText(v);
      case 'color': { const c = v.t === 's' ? colorOf(v.v) : null; return c ? c.join(',') : null; }
      default: return null;
    }
  }

  // ════════════════════════════════════════════════════════════════════════════════════════════════
  //  parse
  // ════════════════════════════════════════════════════════════════════════════════════════════════

  const PARAM_RE = /^#@/;
  const LEGACY_RE = /^[^\w]*[^\w#]@/;
  const IO_WORDS = { input: 'INPUT', output: 'OUTPUT', both: 'BOTH' };
  const VISIBILITIES = ['NORMAL', 'MESSAGE', 'INVISIBLE', 'TRANSIENT'];
  const NAME_RE = /^[A-Za-z0-9_]+$/;
  // The macro language's reserved words and built-in function names (its system symbol table, ImageJ 1.54p MacroConstants): Fiji
  // declares and assigns no input of such a name (golden params name-builtin, service-log), since "var print;" cannot tokenize.
  const RESERVED = new Set((
    'macro var if else while do for function return true false PI NaN break continue run invert selectWindow wait beep ' +
    'resetMinAndMax resetThreshold print write doWand setMinAndMax setThreshold setTool setForegroundColor setBackgroundColor ' +
    'makeLine makeOval makeRectangle dump moveTo lineTo drawLine requires autoUpdate updateDisplay drawString setPasteMode ' +
    'doCommand showStatus showProgress showMessage putPixel setPixel snapshot reset fill setColor setLineWidth changeValues ' +
    'selectImage exit setLocation getCursorLoc getLine getVoxelSize getHistogram getStatistics getBoundingRect getLut setLut ' +
    'getSelectionCoordinates showMessageWithCancel makeSelection setResult updateResults setBatchMode setJustification ' +
    'setZCoordinate getThreshold getPixelSize setupUndo saveSettings restoreSettings setKeyDown open setFont getMinAndMax close ' +
    'setSlice newImage saveAs save setAutoThreshold rename getSelectionBounds fillRect getRawStatistics floodFill ' +
    'restorePreviousTool setVoxelSize getLocationAndSize getDateAndTime setMetadata imageCalculator setRGBWeights makePolygon ' +
    'setSelectionName drawRect drawOval fillOval setOption showText setSelectionLocation getDimensions waitForUser makePoint ' +
    'makeText makeEllipse getDisplayedArea toScaled toUnscaled makeArrow makeRotatedRectangle getPixel abs cos exp floor log ' +
    'maxOf minOf pow round sin sqrt tan getTime getWidth getHeight random getResult getResultsCount getNumber nImages nSlices ' +
    'lengthOf nResults getImageID bitDepth selectionType atan isOpen isActive indexOf lastIndexOf charCodeAt getBoolean ' +
    'startsWith endsWith atan2 isNaN getZoom parseInt parseFloat isKeyDown getSliceNumber screenWidth screenHeight calibrate ' +
    'asin acos roiManager toolID is getValue Stack matches getStringWidth Fit Overlay selectionContains Plot Math d2s toHex ' +
    'toBinary getTitle getString substring fromCharCode getInfo getDirectory getArgument getImageInfo toLowerCase toUpperCase ' +
    'runMacro eval toString replace Dialog getMetadata File selectionName getVersion getResultLabel call String Ext exec List ' +
    'debug IJ getResultString getDir trim charAt getProfile newArray split getFileList getFontList newMenu getList Array Table ' +
    'Roi RoiManager Property Image Color'
  ).split(' '));

  /** java.io.BufferedReader.readLine over the text: \r\n, \r and \n end a line, a final terminator opens no line. */
  function readLines(text) {
    const lines = text.split(/\r\n|\r|\n/);
    if (lines.length > 1 && lines[lines.length - 1] === '' && /[\r\n]$/.test(text)) lines.pop();
    return lines;
  }

  function describeStyles(style) {
    const out = { styles: [], mode: 'open', extensions: [], slider: false, spinner: false, scroll: false, format: null,
      textArea: false, password: false, listBox: false, radio: null };
    if (style == null) return out;
    for (const raw of String(style).split(',')) {
      const s = raw.trim();
      if (!s) continue;
      out.styles.push(s);
      const low = s.toLowerCase();
      if (low === 'directory') out.mode = 'directory';
      else if (low === 'save') out.mode = 'save';
      else if (low === 'open' || low === 'file') { if (out.mode !== 'directory' && out.mode !== 'save') out.mode = 'open'; }
      else if (low.startsWith('extensions:')) out.extensions = s.slice(11).split('/').map((e) => e.trim()).filter(Boolean);
      else if (low === 'slider') out.slider = true;
      else if (low === 'scroll bar') out.scroll = true;
      else if (low === 'spinner') out.spinner = true;
      else if (low.startsWith('format:')) out.format = s.slice(7);
      else if (low === 'text area') out.textArea = true;
      else if (low === 'password') out.password = true;
      else if (low === 'listbox') out.listBox = true;
      else if (low === 'radiobuttonhorizontal') out.radio = 'horizontal';
      else if (low === 'radiobuttonvertical') out.radio = 'vertical';
    }
    return out;
  }

  function buildItem(line, text, io, declared, name, attrs) {
    const type = resolveType(declared);
    if (!type) return null;
    const get = (k) => (attrs.has(k) ? attrs.get(k) : null);
    const it = {
      line, text, io, declared, name, javaType: type.java, kind: type.kind,
      integer: !!type.integer, bits: type.bits || 0, float: !!type.float, big: !!type.big, byTitle: !!type.byTitle,
      validName: NAME_RE.test(name),
      label: null, description: null, style: null, min: null, max: null, stepSize: null, softMin: null, softMax: null,
      choices: null, columns: 6, rows: null, value: null, persist: true, required: true, visibility: 'NORMAL',
      callback: null, autoFill: true, initializer: null, attrs: {}
    };
    for (const [k, v] of attrs) it.attrs[k] = javaText(v);
    const asText = (k) => { const v = get(k); return v ? javaText(v) : null; };
    it.label = asText('label');
    it.description = asText('description');
    it.style = asText('style');
    it.callback = asText('callback');
    it.initializer = asText('initializer');
    if (get('persist')) it.persist = parseBool(javaText(get('persist')));
    if (get('required')) it.required = parseBool(javaText(get('required')));
    if (get('autofill')) it.autoFill = parseBool(javaText(get('autofill')));
    if (get('visibility')) { const s = javaText(get('visibility')); it.visibility = VISIBILITIES.indexOf(s) >= 0 ? s : 'NORMAL'; }
    if (get('columns')) { const c = toNumber(get('columns'), { integer: true, bits: 32 }); if (c !== null) it.columns = c; }
    if (get('rows')) { const r = toNumber(get('rows'), { integer: true, bits: 32 }); if (r !== null) it.rows = r; }
    if (get('choices')) {
      const v = get('choices');
      it.choices = v.t === 'l' ? v.v.map(javaText) : [javaText(v)];
    }
    if (it.kind === 'number') {
      for (const [k, f] of [['min', 'min'], ['max', 'max'], ['stepsize', 'stepSize'], ['softmin', 'softMin'], ['softmax', 'softMax']]) {
        if (get(k)) it[f] = toNumber(get(k), it);
      }
      if (it.stepSize === null) it.stepSize = 1;
    } else {
      if (get('min')) it.min = asText('min');
      if (get('max')) it.max = asText('max');
      if (get('stepsize')) it.stepSize = asText('stepsize');
    }
    if (get('value')) it.value = convert(get('value'), it);
    it.styleInfo = describeStyles(it.style);
    return it;
  }

  function parse(source) {
    source = String(source == null ? '' : source);
    const lines = readLines(source);
    const parsed = {
      source, hasParams: false, stripped: '', strippedLines: [], script: null,
      items: [], inputs: [], outputs: [], ignored: [], errors: [], implicitResult: true
    };
    const stripped = lines.slice();
    for (let i = 0; i < lines.length; i++) {
      const ln = lines[i];
      let body = null, legacy = false;
      if (PARAM_RE.test(ln)) body = ln.slice(2);
      else {
        const m = LEGACY_RE.exec(ln);
        if (m) { body = ln.slice(m[0].length); legacy = true; }
      }
      if (body === null) continue;
      parsed.hasParams = true;
      const line = i + 1;
      try {
        if (!legacy && /^script\s*(\(|$)/.test(body)) {
          const o = body.indexOf('('), c = body.lastIndexOf(')');
          const attrs = o >= 0 && c > o ? parseAttrs(body.slice(o + 1, c)) : new Map();
          parsed.script = {
            name: attrs.has('name') ? javaText(attrs.get('name')) : null,
            label: attrs.has('label') ? javaText(attrs.get('label')) : null
          };
          stripped[i] = '';
          continue;
        }
        const o = body.indexOf('(');
        let rest = body, attrs = new Map();
        if (o >= 0) {
          const c = body.lastIndexOf(')');
          if (c < o) { parsed.ignored.push({ line, text: ln, reason: 'syntax' }); continue; }
          attrs = parseAttrs(body.slice(o + 1, c));
          rest = body.slice(0, o) + body.slice(c + 1);
        }
        const toks = rest.trim().split(/\s+/).filter(Boolean);
        let io = 'INPUT', hasIo = false;
        if (toks.length && Object.prototype.hasOwnProperty.call(IO_WORDS, toks[0])) { io = IO_WORDS[toks.shift()]; hasIo = true; }
        let declared, name;
        if (toks.length >= 2) { declared = toks[0]; name = toks[1]; }
        else if (toks.length === 1 && hasIo) { declared = 'Object'; name = toks[0]; }
        else { parsed.ignored.push({ line, text: ln, reason: 'syntax' }); continue; }
        const item = buildItem(line, ln, io, declared, name, attrs);
        if (!item) { parsed.ignored.push({ line, text: ln, reason: 'type', declared }); continue; }
        parsed.items.push(item);
        // Fiji blanks the lines it read as parameters only: an ignored line stays and the macro fails on its '#'
        stripped[i] = '';
      } catch (e) {
        if (!(e instanceof AttrError)) throw e;
        parsed.errors.push({ line, text: ln, message: e.message });
      }
    }
    parsed.strippedLines = stripped;
    parsed.stripped = parsed.hasParams ? stripped.join('\n') + (/[\r\n]$/.test(source) ? '\n' : '') : source;
    const inputs = new Map(), outputs = new Map();
    for (const it of parsed.items) {
      if (it.io === 'INPUT' || it.io === 'BOTH') { inputs.delete(it.name); inputs.set(it.name, it); }
      if (it.io === 'OUTPUT' || it.io === 'BOTH') { outputs.delete(it.name); outputs.set(it.name, it); }
    }
    parsed.inputs = Array.from(inputs.values());
    parsed.outputs = Array.from(outputs.values());
    parsed.implicitResult = parsed.outputs.length === 0;
    return parsed;
  }

  // ════════════════════════════════════════════════════════════════════════════════════════════════
  //  check
  // ════════════════════════════════════════════════════════════════════════════════════════════════

  function check(parsed, ctx) {
    const out = [];
    for (const e of parsed.errors) out.push({ key: 'err.macParamSyntax', params: { line: e.line, text: e.text } });
    const images = ctx && Array.isArray(ctx.images) ? ctx.images : null;
    for (const it of parsed.items) {
      if (it.io === 'OUTPUT') continue;
      if (it.kind === 'service') out.push({ key: 'err.macParamService', params: { type: it.declared, name: it.name } });
      else if (it.kind === 'unknown') out.push({ key: 'err.macParamType', params: { type: it.declared, name: it.name } });
      else if (it.kind === 'string' && it.styleInfo.password) out.push({ key: 'err.macParamPassword', params: { name: it.name } });
      else if (it.kind === 'image' && images && images.length === 0) out.push({ key: 'err.macParamNoImage', params: { type: it.declared, name: it.name } });
    }
    return out;
  }

  // ════════════════════════════════════════════════════════════════════════════════════════════════
  //  values: persistence, defaults, dialog
  // ════════════════════════════════════════════════════════════════════════════════════════════════

  // Fiji keys a stored input value by the input's name alone: another script with an input of that name gets it (golden params
  // persist-shared-name); the record keeps the macro's identity for information only
  function persistId(name) { return 'p:' + String(name); }

  // Fiji keeps NORMAL and TRANSIENT inputs alike (a TRANSIENT value given once comes back in the next headless run)
  const keptVisibility = (it) => it.visibility === 'NORMAL' || it.visibility === 'TRANSIENT';
  const mayPersist = (it) => it.persist !== false && keptVisibility(it) && it.kind !== 'image' && it.kind !== 'service'
    && it.kind !== 'unknown' && !(it.kind === 'string' && it.styleInfo.password);
  function persistable(parsed) { return parsed.inputs.filter(mayPersist).map((it) => it.name); }

  /** A stored value usable for this item, else undefined (a value of another type is not used: Fiji's Boolean b read back an
   *  Integer as false). */
  function usable(it, v) {
    if (v === undefined || v === null) return undefined;
    switch (it.kind) {
      case 'number':
        if (typeof v === 'string' && isBig(it) && bigText(it, v)) return v;
        if (typeof v !== 'number' || !Number.isFinite(v)) return undefined;
        return it.integer ? (Number.isInteger(v) ? v : undefined) : v;
      case 'string': return typeof v === 'string' ? v : undefined;
      case 'char': return typeof v === 'string' && v.length === 1 ? v : undefined;
      case 'boolean': return typeof v === 'boolean' ? v : undefined;
      case 'file': return typeof v === 'string' ? v : undefined;
      case 'color': { if (typeof v !== 'string') return undefined; const c = strictColor(v); return c ? c.join(',') : undefined; }
      default: return undefined;
    }
  }

  const isBig = (it) => it.kind === 'number' && (it.big || (it.integer && it.bits === 0));
  const bigText = (it, s) => (it.integer ? /^[+-]?\d+$/ : /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/).test(s);

  function bounds(it) {
    let min = Number.isFinite(it.min) ? it.min : -Infinity, max = Number.isFinite(it.max) ? it.max : Infinity;
    if (it.integer && it.bits) {
      const lim = it.bits === 64 ? Number.MAX_SAFE_INTEGER : Math.pow(2, it.bits - 1);
      min = Math.max(min, -lim);
      max = Math.min(max, it.bits === 64 ? lim : lim - 1);
    }
    if (min > max) return { min: -Infinity, max: Infinity, broken: true };
    return { min, max };
  }
  /** The number a widget starts from without a value: 0 brought into [min, max] (Fiji: Integer → 0, Integer(min=5) → 5). */
  function numberDefault(it) {
    const b = bounds(it);
    return Math.min(Math.max(0, b.min), b.max);
  }

  function initialValue(it, persisted) {
    if (keptVisibility(it) && it.persist !== false && persisted && Object.prototype.hasOwnProperty.call(persisted, it.name)) {
      const u = usable(it, persisted[it.name]);
      if (u !== undefined) return u;
    }
    return it.value;
  }

  function headlessValues(parsed, persisted) {
    const out = {};
    for (const it of parsed.inputs) {
      if (it.kind === 'image' || it.kind === 'service' || it.kind === 'unknown') continue;
      let v = initialValue(it, persisted);
      if ((v === null || v === undefined) && it.kind === 'number') v = numberDefault(it);
      if (v !== null && v !== undefined) out[it.name] = v;
    }
    return out;
  }

  /** Required inputs without a value (a MESSAGE without a value too): Fiji's headless run of such a script does not start,
   *  only a status line "'<name>' is required but unset." */
  function missing(parsed, values) {
    const out = [];
    for (const it of parsed.inputs) {
      if (!it.required) continue;
      const v = values ? values[it.name] : undefined;
      if (v === undefined || v === null) out.push(it.name);
    }
    return out;
  }

  /** The widget label: the label, else the name with its first letter in capitals (scijava DefaultWidgetModel). */
  function widgetLabel(it) {
    if (it.label !== null && it.label !== '') return it.label;
    return it.name.charAt(0).toUpperCase() + it.name.slice(1);
  }

  function decimalsOf(it) {
    const f = it.styleInfo.format;
    if (f !== null) { const dot = f.indexOf('.'); return dot < 0 ? 0 : (f.slice(dot + 1).match(/[0#]/g) || []).length; }
    if (it.integer) return 0;
    if (Number.isFinite(it.stepSize) && !Number.isInteger(it.stepSize)) {
      const s = javaDoubleString(it.stepSize);
      if (s.indexOf('E') < 0) return s.split('.')[1].length;
    }
    return undefined;
  }

  const fieldId = (i) => 'p' + i;

  function dialogSpec(parsed, ctx) {
    ctx = ctx || {};
    const persisted = ctx.persisted || {};
    const images = Array.isArray(ctx.images) ? ctx.images : [];
    const fields = [], names = {};
    parsed.inputs.forEach((it, i) => {
      const id = fieldId(i);
      if (it.visibility === 'INVISIBLE' || it.kind === 'service' || it.kind === 'unknown') return;
      const label = widgetLabel(it);
      names[id] = it.name;
      if (it.visibility === 'MESSAGE') {
        const text = typeof it.value === 'string' && it.value !== '' ? it.value : label;
        fields.push({ type: 'message', id, label: text });
        return;
      }
      const v0 = initialValue(it, persisted);
      switch (it.kind) {
        case 'number': {
          const b = bounds(it);
          let value = v0 === null || v0 === undefined ? numberDefault(it) : v0;
          value = Math.min(Math.max(value, b.min), b.max);
          const st = it.styleInfo;
          if ((st.slider || st.scroll) && Number.isFinite(it.min) && Number.isFinite(it.max) && !b.broken) {
            fields.push({ type: 'slider', id, label, value, min: b.min, max: b.max, step: Number.isFinite(it.stepSize) && it.stepSize > 0 ? it.stepSize : 1 });
          } else {
            const f = { type: 'number', id, label, value, integer: it.integer };
            if (Number.isFinite(b.min)) f.min = b.min;
            if (Number.isFinite(b.max)) f.max = b.max;
            if (Number.isFinite(it.stepSize) && it.stepSize > 0) f.step = it.stepSize;
            const dec = decimalsOf(it);
            if (dec !== undefined) f.decimals = dec;
            fields.push(f);
          }
          break;
        }
        case 'string': {
          const st = it.styleInfo;
          if (it.choices && it.choices.length) {
            const value = it.choices.indexOf(v0) >= 0 ? v0 : it.choices[0];
            const f = { type: st.radio ? 'radio' : 'choice', id, label, value, options: it.choices.slice() };
            if (st.radio) f.columns = st.radio === 'horizontal' ? it.choices.length : 1;
            fields.push(f);
          } else if (st.textArea) {
            fields.push({ type: 'textarea', id, label, value: v0 == null ? '' : String(v0), rows: it.rows > 0 ? it.rows : 5, columns: it.columns });
          } else fields.push({ type: 'string', id, label, value: v0 == null ? '' : String(v0) });
          break;
        }
        case 'boolean': fields.push({ type: 'check', id, label, value: v0 === true }); break;
        case 'char': fields.push({ type: 'string', id, label, value: v0 == null ? '' : String(v0) }); break;
        case 'color': fields.push({ type: 'string', id, label, value: v0 == null ? '0,0,0' : String(v0) }); break;
        case 'file': {
          const st = it.styleInfo;
          const base = { type: 'path', id, label, value: v0 == null ? '' : String(v0), pathKind: st.mode === 'directory' ? 'directory' : 'file',
            mode: st.mode, extensions: st.extensions.slice() };
          fields.push(typeof ctx.pathField === 'function' ? ctx.pathField(base, label) : base);
          break;
        }
        case 'image': {
          const options = images.map((im) => ({ value: im.docId, label: String(im.title) }));
          const cur = images.find((im) => im.docId === ctx.current);
          const value = it.autoFill && cur ? cur.docId : (images[0] ? images[0].docId : undefined);
          fields.push({ type: 'doc', id, label, value, options });
          break;
        }
        default:
      }
    });
    const title = parsed.script && parsed.script.label ? parsed.script.label
      : parsed.script && parsed.script.name ? parsed.script.name : (ctx.title || 'Macro');
    const spec = { title, fields, names, needsDialog: fields.some((f) => f.type !== 'message') };
    if (ctx.okLabel) spec.okLabel = ctx.okLabel;
    return spec;
  }

  function valuesOf(parsed, dialogValues) {
    dialogValues = dialogValues || {};
    const values = {}, problems = [];
    parsed.inputs.forEach((it, i) => {
      if (it.kind === 'service' || it.kind === 'unknown') return;
      const id = fieldId(i);
      const has = Object.prototype.hasOwnProperty.call(dialogValues, id);
      if (!has || it.visibility === 'MESSAGE' || it.visibility === 'INVISIBLE') {
        let v = it.value;
        if ((v === null || v === undefined) && it.kind === 'number') v = numberDefault(it);
        if (v !== null && v !== undefined) values[it.name] = v;
        return;
      }
      const raw = dialogValues[id];
      switch (it.kind) {
        case 'number': {
          const x = typeof raw === 'number' ? raw : Number(String(raw).trim());
          if (!Number.isFinite(x)) { problems.push({ name: it.name, key: 'view.invalid.nan' }); return; }
          if (it.integer && !Number.isInteger(x)) { problems.push({ name: it.name, key: 'view.invalid.integer' }); return; }
          values[it.name] = it.integer ? narrow(x, it.bits) : (it.float ? Math.fround(x) : x);
          return;
        }
        case 'boolean': values[it.name] = raw === true || raw === 'true'; return;
        case 'color': {
          const c = strictColor(raw);
          if (!c) { problems.push({ name: it.name, key: 'view.invalid.color' }); return; }
          values[it.name] = c.join(',');
          return;
        }
        case 'image': values[it.name] = raw; return;
        case 'char': {
          const s = raw == null ? '' : String(raw);
          if (s === '') { if (it.required) problems.push({ name: it.name, key: 'view.invalid.required' }); return; }
          values[it.name] = s.charAt(0);
          return;
        }
        default: {
          const s = raw == null ? '' : String(raw);
          if (s === '' && it.required && (it.kind === 'string' || it.kind === 'file')) { problems.push({ name: it.name, key: 'view.invalid.required' }); return; }
          values[it.name] = s;
        }
      }
    });
    return { values, problems };
  }

  // ════════════════════════════════════════════════════════════════════════════════════════════════
  //  inject: the text Fiji's IJ1 macro engine runs. Observed (error excerpts and line numbers of runs in Fiji):
  //    line 1  = 'var a , b , ; initializeSciJavaParameters ( ) ;' + the script's first line (also with no name: 'var ;')
  //    then    = the script read line by line, every line ended by '\n', then '\n', then
  //              'function initializeSciJavaParameters() {', one line, then one assignment per line, then '}'.
  //  Fiji's line after the header is call("net.imagej.legacy.plugin.IJ1MacroEngine.saveInterpreter"), a hook into Fiji's own
  //  engine with no Studio meaning (and outside the call() whitelist): it is an empty line here, so every line keeps its number.
  //  The names are every input named [A-Za-z0-9_]+ (MESSAGE and INVISIBLE ones included), in the iteration order of the
  //  java.util.HashMap that holds the module's inputs; an input without a value is declared but not assigned.
  // ════════════════════════════════════════════════════════════════════════════════════════════════

  function javaHash(s) {
    let h = 0;
    for (let i = 0; i < s.length; i++) h = (Math.imul(h, 31) + s.charCodeAt(i)) | 0;
    return h;
  }
  /** Iteration order of a java.util.HashMap filled with `keys` (in this order) through put(): buckets by the spread hash,
   *  insertion order inside a bucket (a resize splits buckets without reordering them). */
  function hashMapOrder(keys) {
    const uniq = [];
    for (const k of keys) if (uniq.indexOf(k) < 0) uniq.push(k);
    let cap = 16;
    while (uniq.length > cap * 0.75) cap *= 2;
    const rows = uniq.map((k, i) => { const h = javaHash(k); return { k, i, b: (h ^ (h >>> 16)) & (cap - 1) }; });
    rows.sort((a, b) => a.b - b.b || a.i - b.i);
    return rows.map((r) => r.k);
  }

  function quote(s) {
    return '"' + String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r') + '"';
  }

  function literal(it, v, ctx) {
    switch (it.kind) {
      case 'number':
        // BigInteger / BigDecimal values may be exact decimal text (BigInteger.toString, BigDecimal.toString keep every digit)
        if (typeof v === 'string' && isBig(it) && bigText(it, v)) return v.replace(/^\+/, '');
        if (it.integer) {
          if (it.bits && it.bits < 64) return String(narrow(v, it.bits));
          return Number.isSafeInteger(Math.trunc(v)) ? String(Math.trunc(v)) : BigInt(Math.trunc(v)).toString();
        }
        if (it.float) return javaFloatString(v);
        if (it.big) return String(v);
        return javaDoubleString(v);
      case 'boolean': return v ? 'true' : 'false';
      case 'image': {
        // an ImagePlus is its ImageJ id; a Dataset reaches the macro as its toString, the image's name
        if (it.byTitle) {
          const t = ctx && ctx.imageTitles ? ctx.imageTitles[it.name] : undefined;
          return typeof t === 'string' ? quote(t) : null;
        }
        const id = ctx && ctx.imageIds ? ctx.imageIds[it.name] : undefined;
        return typeof id === 'number' && Number.isFinite(id) ? String(id) : null;
      }
      default: return quote(v);
    }
  }

  function inject(parsed, values, ctx) {
    if (!parsed.hasParams) return parsed.source;
    values = values || {};
    const byName = new Map(parsed.inputs.map((it) => [it.name, it]));
    const order = hashMapOrder(parsed.items.filter((it) => it.io !== 'OUTPUT').map((it) => it.name));
    const names = order.filter((n) => NAME_RE.test(n) && !RESERVED.has(n) && byName.has(n));
    const lines = parsed.strippedLines.length ? parsed.strippedLines.slice() : [''];
    lines[0] = 'var ' + names.map((n) => n + ', ').join('') + '; initializeSciJavaParameters();' + lines[0];
    let text = lines.map((l) => l + '\n').join('');
    text += '\nfunction initializeSciJavaParameters() {\n\n';
    for (const n of names) {
      const it = byName.get(n);
      const v = values[n];
      if (v === undefined || v === null) continue;
      const lit = literal(it, v, ctx);
      if (lit === null) continue;
      text += '\t' + n + ' = ' + lit + ';\n';
    }
    return text + '}\n';
  }

  // ════════════════════════════════════════════════════════════════════════════════════════════════
  //  outputs
  // ════════════════════════════════════════════════════════════════════════════════════════════════

  function outputs(parsed) { return parsed.outputs.filter((it) => it.validName).map((it) => it.name); }

  /** The text Fiji shows for an output: the variable converted to the declared type, then Java's toString.
   *  v = { n } | { s } | { a } | null (IJMacro.run readVars). */
  function formatOutput(parsed, name, v) {
    if (!v) return '';
    const it = parsed.outputs.find((o) => o.name === name) || { kind: 'unknown', integer: false };
    // an array variable reaches the engine as its numeric value, 0 (Fiji: a String output holding newArray(…) is "0.0")
    if (v.a) v = { n: 0 };
    if (it.kind === 'number') {
      const x = v.n !== undefined ? v.n : toNumber(str(String(v.s)), it);
      if (x === null || x === undefined) return '';
      if (it.integer) return String(it.bits && it.bits < 64 ? narrow(x, it.bits) : Math.trunc(x));
      return it.float ? javaFloatString(x) : javaDoubleString(x);
    }
    if (it.kind === 'boolean') return v.n !== undefined ? String(v.n !== 0) : String(parseBool(v.s));
    if (v.n !== undefined) return javaDoubleString(v.n);
    return String(v.s);
  }

  // ════════════════════════════════════════════════════════════════════════════════════════════════
  //  scanMacros: the MACRO tokens followed by a string constant, exactly where ij.macro.Tokenizer puts them
  //  (java.io.StreamTokenizer: '_' and letters start words, 128–255 are blanks, '/' '.' '-' are ordinary, quotes stop at a
  //  line end, escapes \a \b \f \n \r \t \v and octal; Tokenizer.getHexConstant and tryScientificNotation consume what follows
  //  a number as ImageJ does).
  // ════════════════════════════════════════════════════════════════════════════════════════════════

  const TT_EOF = -1, TT_NUMBER = -2, TT_WORD = -3;
  function streamTokens(text) {
    let pos = 0, peekc = -4, lineno = 1, ttype = -4, sval = null, nval = 0, pushed = false;
    const NEED = -4, SKIP_LF = -5;
    const read = () => (pos < text.length ? text.charCodeAt(pos++) : -1);
    const isWs = (c) => c >= 0 && ((c <= 32) || (c >= 128 && c <= 255));
    const isAlpha = (c) => (c >= 97 && c <= 122) || (c >= 65 && c <= 90) || c === 95 || c > 255;
    const isDigit = (c) => c >= 48 && c <= 57;
    function next() {
      if (pushed) { pushed = false; return ttype; }
      sval = null;
      let c = peekc;
      if (c < 0) c = NEED;
      if (c === SKIP_LF) { c = read(); if (c < 0) return (ttype = TT_EOF); if (c === 10) c = NEED; }
      if (c === NEED) { c = read(); if (c < 0) return (ttype = TT_EOF); }
      ttype = c;
      peekc = NEED;
      while (isWs(c)) {
        if (c === 13) { lineno++; c = read(); if (c === 10) c = read(); }
        else { if (c === 10) lineno++; c = read(); }
        if (c < 0) return (ttype = TT_EOF);
      }
      if (isDigit(c)) {
        let v = 0, decexp = 0, seendot = 0;
        for (;;) {
          if (c === 46 && seendot === 0) seendot = 1;
          else if (isDigit(c)) { v = v * 10 + (c - 48); decexp += seendot; }
          else break;
          c = read();
        }
        peekc = c;
        if (decexp !== 0) { let denom = 10; decexp--; while (decexp > 0) { denom *= 10; decexp--; } v = v / denom; }
        nval = v;
        return (ttype = TT_NUMBER);
      }
      if (isAlpha(c)) {
        let s = '';
        do { s += String.fromCharCode(c); c = read(); } while (c >= 0 && (isAlpha(c) || isDigit(c)) && !(c >= 128 && c <= 255));
        peekc = c;
        sval = s;
        return (ttype = TT_WORD);
      }
      if (c === 34 || c === 39) {
        ttype = c;
        let s = '', d = read();
        while (d >= 0 && d !== ttype && d !== 10 && d !== 13) {
          if (d === 92) {
            c = read();
            const first = c;
            if (c >= 48 && c <= 55) {
              c -= 48;
              let c2 = read();
              if (c2 >= 48 && c2 <= 55) {
                c = (c << 3) + (c2 - 48);
                c2 = read();
                if (c2 >= 48 && c2 <= 55 && first <= 51) { c = (c << 3) + (c2 - 48); d = read(); } else d = c2;
              } else d = c2;
            } else {
              switch (c) {
                case 97: c = 7; break; case 98: c = 8; break; case 102: c = 12; break; case 110: c = 10; break;
                case 114: c = 13; break; case 116: c = 9; break; case 118: c = 11; break; default:
              }
              d = read();
            }
          } else { c = d; d = read(); }
          s += c < 0 ? '' : String.fromCharCode(c);
        }
        peekc = d === ttype ? NEED : d;
        sval = s;
        return ttype;
      }
      if (c === 47) {
        c = read();
        if (c === 42) {
          let prevc = 0;
          while ((c = read()) !== 47 || prevc !== 42) {
            if (c === 13) { lineno++; c = read(); if (c === 10) c = read(); }
            else if (c === 10) { lineno++; c = read(); }
            if (c < 0) return (ttype = TT_EOF);
            prevc = c;
          }
          return next();
        }
        if (c === 47) {
          while ((c = read()) !== 10 && c !== 13 && c >= 0);
          peekc = c;
          return next();
        }
        peekc = c;
        return (ttype = 47);
      }
      return (ttype = c);
    }
    return {
      next, pushBack: () => { if (ttype !== -4) pushed = true; },
      get ttype() { return ttype; }, get sval() { return sval; }, get nval() { return nval; }, get lineno() { return lineno; }
    };
  }

  /** ij.macro.Tokenizer.addSpacesToEmptyLines (run when the text holds both '/*' and '*' + '/'). */
  function addSpacesToEmptyLines(p) {
    let sb = '';
    for (let j = 0; j < p.length - 1; j++) {
      const c = p.charAt(j);
      sb += c;
      if (c === '\n' && p.charAt(j + 1) === '\n') sb += ' ';
    }
    return sb + p.charAt(p.length - 1);
  }

  function scanMacros(source) {
    let text = String(source == null ? '' : source);
    if (text.indexOf('/*') >= 0 && text.indexOf('*/') >= 0) text = addSpacesToEmptyLines(text);
    const st = streamTokens(text);
    const toks = [];
    for (;;) {
      st.next();
      const line = st.lineno;
      const tt = st.ttype;
      if (tt === TT_EOF) { toks.push({ k: 'eof' }); break; }
      if (tt === TT_WORD) toks.push({ k: 'word', s: st.sval, line });
      else if (tt === 34 || tt === 39) toks.push({ k: 'str', s: st.sval, line });
      else if (tt === TT_NUMBER) {
        const value = st.nval;
        if (value === 0) {
          st.next();
          const ok = st.ttype === TT_WORD && st.sval.startsWith('x') && /^[0-9a-fA-F]+$/.test(st.sval.slice(1))
            && BigInt('0x' + st.sval.slice(1)) <= 0x7fffffffffffffffn;
          if (!ok) st.pushBack();
        } else {
          // Tokenizer.tryScientificNotation: a word after a number is taken when it starts with e / E; a failed attempt
          // loses the tokens it read (ImageJ catches the exception without pushing back).
          st.next();
          if (st.ttype === TT_WORD && (st.sval.startsWith('e') || st.sval.startsWith('E'))) {
            if (st.sval.toLowerCase() === 'e') {
              const sign = st.next();
              if (sign === 45 || sign === 43) st.next();
            }
          } else st.pushBack();
        }
        toks.push({ k: 'num', line });
      } else if ([43, 45, 42, 47, 61, 33, 62, 60, 38, 124].indexOf(tt) >= 0) {
        const nt = st.next();
        const pairs = { 43: [43, 61], 45: [45, 61], 42: [61], 47: [61], 61: [61], 33: [61], 62: [61, 62], 60: [61, 60], 38: [38], 124: [124] };
        if (pairs[tt].indexOf(nt) < 0) st.pushBack();
        toks.push({ k: 'op', line });
      } else toks.push({ k: 'op', line });
    }
    const out = [];
    for (let i = 0; i + 1 < toks.length; i++) {
      if (toks[i].k === 'word' && toks[i].s === 'macro' && toks[i + 1].k === 'str')
        out.push({ name: toks[i + 1].s, line: toks[i].line, index: out.length });
    }
    return out;
  }

  // ════════════════════════════════════════════════════════════════════════════════════════════════
  //  installPlan: MacroInstaller.install for the Plugins › Macros menu
  // ════════════════════════════════════════════════════════════════════════════════════════════════

  const VK = { A: 65, ZERO: 48, F1: 112, F10: 121, F12: 123, NUM0: 96, NUM9: 105, MULTIPLY: 106, ADD: 107, SUBTRACT: 109, DECIMAL: 110, DIVIDE: 111 };
  /** Menus.convertShortcutToCode. */
  function shortcutCode(s) {
    const len = s.length;
    if (len === 2 && s[0] === 'F') { const c = VK.F1 + s.charCodeAt(1) - 49; return c >= VK.F1 && c <= VK.F1 + 8 ? c : 0; }
    if (len === 3 && s[0] === 'F') { const c = VK.F10 + s.charCodeAt(2) - 48; return c >= VK.F10 && c <= VK.F12 ? c : 0; }
    if (len === 2 && s[0] === 'N') {
      const c = VK.NUM0 + s.charCodeAt(1) - 48;
      if (c >= VK.NUM0 && c <= VK.NUM9) return c;
      return { '/': VK.DIVIDE, '*': VK.MULTIPLY, '-': VK.SUBTRACT, '+': VK.ADD, '.': VK.DECIMAL }[s[1]] || 0;
    }
    if (len !== 1) return 0;
    const c = s.charCodeAt(0);
    if (c >= 65 && c <= 90) return VK.A + c - 65 + 200;
    if (c >= 97 && c <= 122) return VK.A + c - 97;
    if (c >= 48 && c <= 57) return VK.ZERO + c - 48;
    return 0;
  }
  /** The Studio key spec of an ImageJ key code (the shell matches KeyboardEvent.key: a keypad key is its main key). */
  function studioKey(code) {
    if (code >= 65 && code <= 90) return String.fromCharCode(code + 32);
    if (code >= 265 && code <= 290) return 'Shift+' + String.fromCharCode(code - 200);
    if (code >= 48 && code <= 57) return String.fromCharCode(code);
    if (code >= VK.F1 && code <= VK.F12) return 'F' + (code - VK.F1 + 1);
    if (code >= VK.NUM0 && code <= VK.NUM9) return String.fromCharCode(48 + code - VK.NUM0);
    return { [VK.DIVIDE]: '/', [VK.MULTIPLY]: '*', [VK.SUBTRACT]: '-', [VK.ADD]: '+', [VK.DECIMAL]: '.' }[code] || null;
  }

  function installPlan(source, opts) {
    opts = opts || {};
    const text = String(source == null ? '' : source);
    const fileName = typeof opts.fileName === 'string' && opts.fileName ? opts.fileName : null;
    const isMacro = !!opts.isMacro;
    // two rules in ImageJ: the editor's Install Macros sets the file name (MacroInstaller.setFileName: startsWith), Install… the path
    // (MacroInstaller.run: path.indexOf); opts.path = the virtual path of an Install… file, else its bare name
    const where = typeof opts.path === 'string' && opts.path ? opts.path : fileName;
    const startupFile = opts.origin === 'editor' ? !!(fileName && fileName.startsWith('StartupMacros')) : !!(where && where.indexOf('StartupMacros') >= 0);
    const entries = scanMacros(text);
    const firstIndex = new Map();
    for (const e of entries) if (!firstIndex.has(e.name)) firstIndex.set(e.name, e.index);
    const rows = [], notices = [], subMenus = new Set();
    const macroKeys = new Map(), menuKeys = new Map(), inUse = [];
    let count = 0, toolCount = 0, autoRun = null, autoRunCount = 0, popup = false;

    function addShortcut(row) {
      const name = row.name;
      const i1 = name.indexOf('[');
      if (i1 < 0) return;
      const i2 = name.lastIndexOf(']');
      if (i2 <= i1 + 1) return;
      let sc = name.slice(i1 + 1, i2);
      let len = sc.length;
      if (len > 1) sc = sc.toUpperCase();
      if (len > 3 || (len > 1 && sc[0] !== 'F' && sc[0] !== 'N' && sc[0] !== '&')) return;
      row.keySpec = sc;
      const both = sc.startsWith('&');
      if (both) { sc = sc.split('&').join(''); len = sc.length; }
      let code = shortcutCode(sc);
      if (code === 0) return;
      if (len === 1 || sc === 'N+' || sc === 'N-') {
        macroKeys.set(code, row);
        if (!both) return;
      }
      if (both) { sc = 'N' + sc; code = shortcutCode(sc); }
      if (menuKeys.has(code)) { inUse.push(row); return; }
      menuKeys.set(code, row);
    }

    for (const e of entries) {
      const name = e.name;
      const isTool = name.indexOf('-') >= 0 && (name.indexOf('Tool') >= 0 || name.indexOf('tool') >= 0);
      if (!isTool && name.indexOf('Tool Options') < 0) count++;
      if (isTool) { toolCount++; continue; }
      if (name.startsWith('AutoRun')) {
        if (autoRunCount === 0 && !startupFile && !isMacro) autoRun = e.index;
        autoRunCount++;
        count--;
        continue;
      }
      if (name === 'Popup Menu') { popup = true; continue; }
      if (name.endsWith('Tool Selected')) continue;
      const pos = name.indexOf('>');
      const inSub = name.startsWith('<') && pos > 1;
      const row = { index: firstIndex.get(name), entry: e.index, name, label: name, kind: 'menu', parent: null, child: null, keySpec: null, shortcut: null };
      if (inSub) {
        row.parent = name.slice(1, pos).trim();
        row.child = name.slice(pos + 1).trim();
        row.label = row.child;
        if (row.child === '-') row.kind = 'separator';
        if (!subMenus.has(row.parent)) { subMenus.add(row.parent); count++; }
      } else if (name.indexOf('Tool Options') >= 0) continue;
      else if (name === '-') row.kind = 'separator';
      addShortcut(row);
      rows.push(row);
    }

    // one key per Studio spec: the one-character table is read first by ImageJ (ImageJ.keyPressed), so it keeps a key the
    // keypad table also maps to the same browser key
    const assigned = new Map(), tried = new Set();
    const keysInUse = inUse.map((r) => r.name), keysReserved = [];
    const shortcutUse = typeof opts.shortcutUse === 'function' ? opts.shortcutUse : null;
    const give = (row, code) => {
      const spec = studioKey(code);
      if (!spec || tried.has(row)) return;   // an [&d] row reaches both tables with one browser key
      tried.add(row);
      if (assigned.has(spec)) { keysInUse.push(row.name); return; }
      const use = shortcutUse ? shortcutUse(spec) : null;
      if (use && use.reserved) { keysReserved.push({ name: row.name, key: spec }); return; }
      if (use && use.taken) { keysInUse.push(row.name); return; }
      assigned.set(spec, row);
      row.shortcut = spec;
    };
    for (const [code, row] of macroKeys) give(row, code);
    for (const [code, row] of menuKeys) give(row, code);

    if (toolCount > 0) notices.push({ key: 'dlg.mac.install.toolsSkipped', params: { n: toolCount } });
    if (popup) notices.push({ key: 'dlg.mac.install.popupSkipped', params: {} });
    let anonymous = null;
    if (count === 0 && toolCount === 0 && fileName && text.length > 0) {
      const dot = fileName.lastIndexOf('.');
      anonymous = { name: dot > 0 ? fileName.slice(0, dot) : fileName };
      count = 1;
    }
    // ImageJ's own two tables (Menus.getMacroShortcuts / getShortcuts: code → name), before the Studio's key check
    const keyTables = { macro: {}, menu: {} };
    for (const [code, row] of macroKeys) keyTables.macro[code] = row.name;
    for (const [code, row] of menuKeys) keyTables.menu[code] = row.name;
    return { rows, anonymous, autoRun, count, notices, keysInUse, keysReserved, toolCount, entries, keyTables };
  }

  root.IJMacroParams = Object.freeze({
    parse, check, dialogSpec, valuesOf, persistId, persistable, headlessValues, missing, inject, outputs, formatOutput,
    scanMacros, installPlan, widgetLabel, resolveType, hashMapOrder, javaDoubleString, javaFloatString, colorOf, shortcutCode, studioKey,
    RESERVED: Object.freeze(Array.from(RESERVED))
  });
})(typeof self !== 'undefined' ? self : globalThis);
