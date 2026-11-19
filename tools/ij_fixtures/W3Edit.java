import ij.*;
import ij.gui.*;
import ij.io.*;
import ij.plugin.*;
import ij.plugin.filter.Filler;
import ij.process.*;
import java.awt.Color;
import java.awt.image.IndexColorModel;
import java.nio.file.*;
import java.util.*;

/** edit: paste Blitter modes, Filler.draw widths, NewImage fills, conversions, full-range invert, Duplicator channels, Montage, LUTs. */
final class W3Edit {
    static void run() throws Exception {
        paste();
        draw();
        newImage();
        conversions();
        invertFullRange();
        duplicator();
        montage();
        System.err.println("[edit] luts");
        luts();
        lutFiles();
    }

    static final String[] PASTE = {"Copy", "Blend", "Difference", "Transparent-white", "Transparent-zero", "AND", "OR", "XOR", "Add", "Subtract", "Multiply", "Divide", "Min", "Max"};
    static final int[] PASTE_MODE = {Blitter.COPY, Blitter.AVERAGE, Blitter.DIFFERENCE, Blitter.COPY_TRANSPARENT, Blitter.COPY_ZERO_TRANSPARENT, Blitter.AND, Blitter.OR, Blitter.XOR,
        Blitter.ADD, Blitter.SUBTRACT, Blitter.MULTIPLY, Blitter.DIVIDE, Blitter.MIN, Blitter.MAX};

    static ImageProcessor clip(int bits, int w, int h) {
        ImageProcessor c = Gen.noise(bits, w, h, 800 + bits);
        for (int i = 0; i < w * h; i += 5) c.setf(i % w, i / w, 0f);               // zeros: Divide by zero / transparent-zero
        float mx = bits == 8 ? 255 : bits == 16 ? 65535 : 1000f;
        for (int i = 3; i < w * h; i += 7) c.setf(i % w, i / w, mx);
        if (bits == 8) for (int i = 1; i < w * h; i += 11) c.setf(i % w, i / w, 255);   // white pixels (Transparent-white)
        return c;
    }

    static ImageProcessor dest(int bits, int w, int h) {
        ImageProcessor d = Gen.noise(bits, w, h, 900 + bits);
        float mx = bits == 8 ? 255 : bits == 16 ? 65535 : 1000f;
        for (int i = 0; i < w * h; i += 6) d.setf(i % w, i / w, 0f);
        for (int i = 2; i < w * h; i += 9) d.setf(i % w, i / w, mx);
        return d;
    }

    /** The interactive paste: ip.copyBits(clip, x+xoffset, y+yoffset, mode) then, for a non-rectangular selection, ip.reset(mask). */
    static void paste() throws Exception {
        for (int bits : new int[]{8, 16, 32}) {
            ImageProcessor dst = dest(bits, 24, 18);
            ImageProcessor src = clip(bits, 10, 8);
            List<Object> cases = new ArrayList<>();
            int[][] pos = {{5, 4}, {-3, -2}, {20, 14}, {0, 0}};
            double[] dbz = bits == 32 ? new double[]{Double.POSITIVE_INFINITY, 0.0, 3.5} : new double[]{0};
            for (double dv : dbz) for (int m = 0; m < PASTE.length; m++) for (int[] p : pos) for (int shape = 0; shape < 2; shape++) {
                if (bits == 32 && !Double.isInfinite(dv) && PASTE_MODE[m] != Blitter.DIVIDE) continue;   // the divide-by-zero value only matters for Divide
                if (shape == 1 && (p[0] < 0 || p[1] < 0 || p[0] + 10 > 24 || p[1] + 8 > 18)) continue;   // the mask case needs the whole selection inside the image
                if (bits == 32) FloatBlitter.divideByZeroValue = (float) dv;
                ImageProcessor ip = dst.duplicate();
                ip.snapshot();
                ip.copyBits(src, p[0], p[1], PASTE_MODE[m]);
                if (shape == 1) {   // oval selection of the clipboard's size at (x,y): pixels outside the mask are restored
                    OvalRoi oval = new OvalRoi(p[0], p[1], 10, 8);
                    ImageProcessor mask = oval.getMask();
                    // Restore the pixels outside the oval (ImagePlus.paste / Roi.updatePaste: ip.reset(ip.getMask()))
                    ip.setRoi(oval.getBounds());
                    ip.setMask(mask);
                    ip.reset(ip.getMask());
                }
                cases.add(J.o("params", J.o("mode", PASTE[m], "blitter", PASTE_MODE[m], "x", p[0], "y", p[1], "ovalMask", shape == 1, "divideByZero", bits == 32 ? dv : null), "output", J.image(ip)));
            }
            FloatBlitter.divideByZeroValue = Float.POSITIVE_INFINITY;
            new Fx("edit", "paste_" + Gen.bits(bits), "paste")
                .call("ImagePlus.paste (macro branch): ip.copyBits(clipboard, x, y, mode) with Roi.setPasteMode = PasteController's choice; a non-rectangular selection snapshots first and ip.reset(mask) afterwards; 32-bit Divide uses FloatBlitter.divideByZeroValue (+Infinity = plain IEEE)")
                .put("destination", J.image(dst)).put("clipboard", J.image(src)).put("cases", cases).write();
        }
    }

