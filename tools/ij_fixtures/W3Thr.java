import ij.*;
import ij.plugin.filter.*;
import ij.plugin.Thresholder;
import ij.process.*;
import java.util.*;

/** thr: AutoThresholder (17 methods), 16-bit histogram thresholds, Binary Options matrix, Binary Median, Make Binary mask. */
final class W3Thr {
    static final String[] OPS = {"erode", "dilate", "open", "close", "outline", "fill holes", "skeletonize"};

    static int[][] histograms() {
        Random r = new Random(4242);
        int[][] h = new int[20][256];
        // 0 empty, 1 one bin, 2 two bins, 3 two adjacent bins, 4 uniform
        h[1][100] = 500;
        h[2][50] = 300; h[2][200] = 300;
        h[3][120] = 700; h[3][121] = 200;
        Arrays.fill(h[4], 10);
        for (int i = 0; i < 256; i++) {
            h[5][i] = (int) Math.round(5000 * Math.exp(-(i - 110) * (i - 110) / (2 * 20.0 * 20.0)));                       // unimodal
            h[6][i] = (int) Math.round(4000 * Math.exp(-(i - 50) * (i - 50) / (2 * 8.0 * 8.0)) + 3000 * Math.exp(-(i - 200) * (i - 200) / (2 * 10.0 * 10.0)));
            h[7][i] = (int) Math.round(4000 * Math.exp(-(i - 90) * (i - 90) / (2 * 25.0 * 25.0)) + 3500 * Math.exp(-(i - 150) * (i - 150) / (2 * 25.0 * 25.0)));
            h[8][i] = (int) Math.round(3000 * Math.exp(-(i - 40) * (i - 40) / (2 * 9.0 * 9.0)) + 2500 * Math.exp(-(i - 120) * (i - 120) / (2 * 9.0 * 9.0)) + 2000 * Math.exp(-(i - 210) * (i - 210) / (2 * 9.0 * 9.0)));
            h[9][i] = (int) Math.round(6000 * Math.exp(-i / 30.0));                                                        // skewed
            h[10][i] = (int) Math.round(2500 * Math.exp(-(i - 140) * (i - 140) / (2 * 18.0 * 18.0))); if (i == 0) h[10][i] = 50000;
            h[11][i] = (int) Math.round(2500 * Math.exp(-(i - 90) * (i - 90) / (2 * 18.0 * 18.0))); if (i == 255) h[11][i] = 50000;
            h[12][i] = i == 0 ? 90000 : (int) Math.round(30 * Math.exp(-i / 60.0));
            h[13][i] = r.nextInt(5) == 0 ? r.nextInt(400) : 0;
            h[14][i] = i * 4; h[15][i] = (255 - i) * 4;
            h[17][i] = (int) Math.round(2.0e6 * Math.exp(-(i - 60) * (i - 60) / (2 * 12.0 * 12.0)) + 1.5e6 * Math.exp(-(i - 180) * (i - 180) / (2 * 12.0 * 12.0)));
            h[18][i] = (int) Math.round(8000 * Math.exp(-(i - 128) * (i - 128) / (2 * 3.0 * 3.0)));
            h[19][i] = (i >= 40 && i < 60 ? 2000 : 0) + (i >= 170 && i < 220 ? 1800 : 0) + (int) (r.nextInt(30));
        }
        h[16][10] = 100; h[16][130] = 400; h[16][250] = 100;
        return h;
    }

    static void run() throws Exception {
        methods();
        methods16();
        binaryMatrix();
        binaryLut();
        median();
        mask();
        edmOutputs();
    }

