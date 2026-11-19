import ij.*;
import ij.gui.*;
import ij.measure.ResultsTable;
import ij.plugin.frame.RoiManager;
import ij.process.*;
import java.awt.Frame;
import java.nio.file.*;
import java.util.*;

/**
 * Reference outputs of the Fiji-distribution plugins (GPL: the plugins are only RUN here, never read).
 * Usage: run_fiji.sh FijiRefs <outDir ending in ij-wave3> [cmd ...]
 * cmd: autothreshold autolocal clahe tubeness frangi directionality skeleton thickness coloc cellcounter roiset
 * Never shipped, never run in CI.
 */
public class FijiRefs {
    // ------------------------------------------------------------------ runner
    static final class Result {
        ImagePlus self;
        List<ImagePlus> created = new ArrayList<>();
        ResultsTable table;
        String log;
    }

    static Map<String, Object> table(ResultsTable rt) {
        if (rt == null || rt.size() == 0) return null;
        List<Object> heads = new ArrayList<>(), rows = new ArrayList<>();
        List<Integer> idx = new ArrayList<>();
        for (String h : rt.getHeadings()) { if (h == null || h.trim().isEmpty()) continue; heads.add(h); idx.add(rt.getColumnIndex(h)); }
        for (int r = 0; r < rt.size(); r++) {
            List<Object> row = new ArrayList<>();
            for (int k = 0; k < heads.size(); k++) { int c = idx.get(k); row.add(c == ResultsTable.COLUMN_NOT_FOUND ? rt.getStringValue((String) heads.get(k), r) : rt.getValueAsDouble(c, r)); }
            rows.add(row);
        }
        return J.o("headings", heads, "rows", rows);
    }

    static Object imageJson(ImagePlus imp) {
        if (imp.getStackSize() == 1) return J.image(imp.getProcessor());
        List<Object> l = new ArrayList<>();
        for (int i = 1; i <= imp.getStackSize(); i++) l.add(J.image(imp.getStack().getProcessor(i)));
        return J.o("stack", l, "titles", titles(imp));
    }

    static List<Object> titles(ImagePlus imp) {
        List<Object> t = new ArrayList<>();
        ImageStack st = imp.getStack();
        for (int i = 1; i <= st.getSize(); i++) t.add(st.getSliceLabel(i));
        return t;
    }

    /** Runs a command on a COPY of `src` shown on screen; returns the modified copy, new images, Results table and Log. */
    static Result run(String cmd, String opts, ImageProcessor src) {
        return run(cmd, opts, new ImagePlus("in", src.duplicate()));
    }

    static Result run(String cmd, String opts, ImagePlus imp) {
        Result r = new Result();
        System.err.println("  [run] " + cmd + " " + opts);
        IJ.log("\\Clear");
        ResultsTable.getResultsTable().reset();
        imp.show();
        Set<Integer> before = new HashSet<>();
        for (int id : WindowManager.getIDList() == null ? new int[0] : WindowManager.getIDList()) before.add(id);
        final String[] failure = new String[1];
        Thread w = new Thread(() -> { try { IJ.run(imp, cmd, opts); } catch (Throwable t) { failure[0] = "ERROR " + t; } }, "Run$_ref");   // macro options are read on Run$_ threads
        w.start();
        try { w.join(15000); } catch (InterruptedException e) { }
        if (w.isAlive()) {   // a modal dialog nobody can answer: record its title, close it, go on
            StringBuilder ds = new StringBuilder("TIMEOUT");
            for (java.awt.Window win : java.awt.Window.getWindows()) if (win.isVisible() && win instanceof java.awt.Dialog) { ds.append(" [").append(((java.awt.Dialog) win).getTitle()).append("]"); win.dispose(); }
            failure[0] = ds.toString();
            try { w.join(5000); } catch (InterruptedException e) { }
        }
        if (failure[0] != null) r.log = failure[0];
        int[] ids = WindowManager.getIDList();
        if (ids != null) for (int id : ids) if (!before.contains(id)) r.created.add(WindowManager.getImage(id));
        r.self = imp;
        r.table = ResultsTable.getResultsTable();
        String lg = IJ.getLog();
        if (r.log == null) r.log = lg;
        return r;
    }

    static void closeAll(Result r) {
        for (ImagePlus c : r.created) { c.changes = false; c.close(); }   // changes=false: a modified image asks "Save changes?" (modal)
        r.self.changes = false;
        r.self.close();
        ResultsTable.getResultsTable().reset();
    }