    static void draw() throws Exception {
        List<Object> cases = new ArrayList<>();
        Roi[] rois = {new Roi(6, 5, 20, 14), new OvalRoi(5, 4, 22, 16), W3Sel.intPoly(Roi.POLYGON, 5, 4, 30, 8, 36, 26, 20, 20, 8, 28), new Line(4, 28, 36, 6),
            W3Sel.intPoly(Roi.POLYLINE, 4, 26, 14, 6, 24, 24, 36, 8), W3Sel.freehand(), W3Sel.traced(), W3Sel.holed(),
            W3Sel.intPoly(Roi.ANGLE, 6, 30, 20, 10, 34, 30), new PointRoi(new int[]{10, 30, 46}, new int[]{10, 8, 20}, 3), W3Sel.intPoly(Roi.FREELINE, 4, 26, 9, 12, 14, 7, 22, 12, 30, 22, 40, 20)};
        String[] nm = {"rect", "oval", "polygon", "line", "polyline", "freehand", "traced", "holed", "angle", "point", "freeline"};
        int w = 64, h = 48;
        Color[] fg = {Color.white, new Color(128, 128, 128)};
        for (int bits : new int[]{8, 16, 32}) {
            double bg = bits == 8 ? 20 : bits == 16 ? 2000 : 0.5;
            for (int i = 0; i < rois.length; i++) for (int lw : new int[]{1, 2, 5}) for (int f = 0; f < fg.length; f++) {
                ImageProcessor ip = bits == 8 ? new ByteProcessor(w, h) : bits == 16 ? new ShortProcessor(w, h) : new FloatProcessor(w, h);
                for (int k = 0; k < w * h; k++) ip.setf(k, (float) bg);
                if (bits == 16) ip.setMinAndMax(0, 4000);
                if (bits == 32) ip.setMinAndMax(0, 1);
                ImagePlus imp = Gen.imp("d", ip);
                Roi r = (Roi) rois[i].clone();
                r.setStrokeWidth(lw);
                imp.setRoi(r);
                ij.gui.Toolbar.setForegroundColor(fg[f]);
                Filler fl = new Filler();
                fl.setup("draw", imp);
                ip.setRoi(r);
                fl.run(ip);
                ip.resetRoi();
                List<Object> changed = new ArrayList<>();
                for (int k = 0; k < w * h; k++) if (ip.getf(k) != (float) bg) { changed.add(new double[]{k, ip.getf(k)}); }
                cases.add(J.o("bitDepth", bits, "roi", nm[i], "lineWidth", lw, "foreground", f == 0 ? "white" : "gray128", "foregroundValue", ip.getForegroundValue(), "changed", changed));
            }
        }
        ij.gui.Toolbar.setForegroundColor(Color.white);
        List<Object> rl = new ArrayList<>();
        for (int i = 0; i < rois.length; i++) rl.add(J.o("name", nm[i], "roi", W3Sel.roiFull(rois[i])));
        new Fx("edit", "draw", "draw")
            .call("Filler.setup(\"draw\", imp); Filler.run(ip): ip.setGlobalForegroundColor(); roi.drawPixels(ip) with roi.setStrokeWidth(lineWidth); background constant on a 64x48 image; `changed` = [pixelIndex, value] of every pixel that differs from the background (values are the type's own: 16-bit display range 0..4000, 32-bit 0..1; foregroundValue = ip.getForegroundValue() after the call)")
            .put("width", w).put("height", h).put("background", J.o("8", 20, "16", 2000, "32", 0.5)).put("rois", rl).put("cases", cases).write();
    }

