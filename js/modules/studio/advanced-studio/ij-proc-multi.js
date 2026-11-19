/* ij-proc-multi.js — package P4 (multi): Image Calculator, Split / Merge / Arrange Channels.
 *
 * Loaded on the page AND in the worker (ij-worker.js loads it in its own try/catch: a failure here
 * disables the package's commands, it never takes the Advanced view down). Pure: no DOM, no engine
 * globals; the operations are registered with IJOpRegistry.define(name, spec) (ij-core.js).
 *
 *   imageCalculator  newdoc  ImageJ ij.plugin.ImageCalculator + ByteBlitter / ShortBlitter / FloatBlitter
 *   splitChannels    newdoc  ij.plugin.ChannelSplitter.split
 *   mergeChannels    newdoc  ij.plugin.RGBStackMerge.mergeHyperstacks
 *   arrangeChannels  size    ij.plugin.ChannelArranger.run (the arrays are kept by reference)
 *
 * Image > Rename is the engine's doc.rename (api.rename); it needs no operation.
 *
 * Reference: ImageJ 1.54p (public domain). Every integer type is simulated the way Java computes it
 * (int arithmetic, (byte) / (short) narrowing, the (int) cast of a double), every float result is
 * stored in a Float32Array (Java float arithmetic: a double sum / difference / product / quotient of
 * two floats rounded once to float is the correctly rounded float result, so no extra Math.fround is
 * needed except where Java rounds an intermediate to float first: Average, setPixels).
 */
