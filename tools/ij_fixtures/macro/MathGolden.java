import ij.*;
import ij.gui.*;
import ij.process.*;
import java.awt.*;
import java.awt.event.*;
import java.io.*;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.security.MessageDigest;
import java.util.*;
import java.util.List;
import javax.swing.SwingUtilities;

/**
 * Process > Math > Macro... (ij.plugin.filter.ImageMath "macro") of the real ij-1.54p.jar on generated images: writes, per case,
 * the input planes, the output planes (little-endian, slices concatenated; RGB = R, G, B planes per slice) and the Log, into
 * tests/fixtures/ij-macro/math/ and math-golden.json. Contract: DOCS/studio-advanced/macros/EXTRAS.md section 14.4.
 *
 * GUI-less but NOT headless: in macro mode the GenericDialog is built (never shown), which a headless JVM refuses. A macro error
 * opens ImageJ's "Macro Error" dialog: Kit.runWatched reads its text and presses OK, as the operator would.
 * No ImageJ instance: IJ.log then writes to System.out, which Kit captures.
 *
 * Usage: MathGolden <outDir (tests/fixtures/ij-macro)>     Local only, never CI.
 */
public class MathGolden {
    static final class Case {
        final String id; final int bitDepth, w, h, slices, current; final String fill, options; final String[] roi;
        final boolean timingOnly;
        Case(String id, int bitDepth, int w, int h, int slices, int current, String fill, String[] roi, String options, boolean timingOnly) {
            this.id = id; this.bitDepth = bitDepth; this.w = w; this.h = h; this.slices = slices; this.current = current; this.fill = fill;
            this.roi = roi; this.options = options; this.timingOnly = timingOnly;
        }
    }

    static Case c(String id, int bd, int w, int h, String fill, String options) { return new Case(id, bd, w, h, 1, 1, fill, null, options, false); }
    static String[] rect(int x, int y, int w, int h) { return new String[] { "rect", "" + x, "" + y, "" + w, "" + h }; }
    static String[] oval(int x, int y, int w, int h) { return new String[] { "oval", "" + x, "" + y, "" + w, "" + h }; }