    static Map<String, Object> describe(Result r) {
        LinkedHashMap<String, Object> m = new LinkedHashMap<>();
        m.put("self", imageJson(r.self));
        ImageProcessor ip = r.self.getProcessor();
        if (ip.getMinThreshold() != ImageProcessor.NO_THRESHOLD) m.put("selfThreshold", new double[]{ip.getMinThreshold(), ip.getMaxThreshold()});
        m.put("selfInvertedLut", ip.isInvertedLut());
        List<Object> cr = new ArrayList<>();
        for (ImagePlus c : r.created) cr.add(J.o("title", c.getTitle(), "image", imageJson(c), "invertedLut", c.getProcessor().isInvertedLut(), "calibration", c.getCalibration().pixelWidth));
        m.put("created", cr);
        Map<String, Object> t = table(r.table);
        if (t != null) m.put("table", t);
        if (r.log != null && !r.log.trim().isEmpty()) m.put("log", r.log);
        return m;
    }

    // ------------------------------------------------------------------ images
    static ByteProcessor blobs8(int w, int h, long seed) { return (ByteProcessor) Gen.make(8, Gen.blobs(w, h, seed, 7, 3, 8, 0.25, 0.15, 0.08, 0.04), w, h); }

    /** Gaussian-profile curved vessels on a noisy background (8-bit). */
    static ByteProcessor vessels(int w, int h, long seed) {
        float[] v = new float[w * h];
        double[][] paths = {{5, 70, 30, 40, 60, 45, 90, 15}, {10, 10, 40, 30, 55, 60, 85, 85}, {50, 5, 52, 40, 48, 90}};
        double[] sig = {1.5, 2.5, 3.5};
        for (int k = 0; k < paths.length; k++) {
            double[] p = paths[k];
            for (int s = 0; s < p.length / 2 - 1; s++) {
                double x0 = p[2 * s], y0 = p[2 * s + 1], x1 = p[2 * s + 2], y1 = p[2 * s + 3];
                int n = (int) Math.hypot(x1 - x0, y1 - y0) * 3;
                for (int i = 0; i <= n; i++) {
                    double cx = x0 + (x1 - x0) * i / n, cy = y0 + (y1 - y0) * i / n;
                    for (int y = Math.max(0, (int) cy - 10); y < Math.min(h, (int) cy + 11); y++) for (int x = Math.max(0, (int) cx - 10); x < Math.min(w, (int) cx + 11); x++) {
                        double d2 = (x - cx) * (x - cx) + (y - cy) * (y - cy);
                        v[y * w + x] = (float) Math.max(v[y * w + x], 0.8 * Math.exp(-d2 / (2 * sig[k] * sig[k])));
                    }
                }
            }
        }
        Random r = new Random(seed);
        for (int i = 0; i < v.length; i++) v[i] = (float) Math.max(0, Math.min(1, v[i] + 0.1 + 0.03 * r.nextGaussian()));
        return (ByteProcessor) Gen.make(8, v, w, h);
    }

    /** Sinusoidal fibre pattern at `deg` degrees (image coordinates: 0 = horizontal fibres, y down) plus noise. */
    static ByteProcessor fibres(int n, double deg, double deg2, long seed) {
        float[] v = new float[n * n];
        Random r = new Random(seed);
        for (int y = 0; y < n; y++) for (int x = 0; x < n; x++) {
            double a = Math.toRadians(deg), s = x * Math.sin(a) + y * Math.cos(a);   // perpendicular distance to a fibre of direction (cos a, -sin a)
            double val = 0.5 + 0.35 * Math.sin(2 * Math.PI * s / 7.0);
            if (!Double.isNaN(deg2)) { double b = Math.toRadians(deg2), s2 = x * Math.sin(b) + y * Math.cos(b); val = 0.5 + 0.2 * Math.sin(2 * Math.PI * s / 7.0) + 0.2 * Math.sin(2 * Math.PI * s2 / 9.0); }
            v[y * n + x] = (float) Math.max(0, Math.min(1, val + 0.04 * r.nextGaussian()));
        }
        return (ByteProcessor) Gen.make(8, v, n, n);
    }