    /** Binary Options "EDM output" (Overwrite / 8-bit / 16-bit / 32-bit) for Distance Map, Ultimate Points and Voronoi, on the disks and lines images. */
    static void edmOutputs() throws Exception {
        String[] ot = {"overwrite", "8-bit", "16-bit", "32-bit"};
        int[] ov = {EDM.BYTE_OVERWRITE, EDM.BYTE, EDM.SHORT, EDM.FLOAT};
        String[][] ops = {{"edm", ""}, {"ultimatePoints", "points"}, {"voronoi", "voronoi"}};
        for (int mi = 0; mi < 2; mi++) {
            ByteProcessor in = mi == 0 ? Gen.touchingDisks(40, 30) : Gen.thinLines(36, 28);
            String nm = mi == 0 ? "disks" : "lines";
            for (String[] op : ops) {
                List<Object> cases = new ArrayList<>();
                for (int t = 0; t < ot.length; t++) {
                    ByteProcessor ip = (ByteProcessor) in.duplicate();
                    ImagePlus imp = Gen.imp("m", ip);
                    Object out;
                    try {
                        EDM.setOutputType(ov[t]);
                        EDM e = new EDM();
                        e.setup(op[1], imp);
                        e.run(ip);
                        ImageProcessor res = ip;
                        if (ov[t] != EDM.BYTE_OVERWRITE) res = ((ImagePlus) Gen.get(e, "outImp")).getProcessor();
                        out = J.image(res);
                    } catch (Throwable ex) { out = J.o("error", String.valueOf(ex)); }
                    cases.add(J.o("params", J.o("output", ot[t], "outputConstant", ov[t]), "output", out));
                }
                EDM.setOutputType(EDM.BYTE_OVERWRITE);
                new Fx("thr", "edm_outputs_" + op[0] + "_" + nm, op[0])
                    .call("Prefs.blackBackground=true; EDM.setOutputType(output); EDM e=new EDM(); e.setup(\"" + op[1] + "\", imp); e.run(ip); output = ip (overwrite) or e.outImp (private, reflection) [Process > Binary > Options 'EDM output']")
                    .input(in).put("cases", cases).write();
            }
        }
    }

    static void methods() {
        int[][] hs = histograms();
        List<Object> hl = new ArrayList<>();
        for (int[] h : hs) hl.add(h);
        LinkedHashMap<String, Object> res = new LinkedHashMap<>();
        for (AutoThresholder.Method m : AutoThresholder.Method.values()) {
            List<Object> row = new ArrayList<>();
            for (int[] h : hs) {
                row.add(timed(m, h, true));
            }
            res.put(m.name(), row);
        }
        LinkedHashMap<String, Object> res2 = new LinkedHashMap<>();   // bilevelSubractOne = false
        for (AutoThresholder.Method m : AutoThresholder.Method.values()) {
            List<Object> row = new ArrayList<>();
            for (int[] h : hs) {
                row.add(timed(m, h, false));
            }
            res2.put(m.name(), row);
        }
        new Fx("thr", "methods256", "autoThresholdLevel")
            .call("new AutoThresholder().getThreshold(Method, int[256])  (bilevelSubractOne default true; second table: setBilevelSubractOne(false))")
            .put("histograms", hl).put("methodOrder", Arrays.asList(AutoThresholder.getMethods()))
            .result(J.o("thresholds", res, "thresholdsNoBilevelSubtract", res2)).write();
    }

    /** One call with a 5 s guard: a degenerate histogram may loop (recorded as "timeout"). */
    static Object timed(AutoThresholder.Method m, int[] h, boolean subtractOne) {
        final Object[] out = new Object[1];
        Thread t = new Thread(() -> {
            try { AutoThresholder at = new AutoThresholder(); at.setBilevelSubractOne(subtractOne); out[0] = at.getThreshold(m, h.clone()); }
            catch (Throwable e) { out[0] = "error: " + e.getClass().getSimpleName(); }
        });
        t.setDaemon(true);
        t.start();
        try { t.join(5000); } catch (InterruptedException e) { }
        if (t.isAlive()) return "timeout";
        return out[0];
    }