    static final List<Case> CASES = new ArrayList<>(List.of(
        c("v-times-2-8bit", 8, 64, 48, "ramp", "code=v=v*2"),
        c("default-sin-d", 8, 64, 48, "ramp", "code=v=v+50*sin(d/10)"),
        c("x-clamp", 8, 40, 8, "ramp", "code=v=x*10"),
        c("angle-a", 32, 17, 13, "ramp", "code=v=a"),
        c("angle-a-8bit", 8, 32, 24, "ramp", "code=v=a*40"),
        c("distance-d", 32, 17, 13, "ramp", "code=v=d"),
        c("distance-d-odd-even", 32, 16, 11, "ramp", "code=v=d+a/100"),
        c("16bit-times-100", 16, 32, 24, "ramp", "code=v=v*100"),
        c("32bit-sqrt", 32, 32, 24, "ramp", "code=v=sqrt(v)"),
        c("32bit-x-over-w", 32, 32, 24, "ramp", "code=v=x/w+y/h"),
        c("32bit-negative-nan", 32, 16, 8, "ramp", "code=v=log(v-100)"),
        c("rgb-invert", 24, 32, 24, "ramp", "code=v=255-v"),
        c("rgb-getpixel-packed", 24, 32, 24, "ramp", "code=v=getPixel(w-1-x,y)"),
        c("rgb-getpixel-arith", 24, 16, 8, "ramp", "code=v=getPixel(x,y)+1"),
        c("rgb-x", 24, 40, 8, "ramp", "code=v=v+x*8"),
        c("getpixel-neighbour", 8, 32, 24, "ramp", "code=v=getPixel(x+1,y)"),
        c("getpixel-16bit", 16, 32, 24, "ramp", "code=v=getPixel(x,y+1)*3"),
        c("getpixel-32bit", 32, 16, 12, "ramp", "code=v=(getPixel(x-1,y)+getPixel(x+1,y))/2"),
        new Case("oval-mask", 8, 48, 40, 1, 1, "ramp", oval(6, 5, 30, 22), "code=v=255", false),
        new Case("rect-roi", 8, 48, 40, 1, 1, "ramp", rect(10, 7, 20, 15), "code=v=v+100", false),
        new Case("rect-roi-xd", 32, 48, 40, 1, 1, "ramp", rect(10, 7, 20, 15), "code=v=x*1000+y+d/1000", false),
        new Case("oval-rgb", 24, 32, 24, 1, 1, "ramp", oval(4, 3, 20, 16), "code=v=0", false),
        // getPixel with a selection: the first run's getPixel resets the roi of the processor (ImagePlus.getProcessor), so the whole
        // plane is processed unmasked; named but not run there, the loop writes into a zeroed copy copied back whole (zeros outside
        // the bounding rectangle) and reset(mask) restores the source inside it
        new Case("roi-getpixel-first-rect", 8, 48, 40, 1, 1, "ramp", rect(10, 7, 20, 15), "code=v=getPixel(x,y)+1", false),
        new Case("roi-getpixel-first-oval", 8, 48, 40, 1, 1, "ramp", oval(6, 5, 30, 22), "code=v=getPixel(x,y)+1", false),
        new Case("roi-getpixel-later-rect", 8, 48, 40, 1, 1, "ramp", rect(10, 7, 20, 15), "code=[if (x>0) v=getPixel(x-1,y)+1; else v=7;]", false),
        new Case("roi-getpixel-later-oval", 16, 48, 40, 1, 1, "ramp", oval(6, 5, 30, 22), "code=[if (x>0) v=getPixel(x-1,y)+1; else v=7;]", false),
        new Case("roi-getpixel-later-rgb", 24, 32, 24, 1, 1, "ramp", rect(5, 4, 12, 10), "code=[if (x>0) v=getPixel(x-1,y); else v=0;]", false),
        new Case("stack-z", 8, 24, 16, 3, 1, "ramp", null, "code=v=z*10 stack", false),
        new Case("stack-z-16bit", 16, 24, 16, 3, 2, "ramp", null, "code=v=v+z*1000 stack", false),
        new Case("slice-only", 8, 24, 16, 3, 2, "ramp", null, "code=v=255+z slice", false),
        new Case("stack-no-word", 8, 24, 16, 3, 3, "ramp", null, "code=v=z*10", false),
        c("no-equals", 8, 32, 24, "ramp", "code=v*2"),
        c("nan-8bit", 8, 16, 8, "ramp", "code=v=NaN"),
        c("nan-16bit", 16, 16, 8, "ramp", "code=v=0/0"),
        c("negative-trunc", 8, 16, 8, "ramp", "code=[if (x%2==0) v=-5.7; else v=5.7+v/10;]"),
        c("negative-trunc-16bit", 16, 16, 8, "ramp", "code=[if (x%2==0) v=-5.7; else v=5.7+v/10;]"),
        c("16bit-clamp-70000", 16, 16, 8, "ramp", "code=[if (x<5) v=70000; else v=-3;]"),
        c("8bit-huge", 8, 16, 8, "ramp", "code=v=1e12*(x-8)"),
        c("if-else", 8, 32, 24, "ramp", "code=[if (v>100) v=255; else v=0;]"),
        c("print-count-2x2", 8, 2, 2, "ramp", "code=[print(v); v=v+1;]"),
        c("print-no-equals", 8, 3, 2, "ramp", "code=[print(x+\",\"+y+\":\"+v);]"),
        c("print-xy", 8, 3, 2, "ramp", "code=[v=v; print(x+\",\"+y+\":\"+v);]"),
        c("error-unknown-var", 8, 16, 8, "ramp", "code=v=v*k"),
        c("error-syntax", 8, 16, 8, "ramp", "code=[v=v*(2;]"),
        c("options-v-prefix", 8, 16, 8, "ramp", "v=v+1"),
        c("functions-and-vars", 8, 32, 24, "ramp", "code=[t=floor(x/8); v=t*40+round(y/4);]"),
        c("width-height", 8, 20, 12, "ramp", "code=v=w*10+h"),
        c("getwidth-host", 8, 20, 12, "ramp", "code=v=getWidth()+getHeight()"),
        new Case("perf-512", 8, 512, 512, 1, 1, "ramp", null, "code=v=v+50*sin(d/10)", true),
        new Case("perf-512-times2", 8, 512, 512, 1, 1, "ramp", null, "code=v=v*2", true)
    ));