    static void newImage() throws Exception {
        List<Object> cases = new ArrayList<>();
        String[] fills = {"White", "Black", "Ramp", "Noise"};
        int[] opts = {NewImage.FILL_WHITE, NewImage.FILL_BLACK, NewImage.FILL_RAMP, NewImage.FILL_NOISE};
        for (int bits : new int[]{8, 16, 32}) for (int f = 0; f < 4; f++) for (long seed : f == 3 ? new long[]{1, 42} : new long[]{0}) for (int[] sz : new int[][]{{20, 10}, {16, 16}}) {
            ImageProcessor.setRandomSeed(seed);
            ImagePlus imp = NewImage.createImage("Untitled", sz[0], sz[1], 1, bits, opts[f]);
            ImageProcessor ip = imp.getProcessor();
            cases.add(J.o("params", J.o("type", bits + "-bit", "fill", fills[f], "width", sz[0], "height", sz[1], "seed", f == 3 ? seed : null),
                "output", J.image(ip), "invertedLut", ip.isInvertedLut(), "displayMin", ip.getMin(), "displayMax", ip.getMax()));
        }
        java.lang.reflect.Field t = NewImage.class.getDeclaredField("staticType"), fl = NewImage.class.getDeclaredField("staticFillWith"),
            wd = NewImage.class.getDeclaredField("staticWidth"), ht = NewImage.class.getDeclaredField("staticHeight");
        t.setAccessible(true); fl.setAccessible(true); wd.setAccessible(true); ht.setAccessible(true);
        new Fx("edit", "new_image", "newImage")
            .call("NewImage.createImage(title, w, h, 1, bitDepth, FILL_*) with ImageProcessor.setRandomSeed(seed) before Noise; defaults = the static first-use values read by reflection with clean preferences (type index 0=8-bit, fill index into {White, Black, Ramp, Noise})")
            .put("firstUseDefaults", J.o("typeIndex", t.get(null), "fillIndex", fl.get(null), "fill", fills[(Integer) fl.get(null)], "width", wd.get(null), "height", ht.get(null)))
            .put("cases", cases).write();
    }

    static ImageProcessor wide(int bits, int w, int h) {
        ImageProcessor ip = Gen.noise(bits, w, h, 1234 + bits);
        if (bits == 32) { float[] p = (float[]) ip.getPixels(); p[0] = Float.NaN; p[1] = -300f; p[2] = 70000f; p[3] = 0.4f; p[4] = 254.5f; }
        if (bits == 16) { ip.set(0, 0); ip.set(1, 65535); ip.set(2, 300); }
        return ip;
    }

