import ij.*;
import ij.gui.*;
import ij.measure.*;
import ij.plugin.filter.Analyzer;
import ij.process.*;
import java.awt.image.IndexColorModel;
import java.io.IOException;
import java.nio.*;
import java.nio.file.*;
import java.util.*;
import java.util.function.Supplier;

/**
 * Headless ImageJ 1.54p fixture generator for the stacks / hyperstacks / RGB work (DOCS/studio-advanced/stacks/PLAN.md §6).
 * Usage: W4Stk <outDir ending in ij-stacks> [group ...]     groups: dialogs zproj reslice substack reduce reverse concat hyper montage zprofile stats labels slices rgb convert tiff stackproc
 * Never shipped, never run in CI. The job runs on ONE thread named "Run$_fixtures" (ImageJ reads macro options only there).
 */
public class W4Stk {
    public static void main(String[] args) throws Exception {
        final Throwable[] err = new Throwable[1];
        Thread t = new Thread(() -> { try { work(args); } catch (Throwable e) { err[0] = e; } }, "Run$_fixtures");
        t.start();
        t.join();
        if (err[0] != null) { err[0].printStackTrace(); System.exit(1); }
        System.out.println("fixtures written: " + Fx.written.size() + " (errors: " + errors.size() + ")");
        for (String e : errors) System.out.println("  ERROR " + e);
        System.exit(0);
    }

    static final List<String> errors = new ArrayList<>();
    static final String[] GROUPS = {"dialogs", "zproj", "reslice", "substack", "reduce", "reverse", "concat", "hyper", "montage", "zprofile", "stats", "labels", "slices", "rgb", "convert", "tiff", "stackproc"};

    static void work(String[] args) throws Exception {
        Locale.setDefault(Locale.ROOT);
        new ij.ImageJ(ij.ImageJ.NO_SHOW);   // menus for IJ.run; the preferences are set AFTER (the constructor reads IJ_Prefs)
        Prefs.blackBackground = true;
        Prefs.padEdges = false;
        Prefs.interpolateScaledImages = false;
        Fx.root = Paths.get(args[0]).toAbsolutePath().normalize();
        if (!Fx.root.getFileName().toString().equals("ij-stacks")) throw new IllegalArgumentException("outDir must end in ij-stacks");
        Set<String> only = new LinkedHashSet<>(Arrays.asList(args).subList(1, args.length));
        W4Dlg.startWatchdog();
        for (String g : GROUPS) {
            if (!only.isEmpty() && !only.contains(g)) continue;
            clean(Fx.root.resolve(g));
            closeAll();
            ij.macro.Interpreter.batchMode = !g.equals("dialogs");
            switch (g) {
                case "dialogs": W4Dlg.run(); break;
                case "zproj": W4Zp.run(); break;
                case "reslice": case "substack": case "reduce": case "reverse": case "concat": case "hyper": case "montage": case "zprofile": case "stats": case "labels": case "slices": W4Ops.run(g); break;
                case "rgb": W4Rgb.run(); break;
                case "convert": W4Conv.run(); break;
                case "tiff": W4Tiff.run(); break;
                case "stackproc": W4Sp.run(); break;
            }
            closeAll();
        }
    }

    static void clean(Path dir) throws IOException {
        if (!Files.isDirectory(dir)) return;
        try (DirectoryStream<Path> ds = Files.newDirectoryStream(dir)) {
            for (Path f : ds) if (Files.isRegularFile(f)) Files.delete(f);
        }
    }

    // ------------------------------------------------------------------ case wrapper
    interface Body { void run(Fx f) throws Exception; }

    static final Set<String> seen = new HashSet<>();