    /** The documented generator of every input plane ("ramp"): written to the golden as `fillFormula` and as `<case>.in.bin`. */
    static double ramp(int bitDepth, int x, int y, int z) {
        switch (bitDepth) {
            case 8: return (x * 5 + y * 3 + z * 40) & 255;
            case 16: return (x * 701 + y * 263 + z * 9001) % 65536;
            case 32: return (x - 7) * 13.25 + (y - 3) * 0.5 - z * 2.75;
            default: throw new IllegalArgumentException();
        }
    }
    static int rampRgb(int x, int y, int z) {
        int r = (x * 7 + z * 50) & 255, g = (y * 11 + 30) & 255, b = (x * 3 + y * 5 + 200) & 255;
        return 0xff000000 | (r << 16) | (g << 8) | b;
    }

    static ImagePlus build(Case k) {
        ImageStack st = new ImageStack(k.w, k.h);
        for (int z = 0; z < k.slices; z++) {
            ImageProcessor ip;
            if (k.bitDepth == 8) ip = new ByteProcessor(k.w, k.h);
            else if (k.bitDepth == 16) ip = new ShortProcessor(k.w, k.h);
            else if (k.bitDepth == 32) ip = new FloatProcessor(k.w, k.h);
            else ip = new ColorProcessor(k.w, k.h);
            for (int y = 0; y < k.h; y++) for (int x = 0; x < k.w; x++) {
                if (k.bitDepth == 24) ip.set(x, y, rampRgb(x, y, z));
                else if (k.bitDepth == 32) ip.setf(x, y, (float) ramp(32, x, y, z));
                else ip.set(x, y, (int) ramp(k.bitDepth, x, y, z));
            }
            st.addSlice("", ip);
        }
        ImagePlus imp = new ImagePlus(k.id, st);
        if (k.slices > 1) imp.setSlice(k.current);
        if (k.roi != null) {
            int x = Integer.parseInt(k.roi[1]), y = Integer.parseInt(k.roi[2]), w = Integer.parseInt(k.roi[3]), h = Integer.parseInt(k.roi[4]);
            imp.setRoi(k.roi[0].equals("oval") ? new OvalRoi(x, y, w, h) : new Roi(x, y, w, h));
        }
        return imp;
    }