    /** 16-bit: ImageProcessor.setAutoThreshold(String): min/max thresholds, with and without the 16-bit histogram. */
    @SuppressWarnings("unchecked")
    static void methods16() {
        ImageProcessor[] imgs = {
            Gen.make(16, Gen.blobs(48, 40, 77, 5, 3, 7, 0.1, 0.1, 0.1, 0.03), 48, 40),
            offset16(48, 40),
            // the 16-bit inputs of fiji/autothreshold/blobs16_<k>.json (tools/ij_fixtures/fiji/FijiRefs.java), so the Fiji levels can be compared with these
            Gen.make(16, Gen.blobs(72, 60, 3, 7, 3, 8, 0.25, 0.15, 0.08, 0.04), 72, 60),
            Gen.make(16, Gen.blobs(72, 60, 5, 5, 4, 9, 0.0, 0.0, 0.2, 0.03), 72, 60)
        };
        String[] names = {"blobs0_60000", "range1500_3200", "fiji_blobs16_0", "fiji_blobs16_1"};
        for (int k = 0; k < imgs.length; k++) {
            List<Object> rows = new ArrayList<>();
            for (AutoThresholder.Method m : AutoThresholder.Method.values())
                for (int dark = 0; dark < 2; dark++) for (int h16 = 0; h16 < 2; h16++) {
                    ImageProcessor ip = imgs[k].duplicate();
                    String s = m.name() + (dark == 1 ? " dark" : "") + (h16 == 1 ? " 16-bit" : "") + " no-lut";
                    final Object[] res = new Object[1];
                    final String fs = s;
                    Thread th = new Thread(() -> {   // a method may loop on a 16-bit histogram (Fiji's own Huang does): 300 s guard, recorded as "timeout"; Huang / RenyiEntropy / Shanbhag on a 16-bit histogram take minutes
                        try { ip.setAutoThreshold(fs); res[0] = J.o("min", ip.getMinThreshold(), "max", ip.getMaxThreshold()); }
                        catch (Throwable t) { res[0] = J.o("error", String.valueOf(t)); }
                    });
                    th.setDaemon(true);
                    th.start();
                    try { th.join(300000); } catch (InterruptedException e) { }
                    Map<String, Object> row = new LinkedHashMap<>();
                    row.put("method", m.name()); row.put("dark", dark == 1); row.put("histogram16", h16 == 1);
                    if (th.isAlive()) row.put("timeout", true); else row.putAll((Map<String, Object>) res[0]);
                    rows.add(row);
                }
            new Fx("thr", "threshold16_" + names[k], "autoThresholdMask")
                .call("ip.setAutoThreshold(\"<Method> [dark] [16-bit] no-lut\") on a ShortProcessor (16-bit histogram trimmed to [minbin,maxbin] when '16-bit'; else resetMinAndMax + 8-bit conversion)")
                .input(imgs[k]).result(rows).write();
        }
    }

    static ImageProcessor offset16(int w, int h) {
        ImageProcessor ip = new ShortProcessor(w, h);
        Random r = new Random(99);
        for (int i = 0; i < w * h; i++) {
            boolean fg = (i / w) % 13 < 5 && (i % w) % 11 < 6;
            ip.set(i, (fg ? 2600 : 1700) + r.nextInt(300) + (i % w) * 2);
        }
        return ip;
    }

    static ByteProcessor mask1() { return Gen.touchingDisks(40, 30); }

    /** Binary Options matrix: iterations x count x padEdges for each op (1 image, shared input). */
    static void binaryMatrix() throws Exception {
        for (int mi = 0; mi < 2; mi++) {
            ByteProcessor in = mi == 0 ? Gen.touchingDisks(40, 30) : Gen.thinLines(36, 28);
            String nm = mi == 0 ? "disks" : "lines";
            for (String op : OPS) {
                List<Object> cases = new ArrayList<>();
                boolean iter = op.equals("erode") || op.equals("dilate") || op.equals("open") || op.equals("close");
                int[] its = iter ? new int[]{1, 3} : new int[]{1};
                int[] cts = iter ? new int[]{1, 4} : new int[]{1};
                for (int it : its) for (int ct : cts) for (int pad = 0; pad < 2; pad++) {
                    ByteProcessor ip = (ByteProcessor) in.duplicate();
                    Prefs.padEdges = pad == 1;
                    Gen.set(new Binary(), "iterations", it);   // static fields, set through any instance
                    Gen.set(new Binary(), "count", ct);
                    Binary b = new Binary();
                    b.setup(op, Gen.imp("m", ip));
                    b.run(ip);
                    cases.add(J.o("params", J.o("op", op, "iterations", it, "count", ct, "padEdges", pad == 1, "blackBackground", true, "foreground", 255), "output", J.image(ip)));
                }
                Prefs.padEdges = false;
                Gen.set(new Binary(), "iterations", 1);
                Gen.set(new Binary(), "count", 1);
                new Fx("thr", "binary_" + nm + "_" + op.replace(' ', '_'), "binary")
                    .call("Prefs.padEdges=<padEdges>; Binary.iterations/count set by reflection; Binary b=new Binary(); b.setup(op, imp); b.run(ip)")
                    .input(in).put("cases", cases).write();
            }
        }
    }