    static ByteProcessor skeletonGraph(int variant) {
        int w = 96, h = 72;
        ByteProcessor ip = new ByteProcessor(w, h);
        if (variant == 0) {   // Y junction + loop + isolated segment + short spur
            Gen.line(ip, 5, 5, 30, 30, 3); Gen.line(ip, 55, 5, 30, 30, 3); Gen.line(ip, 30, 30, 30, 60, 3);
            for (int a = 0; a < 360; a += 2) { int x = (int) Math.round(68 + 14 * Math.cos(Math.toRadians(a))), y = (int) Math.round(46 + 14 * Math.sin(Math.toRadians(a))); ip.set(x, y, 255); ip.set(x + 1, y, 255); ip.set(x, y + 1, 255); }
            Gen.line(ip, 82, 46, 92, 46, 3);                                 // tail from the loop
            Gen.line(ip, 70, 8, 90, 14, 3);                                  // isolated
            Gen.line(ip, 30, 45, 40, 45, 3);                                 // spur
        } else if (variant == 2) {   // star of five arms, a double loop (two rings sharing an arc) and a hair
            int cx = 30, cy = 34;
            for (int k = 0; k < 5; k++) { double a = Math.toRadians(90 + 72 * k); Gen.line(ip, cx, cy, (int) Math.round(cx + 22 * Math.cos(a)), (int) Math.round(cy - 22 * Math.sin(a)), 3); }
            for (int a = 0; a < 360; a += 2) { int x = (int) Math.round(72 + 11 * Math.cos(Math.toRadians(a))), y = (int) Math.round(30 + 11 * Math.sin(Math.toRadians(a))); ip.set(x, y, 255); }
            for (int a = 0; a < 360; a += 2) { int x = (int) Math.round(82 + 11 * Math.cos(Math.toRadians(a))), y = (int) Math.round(30 + 11 * Math.sin(Math.toRadians(a))); ip.set(x, y, 255); }
            Gen.line(ip, 72, 41, 72, 50, 3);
        } else if (variant == 3) {   // long diagonal crossing a ring, a dot and a short straight piece
            Gen.line(ip, 2, 2, 93, 69, 3);
            for (int a = 0; a < 360; a += 2) { int x = (int) Math.round(48 + 12 * Math.cos(Math.toRadians(a))), y = (int) Math.round(36 + 12 * Math.sin(Math.toRadians(a))); ip.set(x, y, 255); }
            ip.set(8, 60, 255);
            Gen.line(ip, 70, 8, 90, 8, 3);
        } else {              // grid-like network with a 4-way junction and two cycles
            for (int x = 8; x <= 80; x += 24) Gen.line(ip, x, 6, x, 62, 3);
            for (int y = 10; y <= 58; y += 24) Gen.line(ip, 6, y, 86, y, 3);
            Gen.line(ip, 8, 6, 32, 34, 3);
        }
        ip.skeletonize(255);
        return ip;
    }

    // ------------------------------------------------------------------ commands
    public static void main(String[] a) throws Exception {
        Locale.setDefault(Locale.ROOT);
        System.setProperty("user.home", System.getProperty("java.io.tmpdir") + "/fijirefs-home");
        Fx.root = Paths.get(a[0]).toAbsolutePath().normalize();
        if (!Fx.root.getFileName().toString().equals("ij-wave3")) throw new IllegalArgumentException("outDir must end in ij-wave3");
        Set<String> only = new LinkedHashSet<>(Arrays.asList(a).subList(1, a.length));
        final Throwable[] err = new Throwable[1];
        Thread t = new Thread(() -> {
            try {
                new ImageJ(ImageJ.NO_SHOW);
                Prefs.blackBackground = true;
                String[] all = {"autothreshold", "autolocal", "clahe", "tubeness", "frangi", "directionality", "skeleton", "thickness", "coloc", "cellcounter", "roiset"};
                for (String c : all) {
                    if (!only.isEmpty() && !only.contains(c)) continue;
                    System.err.println("[fiji] " + c);
                    try {
                        switch (c) {
                            case "autothreshold": autoThreshold(); break;
                            case "autolocal": autoLocal(); break;
                            case "clahe": clahe(); break;
                            case "tubeness": tubeness(); break;
                            case "frangi": FijiRefs2.frangi(); break;
                            case "directionality": FijiRefs2.directionality(); break;
                            case "skeleton": skeleton(); break;
                            case "thickness": thickness(); break;
                            case "coloc": coloc(); break;
                            case "cellcounter": FijiRefs2.cellCounter(); break;
                            case "roiset": FijiRefs2.roiSet(); break;
                        }
                    } catch (Throwable e) { System.err.println("[fiji] " + c + " FAILED: " + e); e.printStackTrace(); }
                }
            } catch (Throwable e) { err[0] = e; }
        }, "Run$_fijirefs");
        t.start();
        t.join();
        if (err[0] != null) err[0].printStackTrace();
        System.out.println("written: " + Fx.written.size());
        System.exit(0);
    }