    public static void main(String[] a) throws Exception {
        Locale.setDefault(Locale.ROOT);
        Path out = Paths.get(a[0]);
        Path dir = out.resolve("math");
        Files.createDirectories(dir);
        String only = System.getProperty("ijm.only", "");
        Map<String, Object> cases = new LinkedHashMap<>();
        for (Case k : CASES) {
            if (!only.isEmpty() && !k.id.contains(only)) continue;
            ImagePlus imp = build(k);
            byte[] in = Kit.planes(imp);
            Kit.Watched r = Kit.runWatched(() -> IJ.run(imp, "Macro...", k.options), 60000);
            byte[] res = Kit.planes(imp);
            Map<String, Object> img = Kit.map("bitDepth", k.bitDepth, "width", k.w, "height", k.h, "slices", k.slices, "currentSlice", k.current, "fill", k.fill);
            img.put("roi", k.roi == null ? null : Kit.map("type", k.roi[0], "x", Integer.parseInt(k.roi[1]), "y", Integer.parseInt(k.roi[2]),
                    "width", Integer.parseInt(k.roi[3]), "height", Integer.parseInt(k.roi[4])));
            Map<String, Object> e = Kit.map("image", img, "options", k.options);
            if (k.timingOnly) {
                e.put("timingOnly", true);
                e.put("jarMs", r.millis);
                e.put("log", r.log);
                e.put("error", r.error());
                cases.put(k.id, e);
                System.out.println(k.id + ": " + r.millis + " ms (timing only)");
                continue;
            }
            Files.write(dir.resolve(k.id + ".in.bin"), in);
            Files.write(dir.resolve(k.id + ".out.bin"), res);
            e.put("log", r.log);
            e.put("error", r.error());
            if (!r.otherDialogs.isEmpty()) e.put("dialogs", r.otherDialogs);
            e.put("input", k.id + ".in.bin");
            e.put("inputSha256", Kit.sha256(in));
            e.put("data", k.id + ".out.bin");
            e.put("sha256", Kit.sha256(res));
            e.put("changed", !Arrays.equals(in, res));
            e.put("probe", probe(imp, k));
            cases.put(k.id, e);
            System.out.println(k.id + ": " + (r.error() == null ? "ok" : "error " + r.error()) + " log=" + r.log.size() + " changed=" + !Arrays.equals(in, res));
            imp.changes = false; imp.close();
        }
        Map<String, Object> doc = Kit.map("imagej", IJ.getVersion(), "generator", "tools/ij_fixtures/macro/MathGolden.java",
                "layout", "each file = the image's planes in stack order, little-endian: 8-bit 1 byte, 16-bit uint16, 32-bit float32, "
                        + "24-bit RGB = for each slice the R plane, then G, then B (1 byte each)",
                "fillFormula", Kit.map(
                        "8", "(x*5 + y*3 + z*40) & 255",
                        "16", "(x*701 + y*263 + z*9001) % 65536",
                        "32", "(float)((x-7)*13.25 + (y-3)*0.5 - z*2.75)",
                        "24", "r = (x*7 + z*50) & 255, g = (y*11 + 30) & 255, b = (x*3 + y*5 + 200) & 255"),
                "note", "z = 0-based slice index; currentSlice = the slice shown when the command ran (1-based); "
                        + "probe = a few output values read back by the jar (x, y, z, value) to check the layout by hand",
                "cases", cases);
        Kit.writeJson(out.resolve("math-golden.json"), doc);
        System.exit(0);
    }

    static List<Object> probe(ImagePlus imp, Case k) {
        List<Object> p = new ArrayList<>();
        int[][] pts = { { 0, 0 }, { k.w - 1, 0 }, { k.w / 2, k.h / 2 }, { k.w - 1, k.h - 1 } };
        ImageStack st = imp.getStack();
        for (int z = 0; z < k.slices; z++) for (int[] pt : pts) {
            ImageProcessor ip = st.getProcessor(z + 1);
            Object v = k.bitDepth == 32 ? (Object) Double.valueOf(ip.getf(pt[0], pt[1])) : k.bitDepth == 24
                    ? String.format("#%06x", ip.get(pt[0], pt[1]) & 0xffffff) : (Object) Integer.valueOf(ip.get(pt[0], pt[1]));
            if (v instanceof Double && (((Double) v).isNaN() || ((Double) v).isInfinite())) v = String.valueOf(v);
            p.add(Arrays.asList(pt[0], pt[1], z, v));
        }
        return p;
    }
}

/** Shared by the four Extras drivers (compiled together by run_extras.sh). */
final class Kit {
    static Map<String, Object> map(Object... kv) {
        Map<String, Object> m = new LinkedHashMap<>();
        for (int i = 0; i < kv.length; i += 2) m.put((String) kv[i], kv[i + 1]);
        return m;
    }