    /** Foreground rule: blackBackground x invertedLut for each op (iterations 1, count 1). */
    static void binaryLut() throws Exception {
        ByteProcessor in = Gen.touchingDisks(40, 30);
        List<Object> cases = new ArrayList<>();
        for (String op : new String[]{"erode", "dilate", "outline", "fill holes", "skeletonize"})
            for (int bb = 0; bb < 2; bb++) for (int inv = 0; inv < 2; inv++) {
                ByteProcessor ip = (ByteProcessor) in.duplicate();
                if (inv == 1) ip.invertLut();
                Prefs.blackBackground = bb == 1;
                Binary b = new Binary();
                b.setup(op, Gen.imp("m", ip));
                b.run(ip);
                cases.add(J.o("params", J.o("op", op, "blackBackground", bb == 1, "invertedLut", inv == 1),
                    "output", J.image(ip), "outputInvertedLut", ip.isInvertedLut()));
            }
        Prefs.blackBackground = true;
        new Fx("thr", "binary_foreground_rule", "binary")
            .call("foreground = blackBackground ? 255 : 0; if (ip.isInvertedLut()) foreground = 255 - foreground (Binary.run)")
            .input(in).put("cases", cases).write();
    }

    static void median() throws Exception {
        Random r = new Random(5);
        ByteProcessor in = Gen.touchingDisks(40, 30);
        for (int i = 0; i < 40; i++) in.set(r.nextInt(40), r.nextInt(30), r.nextBoolean() ? 255 : 0);
        for (int rad : new int[]{1, 3}) {
            ByteProcessor ip = (ByteProcessor) in.duplicate();
            Gen.set(new Binary(), "medianRadius", (double) rad);
            java.lang.reflect.Method mm = Binary.class.getDeclaredMethod("median", ImageProcessor.class);
            mm.setAccessible(true);
            mm.invoke(new Binary(), ip);
            new Fx("thr", "binary_median_r" + rad, "binaryMedian")
                .call("Binary.median(ip): resetThreshold(); new RankFilters().rank(ip, r, MEAN); ip.threshold(128,255)")
                .params("radius", (double) rad).input(in).output(ip).write();
        }
    }

    static void mask() {
        List<Object> cases = new ArrayList<>();
        ImageProcessor g = Gen.tex(8, 32, 24, 11);
        for (int bits : new int[]{8, 16, 32}) {
            ImageProcessor ip = Gen.tex(bits, 32, 24, 11);
            ImagePlus imp = Gen.imp("t", ip);
            double lo = bits == 8 ? 60 : bits == 16 ? 15000 : 40;
            double hi = bits == 8 ? 200 : bits == 16 ? 50000 : 250;
            ip.setThreshold(lo, hi, ImageProcessor.NO_LUT_UPDATE);
            ByteProcessor m = Thresholder.createMask(imp);
            cases.add(J.o("bitDepth", bits, "lower", lo, "upper", hi, "input", J.image(ip), "mask", J.image(m)));
        }
        new Fx("thr", "make_binary_mask", "makeBinary")
            .call("ip.setThreshold(lo,hi,NO_LUT_UPDATE); Thresholder.createMask(imp) = ip.createMask(): 255 inside [lo,hi], else 0")
            .put("cases", cases).write();
    }
}