    /** Edit > Options > Conversions "Scale when converting" off/on, via ImageConverter exactly as Image > Type. */
    static void conversions() throws Exception {
        List<Object> cases = new ArrayList<>();
        Object[][] jobs = {{16, 8}, {32, 8}, {32, 16}, {16, 32}, {8, 16}, {8, 32}};
        double[][] ranges = {{0, 0}, {100, 5000}, {-50, 300}};
        for (Object[] j : jobs) for (int sc = 0; sc < 2; sc++) for (double[] r : ranges) {
            int from = (Integer) j[0], to = (Integer) j[1];
            if (from == 8 && r[0] != 0) continue;
            ImageProcessor ip = wide(from, 12, 10);
            if (r[0] != 0 || r[1] != 0) ip.setMinAndMax(r[0], r[1]);
            else ip.resetMinAndMax();
            double dmin = ip.getMin(), dmax = ip.getMax();
            ImagePlus imp = Gen.imp("c", ip.duplicate());
            imp.getProcessor().setMinAndMax(dmin, dmax);
            ImageConverter.setDoScaling(sc == 1);
            ImageConverter ic = new ImageConverter(imp);
            if (to == 8) ic.convertToGray8(); else if (to == 16) ic.convertToGray16(); else ic.convertToGray32();
            ImageConverter.setDoScaling(true);
            cases.add(J.o("params", J.o("from", from, "to", to, "scale", sc == 1, "displayMin", dmin, "displayMax", dmax), "input", J.image(ip), "output", J.image(imp.getProcessor()),
                "outDisplayMin", imp.getProcessor().getMin(), "outDisplayMax", imp.getProcessor().getMax()));
        }
        new Fx("edit", "conversions", "convert")
            .call("ImageConverter.setDoScaling(scale); new ImageConverter(imp).convertToGray8()/16()/32() after ip.setMinAndMax(display range) [Image > Type with Edit > Options > Conversions 'Scale when converting']")
            .put("cases", cases).write();
    }

    static void invertFullRange() throws Exception {
        List<Object> cases = new ArrayList<>();
        for (int bits : new int[]{16, 32}) for (int full = 0; full < 2; full++) for (int dr = 0; dr < 2; dr++) {
            ImageProcessor ip = wide(bits, 10, 8);
            if (bits == 32) { float[] p = (float[]) ip.getPixels(); p[0] = 5f; }
            ip = ip.duplicate();
            if (dr == 1) ip.setMinAndMax(bits == 16 ? 1000 : -10, bits == 16 ? 30000 : 120);
            Prefs.fullRange16bitInversions = full == 1;
            ImageProcessor o = ip.duplicate();
            o.invert();
            cases.add(J.o("params", J.o("bitDepth", bits, "fullRange16bitInversions", full == 1, "displayRangeSet", dr == 1), "input", J.image(ip), "output", J.image(o), "outMin", o.getMin(), "outMax", o.getMax()));
        }
        Prefs.fullRange16bitInversions = false;
        new Fx("edit", "invert_full_range", "invert")
            .call("Prefs.fullRange16bitInversions=<flag>; ip.invert() (ShortProcessor: resetMinAndMax then v'=max-(v-min) unless full range 0..65535; FloatProcessor: min/max of the current display range)")
            .put("cases", cases).write();
    }

    static CompositeImage composite3(int w, int h, int bits) {
        ImageStack st = new ImageStack(w, h);
        for (int c = 0; c < 3; c++) st.addSlice(Gen.tex(bits, w, h, 70 + c));
        ImagePlus imp = new ImagePlus("comp", st);
        imp.setDimensions(3, 1, 1);
        CompositeImage ci = new CompositeImage(imp, IJ.COMPOSITE);
        Color[] cols = {Color.red, Color.green, Color.blue};
        for (int c = 0; c < 3; c++) { ci.setChannelLut(LUT.createLutFromColor(cols[c]), c + 1); ci.setC(c + 1); ci.setDisplayRange(bits == 8 ? 10 + 5 * c : 2000 + 500 * c, bits == 8 ? 200 - 10 * c : 40000 - 3000 * c); ci.setC(c + 1); }
        return ci;
    }

    static Object chInfo(ImagePlus imp) {
        List<Object> chs = new ArrayList<>();
        int n = imp.getNChannels();
        for (int c = 1; c <= n; c++) {
            ImageProcessor ip = imp.getStack().getProcessor(imp.getStackIndex(c, 1, 1));
            LUT lut = imp.isComposite() ? ((CompositeImage) imp).getChannelLut(c) : null;
            double mn = 0, mx = 0;
            if (imp.isComposite()) { ((CompositeImage) imp).setC(c); mn = imp.getDisplayRangeMin(); mx = imp.getDisplayRangeMax(); }
            chs.add(J.o("data", J.image(ip), "lutColor", lut == null ? null : String.format("#%02x%02x%02x", lut.getRed(255), lut.getGreen(255), lut.getBlue(255)), "displayMin", mn, "displayMax", mx));
        }
        return chs;
    }