    /** One fixture file; a failing case writes {"error": ...} (plus whatever it had recorded) and the driver goes on. */
    static void kase(String group, String name, String op, Body b) {
        if (!seen.add(group + "/" + name)) throw new IllegalStateException("duplicate case " + group + "/" + name);
        Fx f = new Fx(group, name, op);
        resetGlobals();
        try { b.run(f); }
        catch (Throwable e) {
            String msg = e.getClass().getSimpleName() + ": " + e.getMessage();
            f.put("error", msg);
            errors.add(group + "/" + name + " -> " + msg);
        }
        finally { try { closeAll(); } catch (Throwable ignore) { } }
        f.write();
    }

    /**
     * Every global a case may have changed (Conversions, Set Measurements, Black background), back to ImageJ's defaults BEFORE each case:
     * a case that failed half-way (or forgot to restore) can no longer leak weighted RGB conversion or custom measurements into the next.
     */
    static void resetGlobals() {
        Prefs.blackBackground = true;
        IJ.run("Conversions...", " scale");
        W4Ana.setMeasurements(W4Ana.DEFAULT);
        ResultsTable.getResultsTable().reset();
    }

    static void closeAll() {
        int[] ids = WindowManager.getIDList();
        if (ids != null) for (int id : ids) {
            ImagePlus i = WindowManager.getImage(id);
            if (i != null) { i.changes = false; i.close(); }
        }
        ImagePlus c = WindowManager.getCurrentImage();
        if (c != null) { c.changes = false; c.close(); }
        WindowManager.setTempCurrentImage(null);
    }

    static List<Integer> ids() {
        int[] a = WindowManager.getIDList();
        List<Integer> l = new ArrayList<>();
        if (a != null) for (int i : a) l.add(i);
        return l;
    }

    /**
     * IJ.run(imp, command, options) on `cur` with the other images open, and everything it did recorded in `f`:
     * input(s), self (the image after), created[] (images that appeared, in window-list order), table, log, dialogs.
     */
    static void exec(Fx f, ImagePlus cur, String command, String options, ImagePlus... others) {
        f.put("command", command);
        f.put("options", options);
        f.put("input", Stk.stack(cur));
        if (cur.getRoi() != null) f.put("roi", Stk.roi(cur.getRoi()));
        if (others.length > 0) {
            f.put("input2", Stk.stack(others[0]));
            if (others.length > 1) { List<Object> l = new ArrayList<>(); for (ImagePlus o : others) l.add(Stk.stack(o)); f.put("inputs", l); }
        }
        for (Map.Entry<String, Object> e : run1(cur, command, options).entrySet()) f.put(e.getKey(), e.getValue());
    }

    /**
     * A case file with several runs of ONE command on the same seeded input: `input` once, then cases [{options, self?, created, table?, log?, dialogs?, thrown?}].
     * `mk` builds a fresh input (and shows nothing: this method shows it). `self` is left out when the command did not change the input.
     */
    static void multi(Fx f, Supplier<ImagePlus> mk, String command, String... optionsList) {
        f.put("command", command);
        ImagePlus first = mk.get();
        Map<String, Object> in = Stk.stack(first);
        f.put("input", in);
        String inJson = J.val(in);
        if (first.getRoi() != null) f.put("roi", Stk.roi(first.getRoi()));
        List<Object> cases = new ArrayList<>();
        for (String o : optionsList) {
            ImagePlus cur = mk.get();
            cur.show();
            Map<String, Object> r = run1(cur, command, o);
            LinkedHashMap<String, Object> c = new LinkedHashMap<>();
            c.put("options", o);
            Object self = r.remove("self");
            if (self != null && !J.val(self).equals(inJson)) c.put("self", self);
            c.putAll(r);
            cases.add(c);
            closeAll();
        }
        f.put("cases", cases);
    }