    static String sha256(byte[] b) {
        try {
            byte[] d = MessageDigest.getInstance("SHA-256").digest(b);
            StringBuilder s = new StringBuilder();
            for (byte x : d) s.append(String.format("%02x", x & 255));
            return s.toString();
        } catch (Exception e) { throw new RuntimeException(e); }
    }

    /** The image's pixels as in the golden `layout`. */
    static byte[] planes(ImagePlus imp) {
        ImageStack st = imp.getStack();
        int w = imp.getWidth(), h = imp.getHeight(), n = st.getSize(), bd = imp.getBitDepth();
        int per = bd == 8 ? w * h : bd == 16 ? w * h * 2 : bd == 32 ? w * h * 4 : w * h * 3;
        ByteBuffer bb = ByteBuffer.allocate(per * n).order(ByteOrder.LITTLE_ENDIAN);
        for (int z = 1; z <= n; z++) {
            Object px = st.getPixels(z);
            if (bd == 8) bb.put((byte[]) px);
            else if (bd == 16) for (short s : (short[]) px) bb.putShort(s);
            else if (bd == 32) for (float f : (float[]) px) bb.putFloat(f);
            else {
                int[] p = (int[]) px;
                for (int sh = 16; sh >= 0; sh -= 8) for (int v : p) bb.put((byte) ((v >> sh) & 255));
            }
        }
        return bb.array();
    }

    static final class Watched {
        List<String> log = new ArrayList<>();
        List<Map<String, Object>> otherDialogs = new ArrayList<>();
        String errorText, stdout; Throwable thrown; boolean timedOut; long millis;
        /** { message, line, excerpt } parsed from the Macro Error dialog: "<message> in line <n>\n[stack] \n<excerpt>". */
        Map<String, Object> error() {
            if (errorText == null) return timedOut ? map("message", "timeout", "line", 0) : null;
            String first = errorText.split("\n", -1)[0];
            int k = first.lastIndexOf(" in line ");
            Map<String, Object> m = map("message", k < 0 ? first : first.substring(0, k), "line", k < 0 ? 0 : Integer.parseInt(first.substring(k + 9).trim()));
            String[] ls = errorText.split("\n", -1);
            m.put("excerpt", ls[ls.length - 1]);
            m.put("dialog", errorText);
            return m;
        }
    }

    static final Set<Window> seen = Collections.newSetFromMap(new IdentityHashMap<>());

    /**
     * Runs `body` in its own thread while the calling thread answers every dialog that appears: the "Macro Error" dialog
     * (text kept, OK pressed), any other dialog (title + text kept, OK / Yes pressed, else disposed). System.out is captured as the Log.
     */
    interface Handler { boolean handle(Window w) throws Exception; }

    static Watched runWatched(Runnable body, long timeoutMs) throws Exception { return runWatchedOperator(body, null, timeoutMs); }

    /** IJ.doCommand(cmd) as a menu click does (an Executer thread named after the command), waiting until that thread ends. */
    static void doCommandAndWait(String cmd) {
        Set<Thread> before = new HashSet<>();
        for (Thread t : Thread.getAllStackTraces().keySet()) if (cmd.equals(t.getName())) before.add(t);
        IJ.doCommand(cmd);
        long t0 = System.currentTimeMillis();
        while (System.currentTimeMillis() - t0 < 120000) {
            Thread found = null;
            for (Thread t : Thread.getAllStackTraces().keySet()) if (cmd.equals(t.getName()) && !before.contains(t)) found = t;
            if (found != null) { try { found.join(); } catch (InterruptedException e) { return; } return; }
            try { Thread.sleep(5); } catch (InterruptedException e) { return; }
        }
    }