    static void duplicator() throws Exception {
        List<Object> cases = new ArrayList<>();
        int[][] rng = {{1, 3}, {2, 3}, {2, 2}, {1, 1}, {1, 2}};
        for (int bits : new int[]{8, 16}) for (int[] r : rng) for (int sel = 0; sel < 3; sel++) {
            CompositeImage ci = composite3(20, 16, bits);
            Roi roi = sel == 1 ? new Roi(4, 3, 10, 8) : sel == 2 ? new OvalRoi(3, 2, 12, 10) : null;
            if (roi != null) ci.setRoi((Roi) roi.clone());
            Object out;
            try {
                ImagePlus d = new Duplicator().run(ci, r[0], r[1], 1, 1, 1, 1);
                out = J.o("channels", d.getNChannels(), "width", d.getWidth(), "height", d.getHeight(), "isComposite", d.isComposite(), "per", chInfo(d), "roiAfter", d.getRoi() == null ? null : W3Sel.roiFull(d.getRoi()));
            } catch (Throwable t) { out = J.o("error", String.valueOf(t)); }
            cases.add(J.o("params", J.o("bitDepth", bits, "firstC", r[0], "lastC", r[1], "selection", sel == 0 ? "none" : sel == 1 ? "rect" : "oval"),
                "selectionRoi", roi == null ? null : W3Sel.roiFull(roi), "result", out));
        }
        CompositeImage ci = composite3(20, 16, 8);
        new Fx("edit", "duplicator_channels", "duplicate")
            .call("new Duplicator().run(imp, firstC, lastC, 1, 1, 1, 1) on a 3-channel COMPOSITE (red/green/blue LUTs, per-channel display ranges): cropped to the selection bounds (an oval's pixels outside the mask stay as in the source), LUTs and ranges copied per channel")
            .put("source", chInfo(ci)).put("cases", cases).write();
    }