    static int distinct(ImageProcessor ip) {
        Set<Integer> s = new HashSet<>();
        for (int i = 0; i < ip.getPixelCount(); i++) s.add(ip.get(i));
        return s.size();
    }

    /** Numbers of the Log lines of the form "...<digits>" written by 'show' (kept raw next to it). */
    static List<Object> logLevels(String log) {
        List<Object> out = new ArrayList<>();
        if (log == null) return out;
        for (String line : log.split("\\r?\\n")) {
            java.util.regex.Matcher m = java.util.regex.Pattern.compile("^\\s*(\\S[^:=]*?)\\s*[:=]\\s*(-?\\d+(?:\\.\\d+)?)\\s*$").matcher(line);
            if (m.find()) out.add(J.o("name", m.group(1), "value", Double.parseDouble(m.group(2))));
        }
        return out;
    }

    static final String[] AT_METHODS = {"Default", "Huang", "Intermodes", "IsoData", "Li", "MaxEntropy", "Mean", "MinError(I)", "Minimum", "Moments", "Otsu", "Percentile", "RenyiEntropy", "Shanbhag", "Triangle", "Yen"};

    static void autoThreshold() {
        ImageProcessor[] ims = {blobs8(72, 60, 3), vessels(72, 60, 5), Gen.make(8, Gen.blobs(72, 60, 9, 3, 6, 12, 0.0, 0.0, 0.05, 0.02), 72, 60)};
        String[] nm = {"blobs", "vessels", "bigblobs"};
        for (int k = 0; k < ims.length; k++) {
            List<Object> cases = new ArrayList<>();
            for (String m : AT_METHODS) for (int opt = 0; opt < 5; opt++) {
                boolean white = opt == 0 || opt == 2 || opt == 3;
                boolean set = opt >= 3;
                String o = "method=" + m + (white ? " white" : "") + (opt == 2 ? " ignore_black ignore_white" : "") + (set ? " setthreshold" : "");
                Result r = run("Auto Threshold", o, ims[k]);
                cases.add(J.o("params", J.o("method", m, "white", white, "ignoreBlackWhite", opt == 2, "setThreshold", set), "options", o, "result", describe(r)));
                closeAll(r);
            }
            new Fx("fiji/autothreshold", nm[k] + "_8bit", "autoThreshold").call("IJ.run(imp, \"Auto Threshold\", options) on an 8-bit image (Fiji Auto_Threshold v1.18.0): in place binary (255 objects unless the LUT is inverted), or the threshold set when 'setthreshold'")
                .input(ims[k]).put("cases", cases).write();
        }
        // 16-bit
        ImageProcessor[] i16 = {Gen.make(16, Gen.blobs(72, 60, 3, 7, 3, 8, 0.25, 0.15, 0.08, 0.04), 72, 60), Gen.make(16, Gen.blobs(72, 60, 5, 5, 4, 9, 0.0, 0.0, 0.2, 0.03), 72, 60)};
        for (int k = 0; k < i16.length; k++) {
            List<Object> cases = new ArrayList<>();
            for (String m : new String[]{"Default", "Huang", "Li", "Otsu", "Triangle", "Yen", "IsoData", "MaxEntropy"}) for (int opt = 0; opt < 2; opt++) {
                String o = "method=" + m + " white show" + (opt == 1 ? " setthreshold" : "");   // 'show' prints "<method>: <level>" to the Log
                Result r = run("Auto Threshold", o, i16[k]);
                ImageProcessor sp = r.self.getProcessor();
                cases.add(J.o("params", J.o("method", m, "white", true, "setThreshold", opt == 1), "options", o,
                    "afterBitDepth", r.self.getBitDepth(), "afterMinThreshold", sp.getMinThreshold(), "afterMaxThreshold", sp.getMaxThreshold(),
                    "noThresholdValue", ImageProcessor.NO_THRESHOLD, "distinctValues", distinct(sp), "logLevels", logLevels(r.log), "result", describe(r)));
                closeAll(r);
            }
            new Fx("fiji/autothreshold", "blobs16_" + k, "autoThresholdMask").call("Auto Threshold on a 16-bit image with 'show' (the level is printed to the Log, parsed into logLevels): what Fiji creates / modifies (compare `created` and `self`); afterMin/MaxThreshold = the thresholds of the in-place image after the command. The same 16-bit inputs are in thr/threshold16_fiji_blobs16_<k>.json (ImageProcessor.setAutoThreshold levels)").input(i16[k]).put("cases", cases).write();
        }
    }