    /** As runWatched; `operator`, when set, gets every new dialog first and returns true for the ones it handled itself. */
    static Watched runWatchedOperator(Runnable body, Handler operator, long timeoutMs) throws Exception {
        Watched r = new Watched();
        boolean logWindow = IJ.getInstance() != null;
        if (logWindow) IJ.log("\\Clear");
        PrintStream old = System.out;
        ByteArrayOutputStream buf = new ByteArrayOutputStream();
        PrintStream cap = new PrintStream(buf, true, "UTF-8");
        System.setOut(cap);
        long t0 = System.nanoTime();
        Thread t = new Thread(() -> { try { body.run(); } catch (Throwable e) { r.thrown = e; } }, "extras-run");
        t.setDaemon(true);
        t.start();
        long start = System.currentTimeMillis();
        try {
            while (t.isAlive()) {
                Window w = newDialog();
                if (w != null) {
                    if (operator != null) { seen.add(w); Thread.sleep(150); if (operator.handle(w)) continue; seen.remove(w); }
                    answer(w, r); continue;
                }
                if (System.currentTimeMillis() - start > timeoutMs) { r.timedOut = true; break; }
                t.join(15);
            }
            r.millis = (System.nanoTime() - t0) / 1000000;
            Thread.sleep(30);
            Window w;
            while ((w = newDialog()) != null) answer(w, r);
        } finally {
            System.setOut(old);
        }
        String s = new String(buf.toByteArray(), StandardCharsets.UTF_8).replace("\r\n", "\n");
        if (logWindow) {
            if (!s.isEmpty()) r.stdout = s;
            s = IJ.getLog() == null ? "" : IJ.getLog();
        }
        if (!s.isEmpty()) {
            if (s.endsWith("\n")) s = s.substring(0, s.length() - 1);
            r.log.addAll(Arrays.asList(s.split("\n", -1)));
        }
        return r;
    }

    static Window newDialog() {
        for (Window w : Window.getWindows()) {
            if (seen.contains(w) || !w.isVisible()) continue;
            if (w instanceof Dialog) return w;
        }
        return null;
    }

    static void answer(Window w, Watched r) throws Exception {
        seen.add(w);
        Thread.sleep(60);
        String title = ((Dialog) w).getTitle();
        String text = textOf(w);
        if ("Macro Error".equals(title)) r.errorText = text;
        else r.otherDialogs.add(map("title", title, "text", text));
        if (!press(w, "OK") && !press(w, "Yes")) SwingUtilities.invokeAndWait(w::dispose);
        Thread.sleep(40);
    }

    static boolean press(Container root, String label) throws Exception {
        final boolean[] ok = { false };
        SwingUtilities.invokeAndWait(() -> ok[0] = fire(root, label));
        return ok[0];
    }

    static boolean fire(Container c, String label) {
        for (Component k : c.getComponents()) {
            if (k instanceof Button && ((Button) k).getLabel().trim().equals(label)) {
                k.dispatchEvent(new ActionEvent(k, ActionEvent.ACTION_PERFORMED, ((Button) k).getLabel()));
                return true;
            }
            if (k instanceof Container && fire((Container) k, label)) return true;
        }
        return false;
    }

    static String textOf(Container c) {
        StringBuilder b = new StringBuilder();
        for (Component k : c.getComponents()) {
            String s = null;
            if (k instanceof MultiLineLabel) s = multiLine((MultiLineLabel) k);
            else if (k instanceof Label) s = ((Label) k).getText();
            else if (k instanceof TextArea) s = null;
            else if (k instanceof Container) { s = textOf((Container) k); if (s.isEmpty()) s = null; }
            if (s != null) { if (b.length() > 0) b.append('\n'); b.append(s); }
        }
        return b.toString();
    }

    static String multiLine(MultiLineLabel m) {
        try {
            java.lang.reflect.Field f = MultiLineLabel.class.getDeclaredField("lines");
            f.setAccessible(true);
            String[] ls = (String[]) f.get(m);
            return String.join("\n", ls);
        } catch (Throwable t) { return ""; }
    }