    static void montage() throws Exception {
        List<Object> cases = new ArrayList<>();
        for (int bits : new int[]{8, 16}) {
            CompositeImage ci = composite3(24, 20, bits);
            // MontageMaker.run on a composite: COLOR mode, one ColorProcessor per channel (imp.getImage() = the rendered channel through its LUT and display range)
            ci.setMode(IJ.COLOR);
            ImageStack stack = new ImageStack(24, 20);
            List<Object> tiles = new ArrayList<>();
            for (int c = 1; c <= 3; c++) {
                ci.setPosition(c, 1, 1);
                ColorProcessor cp = new ColorProcessor(ci.getImage());
                stack.addSlice(null, cp);
                tiles.add(rgb(cp));
            }
            ci.setMode(IJ.COMPOSITE);
            double[][] opts = {{2, 2, 1.0, 0}, {3, 1, 1.0, 2}, {2, 2, 0.5, 0}, {1, 3, 1.0, 1}};
            for (double[] o : opts) {
                ImagePlus imp = new ImagePlus("m", stack);
                MontageMaker mm = new MontageMaker();
                ImagePlus out = mm.makeMontage2(imp, (int) o[0], (int) o[1], o[2], 1, 3, 1, (int) o[3], false);
                cases.add(J.o("params", J.o("columns", o[0], "rows", o[1], "scale", o[2], "first", 1, "last", 3, "increment", 1, "border", o[3], "label", false),
                    "output", rgb((ColorProcessor) out.getProcessor()), "width", out.getWidth(), "height", out.getHeight()));
            }
            new Fx("edit", "montage_" + Gen.bits(bits), "montage")
                .call("composite -> COLOR mode, ColorProcessor per channel (rendered through the channel LUT and display range), MontageMaker.makeMontage2(imp, columns, rows, scale, first, last, inc, border, labels=false); planes are the R, G, B bytes of the RGB result")
                .put("sourceChannels", chInfo(composite3(24, 20, bits))).put("tiles", tiles).put("cases", cases).write();
        }
        // default layout for n slices: ImageJ's own MontageMaker run through the command with no columns / rows / scale given (the dialog defaults), output size read back
        List<Object> rule = new ArrayList<>();
        for (int n = 2; n <= 16; n++) {   // n = 1: the command refuses a single image with an error dialog (observed), so it is not a montage case
            ImageStack st = new ImageStack(24, 20);
            for (int k = 0; k < n; k++) { ByteProcessor bp = new ByteProcessor(24, 20); for (int q = 0; q < 480; q++) bp.set(q, (q + k * 7) & 255); st.addSlice(null, bp); }
            ImagePlus src = new ImagePlus("mrule", st);
            src.show();
            IJ.run(src, "Make Montage...", "increment=1 border=0 font=12");
            ImagePlus out = WindowManager.getImage("Montage");
            if (out == null) { rule.add(J.o("n", n, "error", "no Montage window")); src.changes = false; src.close(); continue; }
            int w = out.getWidth(), h = out.getHeight();
            int cols = Math.round(w / 24f), rows = Math.round(h / 20f);   // scale 1 (tiles 24 x 20, border 0)
            rule.add(J.o("n", n, "outputWidth", w, "outputHeight", h, "columns", cols, "rows", rows, "scale", w / (24.0 * cols)));
            out.changes = false; out.close();
            src.changes = false; src.close();
        }
        new Fx("edit", "montage_layout_rule", "montage")
            .call("IJ.run(stack of n 24x20 8-bit slices, \"Make Montage...\", \"increment=1 border=0 font=12\"): columns / rows / scale not given, so the dialog defaults (MontageMaker's own layout rule) apply; columns = outputWidth/24, rows = outputHeight/20 at scale 1 (tile size 24 x 20 keeps the 0.5 / 0.25 reduction for large montages out of the picture: record `scale`)")
            .put("tile", J.o("width", 24, "height", 20)).put("rule", rule).write();
    }

    static Object rgb(ColorProcessor cp) {
        int n = cp.getWidth() * cp.getHeight();
        byte[] r = new byte[n], g = new byte[n], b = new byte[n];
        cp.getRGB(r, g, b);
        return J.o("width", cp.getWidth(), "height", cp.getHeight(), "r", J.b64(r, "u8", n), "g", J.b64(g, "u8", n), "b", J.b64(b, "u8", n));
    }

    static byte[] lutBytes(IndexColorModel cm) {
        byte[] out = new byte[768];
        byte[] r = new byte[256], g = new byte[256], b = new byte[256];
        cm.getReds(r); cm.getGreens(g); cm.getBlues(b);
        System.arraycopy(r, 0, out, 0, 256); System.arraycopy(g, 0, out, 256, 256); System.arraycopy(b, 0, out, 512, 256);
        return out;
    }

    static void luts() {
        List<Object> cases = new ArrayList<>();
        for (String name : new String[]{"fire", "grays", "ice", "spectrum", "3-3-2 RGB", "red", "green", "blue", "cyan", "magenta", "yellow", "redgreen"}) {
            IndexColorModel cm = LutLoader.getLut(name);
            cases.add(J.o("name", name, "found", cm != null, "rgb768", cm == null ? null : J.b64(lutBytes(cm), "u8", 768)));
        }
        new Fx("edit", "builtin_luts", "lut")
            .call("LutLoader.getLut(name): rgb768 = 256 reds, 256 greens, 256 blues (the built-in generator of Image > Lookup Tables; '3-3-2 RGB' and 'redgreen' = Red/Green)")
            .put("cases", cases).write();
    }

    static byte[] ramp(int n, int shift) { byte[] b = new byte[n]; for (int i = 0; i < n; i++) b[i] = (byte) ((i * 3 + shift) & 255); return b; }