    /** Runs one command, returns {self, created, table?, log?, dialogs?, thrown?}. */
    static Map<String, Object> run1(ImagePlus cur, String command, String options) {
        LinkedHashMap<String, Object> f = new LinkedHashMap<>();
        List<Integer> before = ids();
        ResultsTable.getResultsTable().reset();
        IJ.log("\\Clear");
        W4Dlg.unexpected.clear();
        W4Dlg.guard = true;
        String thrown = null;
        try { if (cur != null) IJ.run(cur, command, options); else IJ.run(command, options); }
        catch (Throwable e) { thrown = e.getClass().getSimpleName() + ": " + e.getMessage(); }
        finally { W4Dlg.guard = false; }
        if (cur != null) {
            try {
                Map<String, Object> self = (cur.getStackSize() > 0 && cur.getProcessor() != null) ? Stk.stack(cur) : null;
                f.put("self", self != null && ((List<?>) self.get("planes")).isEmpty() ? null : self);
            } catch (Throwable e) { f.put("self", null); }
        }
        List<Object> created = new ArrayList<>();
        Set<ImagePlus> seenImp = Collections.newSetFromMap(new IdentityHashMap<>());
        for (int id : ids()) if (!before.contains(id)) {
            ImagePlus n = WindowManager.getImage(id);
            if (n != null && seenImp.add(n)) created.add((n.getProperty(ij.gui.Plot.PROPERTY_KEY) != null || n.getTitle().startsWith("Histogram of")) ? J.o("title", n.getTitle(), "plot", true, "width", n.getWidth(), "height", n.getHeight()) : Stk.stack(n));
        }
        f.put("created", created);
        ResultsTable rt = ResultsTable.getResultsTable();
        if (rt != null && rt.size() > 0) f.put("table", Stk.table(rt));
        String log = IJ.getLog();
        if (log != null && !log.isEmpty()) f.put("log", log);
        if (!W4Dlg.unexpected.isEmpty()) f.put("dialogs", new ArrayList<Object>(W4Dlg.unexpected));
        if (thrown != null) f.put("thrown", thrown);
        return f;
    }
}

/** JSON of images / stacks / tables. Planes use the README's ARRAY encoding; an RGB plane is {"rgb":true,"b64","dtype":"u8","length":3wh} (R,G,B per pixel). */
final class Stk {
    static Object plane(ImageProcessor ip) {
        if (ip instanceof ColorProcessor) {
            int[] px = (int[]) ip.getPixels();
            byte[] b = new byte[px.length * 3];
            for (int i = 0; i < px.length; i++) { b[3 * i] = (byte) (px[i] >> 16); b[3 * i + 1] = (byte) (px[i] >> 8); b[3 * i + 2] = (byte) px[i]; }
            Map<String, Object> m = J.b64(b, "u8", b.length);
            LinkedHashMap<String, Object> r = new LinkedHashMap<>();
            r.put("rgb", true); r.putAll(m);
            return r;
        }
        return J.data(ip);
    }

    static Object lut(IndexColorModel cm) {
        if (cm == null) return null;
        int n = cm.getMapSize();
        byte[] r = new byte[256], g = new byte[256], b = new byte[256];
        cm.getReds(r); cm.getGreens(g); cm.getBlues(b);
        boolean gray = n == 256, inv = n == 256;
        for (int i = 0; i < 256 && (gray || inv); i++) {
            if (!(r[i] == (byte) i && g[i] == (byte) i && b[i] == (byte) i)) gray = false;
            if (!(r[i] == (byte) (255 - i) && g[i] == (byte) (255 - i) && b[i] == (byte) (255 - i))) inv = false;
        }
        if (gray) return "grays";
        if (inv) return "inverting";
        byte[] all = new byte[768];
        System.arraycopy(r, 0, all, 0, 256); System.arraycopy(g, 0, all, 256, 256); System.arraycopy(b, 0, all, 512, 256);
        return J.o("mapSize", n, "rgb", Base64.getEncoder().encodeToString(all));
    }

    static Map<String, Object> calibration(ImagePlus imp) {
        Calibration c = imp.getCalibration();
        LinkedHashMap<String, Object> m = new LinkedHashMap<>();
        m.put("pixelWidth", c.pixelWidth); m.put("pixelHeight", c.pixelHeight); m.put("pixelDepth", c.pixelDepth);
        m.put("unit", c.getUnit());
        m.put("xOrigin", c.xOrigin); m.put("yOrigin", c.yOrigin); m.put("zOrigin", c.zOrigin);
        m.put("frameInterval", c.frameInterval); m.put("timeUnit", c.getTimeUnit());
        m.put("fps", c.fps); m.put("loop", c.loop);
        return m;
    }