(function (root) {
  'use strict';
  const R = root.IJOpRegistry;
  if (!R) return;

  function ijError(code, message) { const e = new Error(message || code); e.code = code; return e; }

  // Java (int) of a double: NaN -> 0, saturating, truncating toward zero.
  function d2i(x) {
    if (x !== x) return 0;
    if (x >= 2147483647) return 2147483647;
    if (x <= -2147483648) return -2147483648;
    return x < 0 ? Math.ceil(x) : Math.floor(x);
  }
  const bytesOf = (bd) => (bd === 8 ? 1 : bd === 16 ? 2 : 4);
  function ctorOf(bd) { return bd === 8 ? Uint8Array : bd === 16 ? Uint16Array : Float32Array; }

  // ImageCalculator.getBlitterMode: operators = {Add, Subtract, Multiply, Divide, AND, OR, XOR, Min, Max,
  // Average, Difference, Copy, Transparent-zero}; our ids are the lower-case words of the fixtures.
  const CALC_OPS = ['add', 'subtract', 'multiply', 'divide', 'and', 'or', 'xor', 'min', 'max', 'average', 'difference', 'copy', 'transparent-zero'];

  // ------------------------------------------------------------------------------------------------
  // Source conversion. In ImageJ the blitter of the DESTINATION type converts the source processor first
  // (ByteProcessor/ShortProcessor/FloatProcessor.copyBits). Each reader fills one row of the converted
  // source (Int32Array for an integer destination, Float32Array for a float one).
  // ------------------------------------------------------------------------------------------------
  function rowReader(srcBd, dstBd, disp) {
    if (dstBd === 32) {
      // FloatProcessor.copyBits: "ip = ip.convertToFloat();" — TypeConverter.convertByteToFloat /
      // convertShortToFloat: plain values (no calibration table here).
      return (data, off, n, s) => { for (let i = 0; i < n; i++) s[i] = data[off + i]; };
    }
    if (srcBd === dstBd || (srcBd === 8 && dstBd === 16)) {
      // ByteProcessor.copyBits "ip = ip.convertToByte(true)" is the identity on a byte image;
      // ShortProcessor.copyBits "ip = ip.convertToShort(false)": convertByteToShort =
      // "pixels16[i] = (short)(pixels8[i]&0xff)" is a plain copy.
      return (data, off, n, s) => { for (let i = 0; i < n; i++) s[i] = data[off + i]; };
    }
    if (srcBd === 16 && dstBd === 8) {
      // TypeConverter.convertShortToByte (doScaling = true):
      //   int value, min=(int)ip.getMin(), max=(int)ip.getMax();
      //   double scale = 256.0/(max-min+1);
      //   value = (pixels16[i]&0xffff)-min; if (value<0) value = 0;
      //   value = (int)(value*scale+0.5); if (value>255) value = 255;
      // ShortProcessor.setMinAndMax stores "min = (int)Math.round(minimum)" (and the same for max), so the
      // (int)ip.getMin() above reads a ROUNDED bound: Math.round(x) = floor(x + 0.5).
      const mn = d2i(Math.floor(disp.min + 0.5)), mx = d2i(Math.floor(disp.max + 0.5));
      const scale = 256.0 / (mx - mn + 1);
      return (data, off, n, s) => {
        for (let i = 0; i < n; i++) {
          let v = data[off + i] - mn;
          if (v < 0) v = 0;
          v = d2i(v * scale + 0.5);
          s[i] = v > 255 ? 255 : v;
        }
      };
    }
    if (srcBd === 32 && dstBd === 8) {
      // TypeConverter.convertFloatToByte (doScaling) = FloatProcessor.create8BitImage:
      //   double min2 = getMin(), max2 = getMax(); double scale = 255.0/(max2-min2);
      //   value = pixels[i]-min2; if (value<0.0) value=0.0;
      //   ivalue = (int)(value*scale+0.5); if (ivalue>255) ivalue = 255;
      const mn = Math.fround(disp.min), mx = Math.fround(disp.max);
      const scale = 255.0 / (mx - mn);
      return (data, off, n, s) => {
        for (let i = 0; i < n; i++) {
          let v = data[off + i] - mn;
          if (v < 0) v = 0;
          v = d2i(v * scale + 0.5);
          s[i] = v > 255 ? 255 : v;
        }
      };
    }
    // srcBd === 32 && dstBd === 16: TypeConverter.convertFloatToShort with doScaling = false:
    //   value = pixels32[i]; if (value<0.0) value = 0.0; if (value>65535.0) value = 65535.0;
    //   pixels16[i] = (short)(value+0.5);
    return (data, off, n, s) => {
      for (let i = 0; i < n; i++) {
        let v = data[off + i];
        if (v < 0) v = 0;
        if (v > 65535) v = 65535;
        s[i] = d2i(v + 0.5) & 0xffff;
      }
    };
  }

  // ------------------------------------------------------------------------------------------------
  // Blitter kernels: out[o..o+n) = out OP s[0..n)  (dst = out, src = s).
  // ------------------------------------------------------------------------------------------------

  // ByteBlitter / ShortBlitter. `max` = 255 / 65535.
  function intKernel(op, max) {
    switch (op) {
      case 'add': // dst = src+dst; if (dst>255) dst = 255   (Short: also clamps at 65535)
        return (out, o, s, n) => { for (let i = 0; i < n; i++) { const v = s[i] + out[o + i]; out[o + i] = v > max ? max : v; } };
      case 'subtract': // dst = dst-src; if (dst<0) dst = 0
        return (out, o, s, n) => { for (let i = 0; i < n; i++) { const v = out[o + i] - s[i]; out[o + i] = v < 0 ? 0 : v; } };
      case 'multiply':
        // ShortBlitter: "dst = (srcPixels[srcIndex++]&0xffff)*(pixels[dstIndex]&0xffff); if (dst<0) dst = 0;
        // if (dst>65535) dst = 65535;" — dst is a Java int, so a product from 2^31 up WRAPS NEGATIVE and the
        // `dst<0` test turns it into 0, not 65535 (65535*65535 -> 0). `|0` is the same int wrap.
        // ByteBlitter: "dst = ...*...; if (dst>255) dst = 255;" (a byte product never wraps).
        return (out, o, s, n) => { for (let i = 0; i < n; i++) { let v = (s[i] * out[o + i]) | 0; if (v < 0) v = 0; out[o + i] = v > max ? max : v; } };
      case 'divide':
        // ByteBlitter: "if (src==0) dst = 255; else dst = (pixels[dstIndex]&255)/src;" (ShortBlitter: 65535);
        // Java int division truncates.
        return (out, o, s, n) => { for (let i = 0; i < n; i++) { const d = s[i]; out[o + i] = d === 0 ? max : ((out[o + i] / d) | 0); } };
      case 'and': return (out, o, s, n) => { for (let i = 0; i < n; i++) out[o + i] = s[i] & out[o + i]; };
      case 'or': return (out, o, s, n) => { for (let i = 0; i < n; i++) out[o + i] = s[i] | out[o + i]; };
      case 'xor': return (out, o, s, n) => { for (let i = 0; i < n; i++) out[o + i] = s[i] ^ out[o + i]; };
      case 'min': return (out, o, s, n) => { for (let i = 0; i < n; i++) { if (s[i] < out[o + i]) out[o + i] = s[i]; } };
      case 'max': return (out, o, s, n) => { for (let i = 0; i < n; i++) { if (s[i] > out[o + i]) out[o + i] = s[i]; } };
      case 'average': // dst = ((src)+(dst))/2   (int division)
        return (out, o, s, n) => { for (let i = 0; i < n; i++) out[o + i] = (s[i] + out[o + i]) >> 1; };
      case 'difference': // dst = dst-src; if (dst<0) dst = -dst
        return (out, o, s, n) => { for (let i = 0; i < n; i++) { const v = out[o + i] - s[i]; out[o + i] = v < 0 ? -v : v; } };
      case 'copy': return (out, o, s, n) => { for (let i = 0; i < n; i++) out[o + i] = s[i]; };
      case 'transparent-zero': // COPY_ZERO_TRANSPARENT: if (src==0) dst = pixels[dstIndex]; else dst = src;
        return (out, o, s, n) => { for (let i = 0; i < n; i++) { if (s[i] !== 0) out[o + i] = s[i]; } };
      default: throw ijError('IJ_BAD_ARGS', 'operation');
    }
  }

  // Edit > Options > Misc. "Divide by zero value:" (ij.plugin.Options.miscOptions): the text is read as
  //   if (divValue.equalsIgnoreCase("infinity") || divValue.equalsIgnoreCase("infinite")) FloatBlitter.divideByZeroValue = Float.POSITIVE_INFINITY;
  //   else if (divValue.equalsIgnoreCase("NaN")) ... = Float.NaN;   else if (divValue.equalsIgnoreCase("max")) ... = Float.MAX_VALUE;
  //   else { try {f = Float.valueOf(divValue);} catch (NumberFormatException e) {f = null;}  if (f!=null) ... = f.floatValue(); }
  // Returns the float, or null when the text is none of those (ImageJ then leaves the value as it was).
  // Float.valueOf: leading and trailing white space (<= U+0020) is trimmed, an optional sign, "NaN" / "Infinity" (case-sensitive),
  // a decimal number with an optional exponent and an optional f / F / d / D suffix.
  const JAVA_FLOAT = /^[+-]?(?:NaN|Infinity|(?:(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)[fFdD]?)$/;
  function parseDivZero(text) {
    const t = String(text === undefined || text === null ? '' : text);
    const l = t.toLowerCase();
    if (l === 'infinity' || l === 'infinite') return Infinity;
    if (l === 'nan') return NaN;
    if (l === 'max') return 3.4028234663852886e38;
    const s = t.replace(/^[\0-\x20]+|[\0-\x20]+$/g, '');
    if (!JAVA_FLOAT.test(s)) return null;
    const neg = s.charAt(0) === '-';
    const u = /^[+-]/.test(s) ? s.slice(1) : s;
    let v;
    if (u === 'NaN') v = NaN;
    else if (u === 'Infinity') v = neg ? -Infinity : Infinity;
    else v = (neg ? -1 : 1) * parseFloat(u.replace(/[fFdD]$/, ''));
    return Math.fround(v);
  }

  // FloatBlitter. `out` and `s` are Float32Array: a store rounds to float, as Java's float assignment.
  // `dbz` = FloatBlitter.divideByZeroValue (default +Infinity).
  function floatKernel(op, dbz) {
    switch (op) {
      case 'add': return (out, o, s, n) => { for (let i = 0; i < n; i++) out[o + i] = s[i] + out[o + i]; };
      case 'subtract': return (out, o, s, n) => { for (let i = 0; i < n; i++) out[o + i] = out[o + i] - s[i]; };
      case 'multiply': return (out, o, s, n) => { for (let i = 0; i < n; i++) out[o + i] = s[i] * out[o + i]; };
      case 'divide':
        // FloatBlitter: "boolean useDBZValue = !Float.isInfinite(divideByZeroValue);" with the default
        // divideByZeroValue = Float.POSITIVE_INFINITY, useDBZValue is false, so
        // "pixels[dstIndex] = pixels[dstIndex]/src;" is IEEE division: x/0 = +-Infinity, 0/0 = NaN.
        // Otherwise "if (useDBZValue && src==0.0) pixels[dstIndex] = divideByZeroValue; else pixels[dstIndex] = pixels[dstIndex]/src;"
        // (a NaN value is not infinite, so it is used too; -0.0 == 0.0).
        if (dbz !== undefined && dbz !== null && dbz !== Infinity && dbz !== -Infinity) {
          const v = Math.fround(dbz);
          return (out, o, s, n) => { for (let i = 0; i < n; i++) out[o + i] = s[i] === 0 ? v : out[o + i] / s[i]; };
        }
        return (out, o, s, n) => { for (let i = 0; i < n; i++) out[o + i] = out[o + i] / s[i]; };
      case 'and': // "dst = (int)srcPixels[srcIndex++]&(int)pixels[dstIndex];" (int -> float on the store)
        return (out, o, s, n) => { for (let i = 0; i < n; i++) out[o + i] = d2i(s[i]) & d2i(out[o + i]); };
      case 'or': return (out, o, s, n) => { for (let i = 0; i < n; i++) out[o + i] = d2i(s[i]) | d2i(out[o + i]); };
      case 'xor': return (out, o, s, n) => { for (let i = 0; i < n; i++) out[o + i] = d2i(s[i]) ^ d2i(out[o + i]); };
      case 'min': return (out, o, s, n) => { for (let i = 0; i < n; i++) { if (s[i] < out[o + i]) out[o + i] = s[i]; } };
      case 'max': return (out, o, s, n) => { for (let i = 0; i < n; i++) { if (s[i] > out[o + i]) out[o + i] = s[i]; } };
      case 'average': // dst =(srcPixels[srcIndex++]+pixels[dstIndex])/2;  the float sum is rounded to float first
        return (out, o, s, n) => { for (let i = 0; i < n; i++) out[o + i] = Math.fround(s[i] + out[o + i]) / 2; };
      case 'difference': // dst = pixels[dstIndex]-srcPixels[srcIndex]; pixels[dstIndex] = dst<0?-dst:dst;
        return (out, o, s, n) => { for (let i = 0; i < n; i++) { const d = Math.fround(out[o + i] - s[i]); out[o + i] = d < 0 ? -d : d; } };
      case 'copy': return (out, o, s, n) => { for (let i = 0; i < n; i++) out[o + i] = s[i]; };
      case 'transparent-zero': return (out, o, s, n) => { for (let i = 0; i < n; i++) { if (s[i] !== 0) out[o + i] = s[i]; } };
      default: throw ijError('IJ_BAD_ARGS', 'operation');
    }
  }

  // ------------------------------------------------------------------------------------------------
  // imageCalculator
  // params { op, float32?, all?, channel1?, channel2? }  docIds [image1, image2]; view = image1.
  // ------------------------------------------------------------------------------------------------
  function calcShape(info, params) {
    const o = info.docs && info.docs.length ? info.docs[0] : null;   // image2 when it is another document
    const w2 = o ? o.width : info.width, h2 = o ? o.height : info.height;
    const outBd = params.float32 ? 32 : info.bitDepth;
    return { w: Math.min(info.width, w2), h: Math.min(info.height, h2), outBd, other: o };
  }

  function validateCalc(params, info) {
    if (!params || CALC_OPS.indexOf(params.op) < 0) throw ijError('IJ_BAD_ARGS', 'operation');
    if (params.float32 !== undefined && typeof params.float32 !== 'boolean') throw ijError('IJ_BAD_ARGS', 'float32');
    // Edit > Options > Misc. "Divide by zero value:" as typed; absent = +Infinity (plain IEEE division, today's behaviour)
    if (params.divZero !== undefined && (typeof params.divZero !== 'string' || params.divZero.length > 64 || parseDivZero(params.divZero) === null)) throw ijError('IJ_BAD_ARGS', 'divZero');
    const other = info.docs && info.docs.length ? info.docs[0] : null;   // unknown when the request did not name docIds (a size estimate)
    if (params.all) {
      if (other && other.channels !== info.channels) throw ijError('IJ_BAD_ARGS', 'channel counts differ');
    } else {
      if (!Number.isInteger(params.channel1) || params.channel1 < 0 || params.channel1 >= info.channels) throw ijError('IJ_BAD_ARGS', 'channel1');
      if (!Number.isInteger(params.channel2) || params.channel2 < 0 || (other && params.channel2 >= other.channels)) throw ijError('IJ_BAD_ARGS', 'channel2');
    }
  }

  // IJImage.defaultDisplay semantics of a new result (resetMinAndMax for 16 / 32 bits, 0..255 for 8 bits).
  // keepRange: an 8-bit result keeps Image1's range — ByteProcessor.createProcessor: "if (baseCM!=null)
  // ip2.setMinAndMax(min, max);", and ImageCalculator.doOperation resets the range only
  // "if (!(ip1 instanceof ByteProcessor))" (the temporary-float Multiply/Divide path is left to the default).
  function resultDisplay(data, bd, src, keepRange) {
    const IJImage = root.IJImage;
    const d = IJImage ? IJImage.defaultDisplay({ data }, bd) : { min: 0, max: bd === 8 ? 255 : 1, lut: 'Grays', invert: false };
    if (keepRange && src && src.min !== undefined && src.max !== undefined) { d.min = src.min; d.max = src.max; }
    return { min: d.min, max: d.max, lut: src && src.lut !== undefined ? src.lut : d.lut, invert: !!(src && src.invert) };
  }

  R.define('imageCalculator', {
    kind: 'newdoc', version: 1, roi: 'ignore',
    validate: validateCalc,
    scratchBytes(info, params) {
      const s = calcShape(info, params || {});
      const n = params && params.all ? info.channels : 1;
      return s.w * s.h * n * bytesOf(s.outBd) + 8 * s.w * 4;
    },
    async run(view, params, roi, io) {
      if (CALC_OPS.indexOf(params.op) < 0) throw ijError('IJ_BAD_ARGS', 'operation');
      const id2 = Array.isArray(io.docIds) && io.docIds.length > 1 ? io.docIds[1] : view.id;
      const v2 = id2 === view.id ? view : io.readDoc(id2);
      if (params.all && v2.channels.length !== view.channels.length) throw ijError('IJ_BAD_ARGS', 'channel counts differ');
      const idx = params.all ? view.channels.map((c, i) => i) : [params.channel1];
      const idx2 = params.all ? idx : [params.channel2];
      if (idx[0] >= view.channels.length || idx2[0] >= v2.channels.length) throw ijError('IJ_BAD_ARGS', 'channel');
      // ImageCalculator.createNewImage: "int width = Math.min(ip1.getWidth(), ip2.getWidth()); ... ip3 =
      // ip1.createProcessor(width, height); ... ip3.insert(ip1, 0, 0);" — the smaller of the two rectangles.
      const w = Math.min(view.width, v2.width), h = Math.min(view.height, v2.height);
      // doOperation: "if (floatResult && !rgb) ip2 = ip2.convertToFloat();" and createNewImage converts ip1:
      // a 32-bit result holds both inputs as plain floats.
      const outBd = params.float32 ? 32 : view.bitDepth;
      const Ctor = ctorOf(outBd);
      const max = outBd === 8 ? 255 : 65535;
      const intDst = outBd !== 32;
      const op = params.op;
      // ByteProcessor/ShortProcessor.copyBits: "boolean temporaryFloat = ip.getBitDepth()==32 &&
      // (mode==Blitter.MULTIPLY || mode==Blitter.DIVIDE);" — the integer destination is converted to float,
      // the FloatBlitter runs, setPixels(1, ipFloat) rounds back ("value = fPixels[i] + 0.5f; ... (byte)value").
      const tempFloat = intDst && v2.bitDepth === 32 && (op === 'multiply' || op === 'divide');
      const dbz = params.divZero === undefined ? undefined : parseDivZero(params.divZero);
      const kernel = tempFloat ? floatKernel(op, dbz) : (intDst ? intKernel(op, max) : floatKernel(op, dbz));
      const outputs = [];
      const rowsPerTick = Math.max(1, Math.floor((1 << 20) / w));
      const srow = tempFloat || !intDst ? new Float32Array(w) : new Int32Array(w);
      const drow = tempFloat ? new Float32Array(w) : null;
      for (let k = 0; k < idx.length; k++) {
        const ch1 = view.channels[idx[k]], ch2 = v2.channels[idx2[k]];
        const read = rowReader(v2.bitDepth, tempFloat ? 32 : outBd, ch2.display || { min: 0, max: 255 });
        const out = new Ctor(w * h);
        const src1 = ch1.data;
        for (let y = 0; y < h; y++) {
          const o = y * w, o1 = y * view.width;
          // ip3.insert(ip1, 0, 0): the top-left w x h rectangle of image 1 (a plain copy, or ip1.convertToFloat()).
          if (outBd === view.bitDepth) out.set(src1.subarray(o1, o1 + w), o);
          else for (let i = 0; i < w; i++) out[o + i] = src1[o1 + i];
          read(ch2.data, y * v2.width, w, srow);
          if (tempFloat) {
            for (let i = 0; i < w; i++) drow[i] = out[o + i];
            kernel(drow, 0, srow, w);
            for (let i = 0; i < w; i++) {
              let v = Math.fround(drow[i] + 0.5);
              if (v < 0) v = 0;
              if (v > max) v = max;
              out[o + i] = d2i(v);
            }
          } else kernel(out, o, srow, w);
          if ((y + 1) % rowsPerTick === 0 || y === h - 1) {
            io.check();
            await io.tick((k + (y + 1) / h) / idx.length, 'op.imageCalculator');
          }
        }
        outputs.push({ name: ch1.name, color: ch1.color, data: out, display: resultDisplay(out, outBd, ch1.display, outBd === 8 && !tempFloat) });
      }
      // Calculator result: new ImagePlus("Result of "+img1.getTitle(), ip1); img3.setCalibration(cal1).
      return [{
        name: 'Result of ' + view.name, width: w, height: h, bitDepth: outBd,
        calibration: view.calibration ? Object.assign({}, view.calibration) : view.calibration, channels: outputs
      }];
    }
  });

  // ------------------------------------------------------------------------------------------------
  // splitChannels   ChannelSplitter.split: titles "C"+c+"-"+imp.getTitle(), calibration of the source.
  // ------------------------------------------------------------------------------------------------
  R.define('splitChannels', {
    kind: 'newdoc', version: 1, roi: 'ignore',
    validate(params, info) { if (info.channels < 2) throw ijError('IJ_MULTI_SINGLE_CHANNEL', 'multichannel image required'); },
    scratchBytes: (info) => info.width * info.height * info.channels * bytesOf(info.bitDepth),
    async run(view, params, roi, io) {
      const n = view.channels.length;
      if (n < 2) throw ijError('IJ_MULTI_SINGLE_CHANNEL', 'multichannel image required');
      const out = [];
      for (let c = 0; c < n; c++) {
        const ch = view.channels[c];
        out.push({
          name: 'C' + (c + 1) + '-' + view.name, width: view.width, height: view.height, bitDepth: view.bitDepth,
          calibration: view.calibration ? Object.assign({}, view.calibration) : view.calibration,
          // ChannelSplitter.split: "if (imp.isComposite() && ((CompositeImage)imp).getMode()==IJ.GRAYSCALE) IJ.run(imp2, "Grays", "")"
          channels: [{ name: ch.name, color: ch.color, data: ch.data.slice(), display: view.mode === 'gray' ? Object.assign({}, ch.display, { lut: 'Grays', invert: false }) : Object.assign({}, ch.display) }]
        });
        io.check();
        await io.tick((c + 1) / n, 'op.splitChannels');
      }
      return out;
    }
  });

  // ------------------------------------------------------------------------------------------------
  // mergeChannels   RGBStackMerge.mergeHyperstacks
  // params { sources: [{ docId, slot }], ignoreLuts? }   slot = the C1..C7 the image was picked for.
  // ------------------------------------------------------------------------------------------------
  // RGBStackMerge: Color[] defaultColors = {red, green, blue, white, cyan, magenta, yellow}; the colour of
  // an image is that of the slot it was chosen for ("colors[j] = defaultColors[i]" with i the slot, j the
  // position after the unused slots were dropped).
  const SLOT_COLORS = ['#ff0000', '#00ff00', '#0000ff', '#ffffff', '#00ffff', '#ff00ff', '#ffff00'];

  // ImageProcessor.isColorLut: a display lookup table that is not a grey ramp (normal or inverted).
  // ImageProcessor.isColorLut: "if ((reds[i] != greens[i]) || (greens[i] != blues[i])) return true" — any
  // entry with r, g, b not all equal; a grey ramp of any brightness (or an inverted one) is NOT a colour LUT.
  function isColorLut(ch) {
    const IJLuts = root.IJLuts;
    let l = ch.display ? ch.display.lut : undefined;
    if (l === undefined || l === null) l = ch.color || '#ffffff';
    if (!IJLuts) return typeof l === 'string' ? (l !== 'Grays' && l.toLowerCase() !== '#ffffff') : true;
    let t;
    try { t = IJLuts.get(l); } catch (_) { return false; }
    for (let i = 0; i < 256; i++) if (t[i * 3] !== t[i * 3 + 1] || t[i * 3 + 1] !== t[i * 3 + 2]) return true;
    return false;
  }

  function validateMerge(params) {
    const s = params && params.sources;
    if (!Array.isArray(s) || s.length < 2 || s.length > SLOT_COLORS.length) throw ijError('IJ_MULTI_NEED_TWO', 'two sources at least');
    const seen = new Set();
    for (const e of s) {
      if (!e || !Number.isInteger(e.slot) || e.slot < 0 || e.slot >= SLOT_COLORS.length || seen.has(e.slot) || e.docId === undefined || e.docId === null) throw ijError('IJ_BAD_ARGS', 'sources');
      seen.add(e.slot);
    }
  }

  R.define('mergeChannels', {
    kind: 'newdoc', version: 1, roi: 'ignore',
    validate: validateMerge,
    scratchBytes: (info, params) => info.width * info.height * (params && params.sources ? params.sources.length : info.channels) * bytesOf(info.bitDepth),
    async run(view, params, roi, io) {
      validateMerge(params);
      const sources = params.sources.slice().sort((a, b) => a.slot - b.slot);
      const views = sources.map((s) => (s.docId === view.id ? view : io.readDoc(s.docId)));
      const first = views[0];
      for (const v of views) {
        // RGBStackMerge.mergeStacks: "Source hyperstacks cannot have more than 1 channel." / "The source
        // images or stacks must have the same width and height." / "The source images must have the same bit depth."
        if (v.channels.length !== 1) throw ijError('IJ_MULTI_NOT_SINGLE', 'source with several channels');
        if (v.width !== first.width || v.height !== first.height) throw ijError('IJ_SIZE_MISMATCH', 'sizes differ');
        if (v.bitDepth !== first.bitDepth) throw ijError('IJ_MULTI_DEPTH_MISMATCH', 'bit depths differ');
      }
      const IJLuts = root.IJLuts;
      // "if (c<colors.length && colors[c]!=null && (ignoreLuts||allGrayLuts)) lut = LUT.createLutFromColor(colors[c]);
      //  lut.min = ip.getMin(); lut.max = ip.getMax(); else lut = new LUT(cm, ip.getMin(), ip.getMax());"
      const allGray = views.every((v) => !isColorLut(v.channels[0]));
      const useDefault = !!params.ignoreLuts || allGray;
      const channels = [];
      for (let i = 0; i < views.length; i++) {
        const src = views[i].channels[0];
        if (useDefault) {
          const color = SLOT_COLORS[sources[i].slot];
          channels.push({ name: src.name, color, data: src.data.slice(), display: { min: src.display.min, max: src.display.max, lut: IJLuts ? IJLuts.forColor(color) : 'Grays', invert: false } });
        } else {
          channels.push({ name: src.name, color: src.color, data: src.data.slice(), display: Object.assign({}, src.display) });
        }
        io.check();
        await io.tick((i + 1) / views.length, 'op.mergeChannels');
      }
      // "String title = imp.getTitle(); if (title.startsWith("C1-")) title = title.substring(3); else
      //  title = frames>1?"Merged":"Composite";"  (frames is always 1 here)
      const t0 = first.name;
      const name = t0.indexOf('C1-') === 0 ? t0.substring(3) : 'Composite';
      return [{
        name, width: first.width, height: first.height, bitDepth: first.bitDepth,
        calibration: first.calibration ? Object.assign({}, first.calibration) : first.calibration, channels
      }];
    }
  });

  // ------------------------------------------------------------------------------------------------
  // arrangeChannels   ChannelArranger.run(img, newOrder): the new channel list, from `order` (0-based).
  // ------------------------------------------------------------------------------------------------
  function validateArrange(params, info) {
    const o = params && params.order;
    if (!Array.isArray(o) || o.length < 1) throw ijError('IJ_BAD_ARGS', 'order');
    if (info.channels < 2) throw ijError('IJ_MULTI_SINGLE_CHANNEL', 'more than one channel needed');
    // ChannelArranger.run(): "if (nChannels>9) IJ.error(... does not work with more than 9 channels)".
    if (info.channels > 9) throw ijError('IJ_MULTI_TOO_MANY', 'more than 9 channels');
    if (o.length > info.channels) throw ijError('IJ_BAD_ARGS', 'order');
    const seen = new Set();
    for (const v of o) {
      // "if (index<0 || index>=channels.length) throw new IllegalArgumentException("value out of range")".
      // The dialog (textValueChanged) never lets a digit appear twice: one array may not stand in two channels.
      if (!Number.isInteger(v) || v < 0 || v >= info.channels || seen.has(v)) throw ijError('IJ_BAD_ARGS', 'order');
      seen.add(v);
    }
  }

  R.define('arrangeChannels', {
    kind: 'size', version: 1, roi: 'ignore',
    validate: validateArrange,
    scratchBytes: () => 0,
    // The display state is not journaled: whether each channel is grey and its display range are copied into the
    // params when the step is accepted (never on a replay), so a reload replays the colours the operator saw.
    resolve(view, params) {
      if (params.disp) return params;
      return Object.assign({}, params, { disp: view.channels.map((ch) => {
        const d = ch.display || {};
        return { grey: !isColorLut(ch), min: Number.isFinite(d.min) ? d.min : 0, max: Number.isFinite(d.max) ? d.max : 0 };
      }) });
    },
    async run(view, params, roi, io) {
      validateArrange(params, { channels: view.channels.length });
      const order = params.order;
      if (order.length === view.channels.length && order.every((v, i) => v === i)) return null;   // nothing to do
      // The arrays are kept by reference; name, colour and display follow the array.
      // ChannelArranger.run -> RGBStackMerge.mergeChannels(channels2, false): "if (c<colors.length &&
      // colors[c]!=null && (ignoreLuts||allGrayLuts)) lut = LUT.createLutFromColor(colors[c])" — when every
      // kept channel is grey the new position gets the slot colour (red, green, blue, white, cyan, ...).
      const disp = params.disp || view.channels.map((ch) => ({ grey: !isColorLut(ch), min: ch.display ? ch.display.min : 0, max: ch.display ? ch.display.max : 0 }));
      const allGray = order.every((c) => disp[c] && disp[c].grey);
      const IJLuts = root.IJLuts;
      const channels = order.map((c, i) => {
        const ch = { data: view.channels[c].data };
        if (allGray && i < SLOT_COLORS.length) {
          const src = view.channels[c], color = SLOT_COLORS[i];
          ch.color = color;
          ch.display = { min: disp[c].min, max: disp[c].max, lut: IJLuts ? IJLuts.forColor(color) : 'Grays', invert: false };
        }
        return ch;
      });
      io.check();
      // Deliberate departure from ImageJ: ChannelArranger does "img2.setPosition(newOrder[channel-1], ...)",
      // which lands on the channel that moved INTO the old position's number. Here the channel on screen
      // stays on screen when it is kept (its new position), else the first.
      const a = order.indexOf(view.active);
      return { width: view.width, height: view.height, bitDepth: view.bitDepth, channels, active: a >= 0 ? a : 0 };
    }
  });

  root.IJMulti = { CALC_OPS, SLOT_COLORS, isColorLut, intKernel, floatKernel, parseDivZero };
})(typeof self !== 'undefined' ? self : globalThis);