    static final String[] ALT_METHODS = {"Bernsen", "Contrast", "Mean", "Median", "MidGrey", "Niblack", "Otsu", "Phansalkar", "Sauvola"};

    static void autoLocal() {
        ImageProcessor[] ims = {blobs8(72, 60, 3), vessels(72, 60, 5), Gen.make(8, Gen.blobs(72, 60, 9, 3, 6, 12, 0.0, 0.0, 0.05, 0.02), 72, 60), fibres(64, 30, Double.NaN, 4)};
        String[] nm = {"blobs", "vessels", "bigblobs", "fibres"};
        for (int k = 0; k < ims.length; k++) {
            List<Object> cases = new ArrayList<>();
            for (String m : ALT_METHODS) for (int v = 0; v < 4; v++) {
                int radius = v == 1 ? 7 : 15;
                String o = "method=" + m + " radius=" + radius + " parameter_1=" + (v == 2 ? "10" : v == 3 ? "0.3" : "0") + " parameter_2=" + (v == 2 ? "5" : v == 3 ? "0.4" : "0") + (v == 3 ? "" : " white");
                Result r = run("Auto Local Threshold", o, ims[k]);
                cases.add(J.o("params", J.o("method", m, "radius", radius, "parameter1", v == 2 ? 10 : v == 3 ? 0.3 : 0, "parameter2", v == 2 ? 5 : v == 3 ? 0.4 : 0, "white", v != 3), "options", o, "result", describe(r)));
                closeAll(r);
            }
            new Fx("fiji/autolocalthreshold", nm[k] + "_8bit", "autoLocalThreshold").call("IJ.run(imp, \"Auto Local Threshold\", options): Fiji Auto_Local_Threshold v1.11.0, in place 8-bit 0/255").input(ims[k]).put("cases", cases).write();
        }
    }

    static void clahe() {
        ImageProcessor[] i8s = {blobs8(80, 64, 3), vessels(80, 64, 5), Gen.make(8, Gen.blobs(80, 64, 9, 3, 6, 12, 0.0, 0.0, 0.05, 0.02), 80, 64)};
        ImageProcessor[] i16s = {Gen.make(16, Gen.blobs(80, 64, 3, 7, 3, 8, 0.25, 0.15, 0.08, 0.04), 80, 64), Gen.make(16, Gen.blobs(80, 64, 9, 3, 6, 12, 0.0, 0.0, 0.05, 0.02), 80, 64)};
        String[] n8 = {"blobs_8bit", "vessels_8bit", "bigblobs_8bit"}, n16 = {"blobs_16bit", "bigblobs_16bit"};
        int[][] cfg = {{127, 256, 300, 1}, {127, 256, 300, 0}, {63, 256, 300, 1}, {31, 128, 200, 0}, {63, 64, 400, 1}};
        for (int pass = 0; pass < 2; pass++) {
            ImageProcessor[] ims = pass == 0 ? i8s : i16s;
            String[] nm = pass == 0 ? n8 : n16;
            for (int k = 0; k < ims.length; k++) {
                List<Object> cases = new ArrayList<>();
                for (int[] c : cfg) {
                    String o = "blocksize=" + c[0] + " histogram=" + c[1] + " maximum=" + (c[2] / 100.0) + " mask=*None*" + (c[3] == 1 ? " fast" : "");
                    Result r = run("Enhance Local Contrast (CLAHE)", o, ims[k]);
                    cases.add(J.o("params", J.o("blocksize", c[0], "bins", c[1], "slope", c[2] / 100.0, "fast", c[3] == 1), "options", o, "result", describe(r)));
                    closeAll(r);
                }
                new Fx("fiji/clahe", nm[k], "clahe").call("IJ.run(imp, \"Enhance Local Contrast (CLAHE)\", options) (mpicbg): in place, " + (pass == 0 ? "8-bit" : "16-bit")).input(ims[k]).put("cases", cases).write();
            }
        }
    }