    /** {dims, hyperstack, composite?, mode?, title, width, height, bitDepth, planes, labels?, calibration, displayRanges, luts} */
    static Map<String, Object> stack(ImagePlus imp) {
        LinkedHashMap<String, Object> m = new LinkedHashMap<>();
        ImageStack st = imp.getStack();
        int n = st.getSize();
        boolean rgb = imp.getBitDepth() == 24;
        m.put("title", imp.getTitle());
        m.put("dims", J.o("c", imp.getNChannels(), "z", imp.getNSlices(), "t", imp.getNFrames()));
        m.put("hyperstack", imp.isHyperStack());
        m.put("width", imp.getWidth()); m.put("height", imp.getHeight()); m.put("bitDepth", imp.getBitDepth());
        m.put("currentSlice", imp.getCurrentSlice());
        int[] pos = imp.convertIndexToPosition(imp.getCurrentSlice());
        m.put("position", J.o("c", pos[0], "z", pos[1], "t", pos[2]));
        if (imp.isComposite()) {
            CompositeImage ci = (CompositeImage) imp;
            m.put("composite", true);
            m.put("mode", ci.getMode() == IJ.COMPOSITE ? "composite" : ci.getMode() == IJ.COLOR ? "color" : "grayscale");
        }
        List<Object> planes = new ArrayList<>();
        List<Object> labels = new ArrayList<>();
        boolean anyLabel = false;
        for (int i = 1; i <= n; i++) {
            planes.add(plane(st.getProcessor(i)));
            String l = st.getSliceLabel(i);
            labels.add(l);
            if (l != null) anyLabel = true;
        }
        m.put("planes", planes);
        if (anyLabel) m.put("labels", labels);
        m.put("calibration", calibration(imp));
        List<Object> ranges = new ArrayList<>(), luts = new ArrayList<>();
        if (imp.isComposite()) {
            CompositeImage ci = (CompositeImage) imp;
            for (int c = 1; c <= imp.getNChannels(); c++) {
                LUT l = ci.getChannelLut(c);
                ranges.add(new double[]{l.min, l.max});
                luts.add(lut(l));
            }
        } else if (!rgb) {
            ImageProcessor ip = imp.getProcessor();
            ranges.add(new double[]{ip.getMin(), ip.getMax()});
            luts.add(lut((IndexColorModel) ip.getColorModel()));
        } else ranges.add(new double[]{0, 255});
        m.put("displayRanges", ranges);
        if (!rgb) m.put("luts", luts);
        return m;
    }

    static Object lut(LUT l) { return lut((IndexColorModel) l); }

    static Map<String, Object> roi(Roi r) { return J.roi(r); }

    /** ResultsTable: headings + rows (Label column as text, the rest as numbers; NaN -> null). */
    static Map<String, Object> table(ResultsTable rt) {
        String[] hs = rt.getHeadings();
        List<Object> rows = new ArrayList<>();
        List<Object> heads = new ArrayList<>();
        for (String h : hs) heads.add(h);
        for (int r = 0; r < rt.size(); r++) {
            List<Object> row = new ArrayList<>();
            for (String h : hs) {
                if (h.equals("Label")) { String l = rt.getLabel(r); row.add(l); continue; }
                int col = rt.getColumnIndex(h);
                row.add(col == ResultsTable.COLUMN_NOT_FOUND ? null : (Object) rt.getValueAsDouble(col, r));
            }
            rows.add(row);
        }
        return J.o("headings", heads, "rows", rows);
    }
}