    /** Replaces machine paths in every string of a JSON-like tree: pairs = { {absolute, placeholder}, … }, both slash forms. */
    @SuppressWarnings("unchecked")
    static Object scrub(Object o, String[][] pairs) {
        if (o instanceof String) {
            String s = (String) o;
            for (String[] p : pairs) { s = s.replace(p[0], p[1]); s = s.replace(p[0].replace('/', File.separatorChar), p[1]); }
            return s;
        }
        if (o instanceof Map) { Map<String, Object> m = (Map<String, Object>) o; for (Map.Entry<String, Object> e : m.entrySet()) e.setValue(scrub(e.getValue(), pairs)); return m; }
        if (o instanceof List) { List<Object> l = (List<Object>) o; for (int i = 0; i < l.size(); i++) l.set(i, scrub(l.get(i), pairs)); return l; }
        return o;
    }

    // ------------------------------------------------------------------ JSON (stable key order, 2-space indent)
    static void writeJson(Path p, Object doc) throws IOException {
        StringBuilder b = new StringBuilder();
        json(doc, b, 0);
        b.append('\n');
        Files.write(p, b.toString().getBytes(StandardCharsets.UTF_8));
    }

    static void json(Object o, StringBuilder b, int depth) {
        if (o == null) b.append("null");
        else if (o instanceof String) quote((String) o, b);
        else if (o instanceof Double || o instanceof Float) {
            double d = ((Number) o).doubleValue();
            if (Double.isNaN(d) || Double.isInfinite(d)) quote(String.valueOf(d), b);
            else if (d == Math.rint(d) && Math.abs(d) < 1e15) b.append((long) d); else b.append(d);
        }
        else if (o instanceof Number || o instanceof Boolean) b.append(o);
        else if (o instanceof Map) {
            Map<?, ?> m = (Map<?, ?>) o;
            if (m.isEmpty()) { b.append("{}"); return; }
            boolean inline = depth >= 4 && m.values().stream().allMatch(x -> !(x instanceof Map) && !(x instanceof List));
            b.append('{');
            int i = 0;
            for (Map.Entry<?, ?> e : m.entrySet()) {
                if (i++ > 0) b.append(inline ? ", " : ",");
                if (!inline) b.append('\n').append("  ".repeat(depth + 1));
                quote(String.valueOf(e.getKey()), b); b.append(": "); json(e.getValue(), b, depth + 1);
            }
            if (!inline) b.append('\n').append("  ".repeat(depth));
            b.append('}');
        } else if (o instanceof List) {
            List<?> l = (List<?>) o;
            if (l.isEmpty()) { b.append("[]"); return; }
            boolean inline = l.stream().allMatch(x -> x == null || x instanceof String || x instanceof Number || x instanceof Boolean
                    || (x instanceof List && ((List<?>) x).stream().allMatch(y -> !(y instanceof Map) && !(y instanceof List))));
            b.append('[');
            int i = 0;
            for (Object x : l) {
                if (i++ > 0) b.append(inline ? ", " : ",");
                if (!inline) b.append('\n').append("  ".repeat(depth + 1));
                json(x, b, depth + 1);
            }
            if (!inline) b.append('\n').append("  ".repeat(depth));
            b.append(']');
        } else quote(String.valueOf(o), b);
    }

    static void quote(String s, StringBuilder b) {
        b.append('"');
        for (char c : s.toCharArray()) {
            switch (c) {
                case '"': b.append("\\\""); break;
                case '\\': b.append("\\\\"); break;
                case '\n': b.append("\\n"); break;
                case '\r': b.append("\\r"); break;
                case '\t': b.append("\\t"); break;
                default: if (c < 32 || c == 0x2028 || c == 0x2029 || (c >= 0x7f && c < 0xa0)) b.append(String.format("\\u%04x", (int) c)); else b.append(c);
            }
        }
        b.append('"');
    }
}