    static void tubeness() {
        ImageProcessor[] ims = {vessels(72, 60, 5), blobs8(72, 60, 3), Gen.make(16, Gen.blobs(72, 60, 3, 7, 3, 8, 0.25, 0.15, 0.08, 0.04), 72, 60)};
        String[] nm = {"vessels_8bit", "blobs_8bit", "blobs_16bit"};
        for (int k = 0; k < ims.length; k++) {
            List<Object> cases = new ArrayList<>();
            for (double sg : new double[]{1.0, 2.0, 3.5}) for (int cal = 0; cal < 2; cal++) {
                ImagePlus imp = new ImagePlus("in", ims[k].duplicate());
                if (cal == 1) { imp.getCalibration().pixelWidth = 0.5; imp.getCalibration().pixelHeight = 0.5; imp.getCalibration().setUnit("um"); }
                String o = "sigma=" + sg + (cal == 0 ? " use" : "");
                Result r = run("Tubeness", o, imp);
                cases.add(J.o("params", J.o("sigma", sg, "useCalibration", cal == 0, "pixelWidth", cal == 1 ? 0.5 : 1.0), "options", o, "result", describe(r)));
                closeAll(r);
            }
            new Fx("fiji/tubeness", nm[k], "tubeness").call("IJ.run(imp, \"Tubeness\", \"sigma=<s> [use]\") (VIB_ v4.0.0): new 32-bit image 'tubeness of in'").input(ims[k]).put("cases", cases).write();
        }
    }

    static void skeleton() {
        for (int v = 0; v < 4; v++) {
            System.err.println("  [skeleton] building graph " + v);
            ByteProcessor sk = skeletonGraph(v);
            System.err.println("  [skeleton] built");
            List<Object> cases = new ArrayList<>();
            String[][] opts = {{"prune=none", "default"}, {"prune=none detailed", "detailed"}, {"prune=none show", "labeled"}, {"prune=[shortest branch]", "pruneShortest"}, {"prune=none prune_0 detailed", "pruneEnds"}, {"prune=none calculate detailed", "shortestPath"},
                {"prune=[lowest intensity voxel] detailed", "pruneLowestVoxel"}, {"prune=[lowest intensity branch] detailed", "pruneLowestBranch"}};
            for (String[] o : opts) {
                Result r = run("Analyze Skeleton (2D/3D)", o[0], sk);
                cases.add(J.o("name", o[1], "options", o[0], "result", describe(r)));
                Map<String, Object> extra = new LinkedHashMap<>();
                // the plugin's own named tables (Branch information)
                for (Frame f : WindowManager.getNonImageWindows()) if (f instanceof ij.text.TextWindow && f.getTitle().startsWith("Branch")) extra.put(f.getTitle(), ((ij.text.TextWindow) f).getTextPanel().getResultsTable() == null ? null : table(((ij.text.TextWindow) f).getTextPanel().getResultsTable()));
                if (!extra.isEmpty()) ((LinkedHashMap<String, Object>) cases.get(cases.size() - 1)).put("namedTables", extra);
                for (Frame f : WindowManager.getNonImageWindows()) if (f.getTitle().startsWith("Branch")) f.dispose();
                closeAll(r);
            }
            new Fx("fiji/skeleton", "graph" + v, "analyzeSkeleton").call("IJ.run(imp, \"Analyze Skeleton (2D/3D)\", options) on a 1-px skeleton (255): counts and lengths in the Results table (one row per skeleton), detailed = Branch information").input(sk).put("cases", cases).write();
        }
    }

    static void thickness() {
        ImageProcessor[] ims = {Gen.touchingDisks(80, 60), vessels(72, 60, 5), Gen.thinLines(72, 60), blobs8(72, 60, 3)};
        String[] nm = {"disks", "vessels_thr", "lines", "blobs_thr"};
        for (int k = 0; k < ims.length; k++) {
            List<Object> cases = new ArrayList<>();
            for (int inv = 0; inv < 2; inv++) for (int thr : new int[]{128, 100}) {
                if (k == 1 && thr == 128) {}
                String o = "threshold=" + thr + (inv == 1 ? " inverse" : "");
                Result r = run("Local Thickness (complete process)", o, ims[k]);
                cases.add(J.o("params", J.o("threshold", thr, "inverse", inv == 1), "options", o, "result", describe(r)));
                closeAll(r);
            }
            new Fx("fiji/localthickness", nm[k], "localThickness").call("IJ.run(imp, \"Local Thickness (complete process)\", \"threshold=<t> [inverse]\"): new 32-bit '<title>_LocThk' (background 0)").input(ims[k]).put("cases", cases).write();
        }
    }