/** Seeded inputs. Every factory returns a NEW image (commands change images in place). */
final class In {
    /** Plain stack of n slices of Gen.tex (blobs) for the type, seeded. */
    static ImagePlus stack(String title, int bits, int w, int h, int n, long seed) {
        if (w == 37 && h == 23) { w = 30; h = 18; }
        ImageStack st = new ImageStack(w, h);
        for (int i = 0; i < n; i++) st.addSlice(null, Gen.tex(bits, w, h, seed + 13 * i));
        return new ImagePlus(title, st);
    }

    static ImagePlus noiseStack(String title, int bits, int w, int h, int n, long seed) {
        if (w == 37 && h == 23) { w = 30; h = 18; }
        ImageStack st = new ImageStack(w, h);
        for (int i = 0; i < n; i++) st.addSlice(null, Gen.noise(bits, w, h, seed + i));
        return new ImagePlus(title, st);
    }

    static ImagePlus image(String title, int bits, int w, int h, long seed) {
        if (w == 37 && h == 23) { w = 30; h = 18; } return new ImagePlus(title, Gen.tex(bits, w, h, seed)); }

    /** Hyperstack c x z x t in ImageJ order (c fastest, then z, then t); channel amplitudes differ so projections tell channels apart. */
    static ImagePlus hyper(String title, int bits, int w, int h, int nc, int nz, int nt, long seed, boolean composite) {
        w = Math.min(w, 24); h = Math.min(h, 16);   // hyperstacks are the bulk of the fixture bytes
        ImageStack st = new ImageStack(w, h);
        for (int t = 0; t < nt; t++) for (int z = 0; z < nz; z++) for (int c = 0; c < nc; c++) {
            ImageProcessor ip = Gen.tex(bits, w, h, seed + 101 * c + 13 * z + 31 * t);
            st.addSlice("c" + (c + 1) + "z" + (z + 1) + "t" + (t + 1), ip);
        }
        ImagePlus imp = new ImagePlus(title, st);
        imp.setDimensions(nc, nz, nt);
        imp.setOpenAsHyperStack(true);
        if (nc > 1 && composite) {
            CompositeImage ci = new CompositeImage(imp, IJ.COMPOSITE);
            ci.setOpenAsHyperStack(true);
            return ci;
        }
        return imp;
    }

    /** Calibration of the tiff / stats cases: micron, 0.5 x 0.5 pixel, z spacing 2, frame interval 1.5 s. */
    static void calibrate(ImagePlus imp) {
        Calibration c = imp.getCalibration();
        c.setUnit("micron"); c.pixelWidth = 0.5; c.pixelHeight = 0.5; c.pixelDepth = 2.0;
        c.frameInterval = 1.5; c.setTimeUnit("sec"); c.fps = 5.0;
        imp.setCalibration(c);
    }

    static ImagePlus calibrate2(ImagePlus imp) { calibrate(imp); return imp; }

    static ColorProcessor rgb(int w, int h, long seed) {
        if (w == 37 && h == 23) { w = 30; h = 18; }
        float[] r = Gen.blobs(w, h, seed, 4, 3, 7, 0.2, 0.0, 0.1, 0.04), g = Gen.blobs(w, h, seed + 1, 4, 3, 7, 0.0, 0.2, 0.1, 0.04), b = Gen.blobs(w, h, seed + 2, 4, 3, 7, 0.1, 0.1, 0.05, 0.04);
        int[] px = new int[w * h];
        for (int i = 0; i < px.length; i++) px[i] = (Math.round(r[i] * 255f) << 16) | (Math.round(g[i] * 255f) << 8) | Math.round(b[i] * 255f);
        return new ColorProcessor(w, h, px);
    }

    static ImagePlus rgbImage(String title, int w, int h, long seed) { return new ImagePlus(title, rgb(w, h, seed)); }

    static ImagePlus rgbStack(String title, int w, int h, int n, long seed) {
        ImageStack st = new ImageStack(w, h);
        for (int i = 0; i < n; i++) st.addSlice(null, rgb(w, h, seed + 7 * i));
        return new ImagePlus(title, st);
    }

    static ImagePlus show(ImagePlus imp) { imp.show(); return imp; }
}