    static void lutFiles() throws Exception {
        Path tmp = Files.createTempDirectory("w3lut");
        List<Object> cases = new ArrayList<>();
        // 1 NIH Image LUT, 256 colours (32-byte header 'ICOL')
        java.io.ByteArrayOutputStream bo = new java.io.ByteArrayOutputStream();
        java.io.DataOutputStream d = new java.io.DataOutputStream(bo);
        d.writeInt(1229147980); d.writeShort(1); d.writeShort(256); d.writeShort(0); d.writeShort(255); d.writeLong(0); d.writeLong(0); d.writeInt(0);
        for (int ch = 0; ch < 3; ch++) for (int i = 0; i < 256; i++) d.writeByte((i * (ch + 1) + 7 * ch) & 255);
        byte[] nih = bo.toByteArray();
        // 2 NIH Image LUT with 16 colours (interpolated to 256)
        bo = new java.io.ByteArrayOutputStream();
        d = new java.io.DataOutputStream(bo);
        d.writeInt(1229147980); d.writeShort(1); d.writeShort(16); d.writeShort(0); d.writeShort(15); d.writeLong(0); d.writeLong(0); d.writeInt(0);
        for (int ch = 0; ch < 3; ch++) for (int i = 0; i < 16; i++) d.writeByte((i * 16 * (ch + 1) / 2 + 3 * ch) & 255);
        byte[] nih16 = bo.toByteArray();
        // 3 raw 768, 4 raw 970 (length 970 = raw LUT with trailing bytes), 5 text (3 columns, 256 rows), 6 text with index column + header row
        byte[] raw768 = new byte[768];
        for (int i = 0; i < 768; i++) raw768[i] = (byte) ((i * 5 + i / 256) & 255);
        byte[] raw970 = Arrays.copyOf(raw768, 970);
        StringBuilder t3 = new StringBuilder(), t4 = new StringBuilder("Index\tRed\tGreen\tBlue\n");
        for (int i = 0; i < 256; i++) {
            int r = raw768[i] & 255, g = raw768[256 + i] & 255, b = raw768[512 + i] & 255;
            t3.append(r).append('\t').append(g).append('\t').append(b).append('\n');
            t4.append(i).append('\t').append(r).append('\t').append(g).append('\t').append(b).append('\n');
        }
        Object[][] files = {{"nih256.lut", nih}, {"raw768.lut", raw768}, {"raw970.lut", raw970},
            {"text3.lut", t3.toString().getBytes("UTF-8")}, {"text4_header.lut", t4.toString().getBytes("UTF-8")}};   // a file ImageJ rejects raises a modal IJ.error, so no 'bad' file is recorded
        for (Object[] f : files) {
            Path p = tmp.resolve((String) f[0]);
            Files.write(p, (byte[]) f[1]);
            System.err.println("[lut] " + f[0]);
            Object res;
            try {
                LUT lut = LutLoader.openLut("noerror:" + p.toString().replace('\\', '/'));
                if (lut == null) res = J.o("null", true);
                else {
                    byte[] out = new byte[768];
                    byte[] r = new byte[256], g = new byte[256], b = new byte[256];
                    lut.getReds(r); lut.getGreens(g); lut.getBlues(b);
                    System.arraycopy(r, 0, out, 0, 256); System.arraycopy(g, 0, out, 256, 256); System.arraycopy(b, 0, out, 512, 256);
                    res = J.b64(out, "u8", 768);
                }
            } catch (Throwable t) { res = J.o("error", String.valueOf(t)); }
            cases.add(J.o("file", f[0], "length", ((byte[]) f[1]).length, "fileB64", Base64.getEncoder().encodeToString((byte[]) f[1]), "rgb768", res));
        }
        new Fx("edit", "lut_files", "lutFile")
            .call("LutLoader.openLut(path): length>768 -> NIH Image 'ICOL' (header 32 bytes, nColors<256 interpolated); else length 0/768/970 -> raw 768; else text (3 columns, or 4 with an index column; 256 rows, or 257/258 with header rows); anything else -> null (error dialog suppressed)")
            .put("cases", cases).write();
    }
}