    /** "RESULTS:" block of the Coloc 2 Log -> { key: number|string } at the precision the plugin prints (the digits are only as exact as the Log). */
    static Map<String, Object> parseColocLog(String log) {
        LinkedHashMap<String, Object> m = new LinkedHashMap<>();
        boolean in = false;
        for (String line : log.split("\\r?\\n")) {
            if (line.startsWith("RESULTS:")) { in = true; continue; }
            if (!in) continue;
            int c = line.lastIndexOf(", ");
            if (c < 0) continue;
            String k = line.substring(0, c).trim(), v = line.substring(c + 2).trim();
            Object val = v;
            try { val = Double.parseDouble(v); } catch (NumberFormatException e) { }
            m.put(k, val);
        }
        return m;
    }

    static void coloc() {
        ImageProcessor a = Gen.make(8, Gen.blobs(64, 64, 3, 9, 3, 7, 0.2, 0.1, 0.06, 0.03), 64, 64);
        ImageProcessor b = a.duplicate();
        Random r = new Random(5);
        for (int i = 0; i < 64 * 64; i++) { int v = (int) Math.round(0.7 * (a.get(i)) + 25 + 14 * r.nextGaussian()); b.set(i, Math.max(0, Math.min(255, v))); }
        ImageProcessor c = Gen.make(8, Gen.blobs(64, 64, 11, 9, 3, 7, 0.2, 0.1, 0.06, 0.03), 64, 64);   // independent
        List<Object> cases = new ArrayList<>();
        Object[][] pairs = {{"correlated", a, b}, {"independent", a, c}, {"identical", a, a}};
        for (Object[] p : pairs) for (String reg : new String[]{"Costes", "Bisection"}) {
            ImagePlus i1 = new ImagePlus("ch1", ((ImageProcessor) p[1]).duplicate()), i2 = new ImagePlus("ch2", ((ImageProcessor) p[2]).duplicate());
            i1.show(); i2.show();
            IJ.log("\\Clear");
            String o = "channel_1=ch1 channel_2=ch2 roi_or_mask=<None> threshold_regression=" + reg
                + " li_histogram_channel_1 li_histogram_channel_2 li_icq spearman's_rank_correlation manders'_correlation kendall's_tau_rank_correlation 2d_intensity_histogram costes'_significance_test psf=3 costes_randomisations=10";
            Set<Integer> before = new HashSet<>();
            for (int id : WindowManager.getIDList()) before.add(id);
            String logText;
            try { IJ.run(i1, "Coloc 2", o); } catch (Throwable t) { IJ.log("ERROR " + t); }
            logText = IJ.getLog();
            List<Object> created = new ArrayList<>();
            int[] ids = WindowManager.getIDList();
            if (ids != null) for (int id : ids) if (!before.contains(id)) { ImagePlus im = WindowManager.getImage(id); created.add(J.o("title", im.getTitle(), "width", im.getWidth(), "height", im.getHeight(), "bitDepth", im.getBitDepth())); im.changes = false; im.close(); }
            for (Frame f : WindowManager.getNonImageWindows()) if (f.getTitle().startsWith("Coloc")) {}
            cases.add(J.o("pair", p[0], "regression", reg, "options", o, "log", logText, "parsed", parseColocLog(logText), "createdImages", created, "table", table(ResultsTable.getResultsTable())));
            i1.changes = false; i2.changes = false; i1.close(); i2.close();
            ResultsTable.getResultsTable().reset();
        }
        new Fx("fiji/coloc2", "pairs", "coloc").call("IJ.run(img1, \"Coloc 2\", options): the numbers it prints to the Log (r, Spearman, Kendall tau, Manders, Li ICQ, thresholds, Costes p-value: the p-value is random and is NOT to be compared)")
            .put("inputs", J.o("a", J.image(a), "b", J.image(b), "c", J.image(c))).put("cases", cases).write();
    }
}
