import ij.*;
import ij.gui.*;
import ij.io.*;
import ij.plugin.BatchProcessor;
import ij.plugin.frame.Recorder;
import ij.process.*;
import java.awt.*;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.util.*;
import java.util.List;
import javax.swing.SwingUtilities;

/**
 * Process > Batch > Macro... (ij.plugin.BatchProcessor, command "Macro... " with its trailing space) of the real ij-1.54p.jar.
 * Writes each case's input folder (tests/fixtures/ij-macro/batch/<id>/in/), runs the batch, copies what it saved to
 * batch/<id>/out/ and records batch-golden.json (Log, error, files processed in order, every saved file with its sha256 and the
 * pixels ImageJ reads back from it). Contract: DOCS/studio-advanced/macros/EXTRAS.md section 14.5.
 *
 * Paths: macro mode (`IJ.run("Macro... ", options)` with Prefs batch.input / batch.output, the way a macro or ImageJ's Recorder
 * replays it), `IJ.runMacro` of a macro calling run("Macro... ", …) (nested interpreter), and the operator path (Executer + the
 * real "Batch Process" NonBlockingGenericDialog filled and its Process / Test button pressed) with ImageJ's Recorder on.
 * Also extracts macros/TimeStamp.ijm from the jar (the "Timestamp" snippet of the dialog) into batch/TimeStamp.ijm.
 *
 * GUI-less but not headless (GenericDialog). Needs -Dij.dir / -Dplugins.dir on an empty folder with macros/ (run_extras.sh).
 * Usage: BatchGolden <outDir (tests/fixtures/ij-macro)>      Local only, never CI.
 */
public class BatchGolden {
    /** A file of an input folder: kind = tif8 | tif16 | tif32 | rgb | png | jpg | txt | bytes | dir; seed varies the pixels. */
    static final class F {
        final String name, kind; final int seed;
        F(String name, String kind, int seed) { this.name = name; this.kind = kind; this.seed = seed; }
    }
    static final class Case {
        final String id; final List<F> files; final String format, filter, code; final boolean output; final String mode;
        String storedMacro; String note;
        Case(String id, List<F> files, String format, String filter, String code, boolean output, String mode) {
            this.id = id; this.files = files; this.format = format; this.filter = filter; this.code = code; this.output = output; this.mode = mode;
        }
        Case stored(String m) { storedMacro = m; return this; }
        Case note(String n) { note = n; return this; }
    }

    static List<F> abc(String kind) { return List.of(new F("a.tif", kind, 1), new F("b.tif", kind, 2), new F("c.tif", kind, 3)); }
    static Case c(String id, List<F> files, String format, String filter, String code, boolean output) {
        return new Case(id, files, format, filter, code, output, "macro");
    }

    static final List<Case> CASES = new ArrayList<>(List.of(
        c("invert-tiff", abc("tif8"), "TIFF", "", "run(\"Invert\");", true),
        c("filter-contains", List.of(new F("a1.tif", "tif8", 1), new F("b2.tif", "tif8", 2), new F("a3.png", "png", 3), new F("ba.tif", "tif8", 4)),
                "TIFF", "a", "print(i+\" \"+getTitle());", true),
        c("filter-regex", List.of(new F("img1.tif", "tif8", 1), new F("img22.tif", "tif8", 2), new F("imgx.tif", "tif8", 3), new F("d.png", "png", 4)),
                "TIFF", "(img\\d+)", "print(i+\" \"+getTitle());", true),
        c("filter-regex-literal-fallback", List.of(new F("a+b.tif", "tif8", 1), new F("aab.tif", "tif8", 2), new F("c.tif", "tif8", 3)),
                "TIFF", "(a+b)", "print(getTitle());", false).note("a name the regular expression does not match is still kept when it contains the text between the parentheses literally"),
        c("filter-none", abc("tif8"), "TIFF", "zz", "print(getTitle());", true),
        c("filter-regex-none", abc("tif8"), "TIFF", "(q+)", "print(getTitle());", true),
        c("filter-star", abc("tif8"), "TIFF", "*", "print(getTitle());", false),
        c("no-output-log", abc("tif8"), "TIFF", "", "print(i+\": \"+getTitle()+\" \"+getWidth()+\"x\"+getHeight()+\" \"+bitDepth());", false),
        c("new-image-output", abc("tif8"), "TIFF", "", "run(\"Duplicate...\", \"title=dup\");\nrun(\"Invert\");\nprint(getTitle()+\" \"+nImages);", true),
        c("new-image-close", abc("tif8"), "TIFF", "", "run(\"Duplicate...\", \"title=dup\");\nrun(\"Invert\");\nclose();", true),
        c("save-batch-output-false", abc("tif8"), "TIFF", "", "setOption(\"SaveBatchOutput\", i!=1);\nrun(\"Invert\");", true),
        c("8bit-tiff-from-16", List.of(new F("a.tif", "tif16", 1), new F("b.tif", "tif16", 2), new F("c.tif", "rgb", 3)), "8-bit TIFF", "",
                "run(\"Add...\", \"value=7\");", true),
        c("8bit-tiff-output-image", List.of(new F("a.tif", "tif16", 1)), "8-bit TIFF", "", "run(\"Duplicate...\", \"title=d\");", true)
                .note("8-bit conversion applies to the input image, the saved image is the duplicate (still 16-bit)"),
        c("png-extension", List.of(new F("a.tif", "tif8", 1), new F("b.tif", "tif16", 2), new F("c.tif", "rgb", 3)), "PNG", "", "run(\"Invert\");", true),
        c("jpeg", List.of(new F("a.tif", "tif8", 1), new F("c.tif", "rgb", 3)), "JPEG", "", "run(\"Invert\");", true),
        c("text-image", List.of(new F("a.tif", "tif8", 1), new F("f.tif", "tif32", 2)), "Text Image", "", "run(\"Invert\");", true),
        c("zip", List.of(new F("a.tif", "tif8", 1)), "ZIP", "", "run(\"Invert\");", true),
        c("raw", List.of(new F("a.tif", "tif16", 1)), "Raw", "", "run(\"Invert\");", true),
        c("tiff-32bit", List.of(new F("f.tif", "tif32", 1)), "TIFF", "", "run(\"Square\");", true),
        c("error-stops", abc("tif8"), "TIFF", "", "if (i==1) x=undefinedVariable;\nrun(\"Invert\");", true),
        c("exit-stops", abc("tif8"), "TIFF", "", "if (i==1) exit;\nrun(\"Invert\");", true),
        c("index-values", List.of(new F(".hidden.tif", "tif8", 1), new F("sub", "dir", 0), new F("notes.txt", "txt", 0), new F("x.avi", "bytes", 0),
                new F("Thumbs.db", "bytes", 0), new F("a.tif", "tif8", 2), new F("b.png", "png", 3), new F("junk.bin", "bytes", 0)), "TIFF", "",
                "print(\"i=\"+i+\" \"+getTitle());", false),
        c("sort-order", List.of(new F("b10.tif", "tif8", 1), new F("b2.tif", "tif8", 2), new F("B1.tif", "tif8", 3), new F("a.tif", "tif8", 4),
                new F("_c.tif", "tif8", 5), new F("Z.tif", "tif8", 6)), "TIFF", "", "print(i+\" \"+getTitle());", false),
        c("snippet-crop", abc("tif8"), "TIFF", "", "makeRectangle(getWidth/4, getHeight/4, getWidth/2, getHeight/2);\nrun(\"Crop\");\n", true),
        c("snippet-add-border", List.of(new F("a.tif", "tif8", 1)), "TIFF", "",
                "border=25;\nw=getWidth+border*2; h=getHeight+border*2;\nrun(\"Canvas Size...\", \"width=w height=h position=Center zero\");\n", true),
        c("snippet-print-index", abc("tif8"), "TIFF", "", "if (i==0) print(\"\\\\Clear\"); print(IJ.pad(i,4)+\": \"+getTitle());\n", false),
        c("batchmode-show", abc("tif8"), "TIFF", "", "print(is(\"Batch Mode\")+\" \"+nImages+\" \"+getTitle()+\" \"+getInfo(\"image.filename\"));", false),
        c("selection-kept", List.of(new F("a.tif", "tif8", 1)), "TIFF", "", "makeRectangle(2,2,4,4);\nrun(\"Invert\");", true),
        new Case("run-from-macro", abc("tif8"), "PNG", "", "run(\"Invert\");", true, "runMacro"),
        new Case("stored-macro-default", abc("tif8"), null, "", null, true, "macro").stored("run(\"Invert\");\nprint(\"stored \"+i);\n")
                .note("options give only file=[]: the stored format (Prefs batch.format = PNG here) and macros/BatchMacro.ijm are used"),
        new Case("bad-input", abc("tif8"), "TIFF", "", "run(\"Invert\");", true, "badInput"),
        new Case("bad-output", abc("tif8"), "TIFF", "", "run(\"Invert\");", true, "badOutput"),
        new Case("no-code", abc("tif8"), "TIFF", "", "", true, "macro"),
        new Case("recorded", abc("tif8"), "TIFF", "", "run(\"Invert\");", true, "operator"),
        new Case("recorded-filter", abc("tif8"), "PNG", "b", "run(\"Invert\");\nprint(i);", true, "operator"),
        new Case("test-button", List.of(new F(".DS_Store", "bytes", 0), new F("b.tif", "tif8", 2), new F("a.tif", "tif8", 1)), "TIFF", "",
                "run(\"Invert\");\nprint(\"test \"+i+\" \"+getTitle());", true, "test")
    ));

    static ImageProcessor plane(String kind, int seed, int w, int h) {
        ImageProcessor ip = kind.equals("tif16") ? new ShortProcessor(w, h) : kind.equals("tif32") ? new FloatProcessor(w, h)
                : kind.equals("rgb") ? new ColorProcessor(w, h) : new ByteProcessor(w, h);
        for (int y = 0; y < h; y++) for (int x = 0; x < w; x++) {
            switch (kind) {
                case "tif16": ip.set(x, y, (x * 977 + y * 311 + seed * 4001) % 65536); break;
                case "tif32": ip.setf(x, y, (float) ((x - 5) * 1.5 + y * 0.25 + seed)); break;
                case "rgb": ip.set(x, y, 0xff000000 | (((x * 15 + seed * 20) & 255) << 16) | (((y * 19) & 255) << 8) | ((x * 7 + y * 3 + seed * 50) & 255)); break;
                default: ip.set(x, y, (x * 9 + y * 13 + seed * 31) & 255);
            }
        }
        return ip;
    }

    static void writeInputs(Case k, Path in) throws IOException {
        if (Files.exists(in)) deleteTree(in);
        Files.createDirectories(in);
        for (F f : k.files) {
            Path p = in.resolve(f.name);
            switch (f.kind) {
                case "dir": Files.createDirectories(p); Files.write(p.resolve("inner.tif"), tiffBytes("tif8", 9, f.name)); break;
                case "txt": Files.write(p, "notes, not an image\n".getBytes(StandardCharsets.UTF_8)); break;
                case "bytes": Files.write(p, new byte[] { 1, 2, 3, 4, 5, 6, 7, 8 }); break;
                case "png": {
                    ImagePlus imp = new ImagePlus(f.name, plane("tif8", f.seed, 16, 12));
                    new FileSaver(imp).saveAsPng(p.toString());
                    break;
                }
                default: Files.write(p, tiffBytes(f.kind, f.seed, f.name));
            }
        }
    }

    static byte[] tiffBytes(String kind, int seed, String title) {
        ImagePlus imp = new ImagePlus(title, plane(kind, seed, 16, 12));
        return new FileSaver(imp).serialize();
    }

    static void deleteTree(Path p) throws IOException {
        if (!Files.exists(p)) return;
        try (java.util.stream.Stream<Path> s = Files.walk(p)) {
            List<Path> all = new ArrayList<>(); s.forEach(all::add);
            Collections.reverse(all);
            for (Path x : all) Files.delete(x);
        }
    }

    static String bracket(String s) { return "[" + s + "]"; }

    static String optionsOf(Case k) {
        StringBuilder b = new StringBuilder();
        if (k.format != null) b.append("output_format=").append(k.format.contains(" ") ? bracket(k.format) : k.format);
        if (k.filter != null) b.append(b.length() > 0 ? " " : "").append("file=").append(bracket(k.filter));
        if (k.code != null) b.append(b.length() > 0 ? " " : "").append("text1=").append(bracket(k.code));
        return b.toString();
    }

    static String slash(Path p) { return p.toAbsolutePath().toString().replace('\\', '/') + "/"; }

    public static void main(String[] a) throws Exception {
        Locale.setDefault(Locale.ROOT);
        Path root = Paths.get(a[0]).toAbsolutePath();
        Path base = root.resolve("batch");
        Files.createDirectories(base);
        String only = System.getProperty("ijm.only", "");
        String ts = BatchProcessor.openMacroFromJar("TimeStamp.ijm");
        Files.write(base.resolve("TimeStamp.ijm"), ts.getBytes(StandardCharsets.UTF_8));
        Path scratch = Files.createTempDirectory("ijm-batch");
        // an ImageJ instance (never shown): IJ.error opens ImageJ's message box and IJ.log writes to the Log window, as for the operator
        new ImageJ(ImageJ.NO_SHOW);
        Kit.seen.addAll(Arrays.asList(Window.getWindows()));
        String macrosDir = Menus.getMacrosPath();
        Map<String, Object> cases = new LinkedHashMap<>();
        boolean recorderInstalled = false;
        TextArea recText = null;
        for (Case k : CASES) {
            if (!only.isEmpty() && !k.id.contains(only)) continue;
            Path dir = base.resolve(k.id), in = dir.resolve("in"), outFix = dir.resolve("out");
            writeInputs(k, in);
            deleteTree(outFix);
            Path out = scratch.resolve(k.id);
            deleteTree(out);
            Files.createDirectories(out);
            // the jar must see a real folder: the case's input folder of the fixtures, read only
            String inPath = k.mode.equals("badInput") ? slash(in) + "missing/" : slash(in);
            String outPath = !k.output ? "" : k.mode.equals("badOutput") ? slash(out) + "missing/" : slash(out);
            Prefs.set("batch.input", inPath);
            Prefs.set("batch.output", outPath);
            Prefs.set("batch.format", k.storedMacro != null ? "PNG" : "TIFF");
            setStaticFormat(k.storedMacro != null ? "PNG" : "TIFF");
            String mdir = Menus.getMacrosPath();
            if (mdir == null) mdir = IJ.getDirectory("macros");
            Path stored = mdir == null ? null : Paths.get(mdir, "BatchMacro.ijm");
            if (stored != null) { Files.deleteIfExists(stored); if (k.storedMacro != null) Files.write(stored, k.storedMacro.getBytes(StandardCharsets.UTF_8)); }
            final String options = optionsOf(k);
            Map<String, Object> e = Kit.map("input", "batch/" + k.id + "/in");
            e.put("files", fileList(k));
            Map<String, Object> opt = Kit.map("output_format", k.format, "file", k.filter, "code", k.code);
            e.put("options", opt);
            e.put("output", k.output);
            e.put("mode", k.mode);
            if (k.note != null) e.put("note", k.note);
            if (k.storedMacro != null) e.put("storedMacro", k.storedMacro);
            Kit.Watched r;
            String recorded = null;
            Map<String, Object> testImage = null;
            closeImages();
            if (k.mode.equals("operator") || k.mode.equals("test")) {
                if (!recorderInstalled) {
                    new Recorder(false);
                    java.lang.reflect.Field f = Recorder.class.getDeclaredField("textArea");
                    f.setAccessible(true);
                    recText = (TextArea) f.get(null);
                    Recorder.record = true;
                    recorderInstalled = true;
                    Kit.seen.addAll(Arrays.asList(Window.getWindows()));
                }
                recText.setText("");
                final Case kk = k;
                final Map<String, Object>[] ti = new Map[1];
                r = Kit.runWatchedOperator(() -> Kit.doCommandAndWait("Macro... "), (w) -> operate(kk, w, ti), 90000);
                testImage = ti[0];
                recorded = recText.getText();
            } else if (k.mode.equals("runMacro")) {
                String macro = "run(\"Macro... \", \"" + options.replace("\\", "\\\\").replace("\"", "\\\"") + "\");\nprint(\"after batch\");";
                e.put("macro", macro);
                r = Kit.runWatched(() -> IJ.runMacro(macro), 90000);
            } else {
                e.put("optionString", options);
                r = Kit.runWatched(() -> IJ.run("Macro... ", options), 90000);
            }
            e.put("log", r.log);
            e.put("error", r.error());
            List<Map<String, Object>> dialogs = new ArrayList<>(r.otherDialogs);
            e.put("dialogs", dialogs);
            if (r.thrown != null) e.put("thrown", String.valueOf(r.thrown));
            if (r.stdout != null) e.put("stdout", r.stdout);
            if (recorded != null) {
                List<Object> stripped = new ArrayList<>();
                e.put("recorded", RecorderGolden.stripAsyncActivations(recorded, new ArrayList<>(), stripped));
                if (!stripped.isEmpty()) e.put("asyncActivationStripped", stripped);
            }
            if (testImage != null) e.put("testImage", testImage);
            Map<String, Object> outs = new LinkedHashMap<>();
            if (Files.isDirectory(out)) {
                List<Path> saved = new ArrayList<>();
                try (java.util.stream.Stream<Path> s = Files.walk(out)) { s.filter(Files::isRegularFile).forEach(saved::add); }
                Collections.sort(saved);
                for (Path p : saved) {
                    String rel = out.relativize(p).toString().replace('\\', '/');
                    byte[] bytes = Files.readAllBytes(p);
                    Path dst = outFix.resolve(rel);
                    Files.createDirectories(dst.getParent());
                    Files.write(dst, bytes);
                    Map<String, Object> o = Kit.map("sha256", Kit.sha256(bytes), "size", bytes.length);
                    if (rel.endsWith(".zip")) o.put("reproducible", false);
                    ImagePlus back = "Raw".equals(k.format) ? null : IJ.openImage(p.toString());
                    if (back != null) {
                        o.put("pixels", Kit.map("width", back.getWidth(), "height", back.getHeight(), "bitDepth", back.getBitDepth(),
                                "sha256", Kit.sha256(Kit.planes(back))));
                        back.close();
                    }
                    outs.put(rel, o);
                }
            }
            e.put("outputs", outs);
            e.put("processed", processedOf(k, r, outs));
            String after = stored == null || !Files.exists(stored) ? null : new String(Files.readAllBytes(stored), StandardCharsets.UTF_8);
            e.put("storedAfter", Kit.map("batch.input", Prefs.get("batch.input", null) == null ? null : rel(Prefs.get("batch.input", ""), root),
                    "batch.output", rel(Prefs.get("batch.output", ""), root, out, "<output>/"), "batch.format", Prefs.get("batch.format", null),
                    "BatchMacro.ijm", after));
            e.put("openImagesAfter", openTitles());
            Kit.scrub(e, new String[][] { { slash(in), "<input>/" }, { slash(out), "<output>/" }, { slash(scratch), "<scratch>/" }, { slash(root), "<fixtures>/" } });
            cases.put(k.id, e);
            System.out.println(k.id + ": processed=" + e.get("processed") + " outputs=" + outs.keySet() + (r.error() != null ? " error=" + r.error().get("message") : "")
                    + (dialogs.isEmpty() ? "" : " dialogs=" + dialogs));
            closeImages();
        }
        Map<String, Object> doc = Kit.map("imagej", IJ.getVersion(), "generator", "tools/ij_fixtures/macro/BatchGolden.java",
                "note", "input = the folder the jar read (fixtures, relative to tests/fixtures/ij-macro); files = what the driver wrote in it "
                        + "(kind tif8/tif16/tif32/rgb = an ImageJ TIFF of 16x12 pixels from BatchGolden.plane(kind, seed), png = 8-bit PNG, "
                        + "dir = a sub-folder holding inner.tif, txt / bytes = not images); outputs = every file saved in the output folder (copied to "
                        + "batch/<id>/out/), pixels = ImageJ's read-back of it (MathGolden layout). processed = the titles the macro's i-th "
                        + "run saw, recovered from the Log when the code prints them, else from the saved files; storedAfter = what ImageJ "
                        + "stored at the end (Prefs + macros/BatchMacro.ijm). mode: macro = IJ.run(\"Macro... \", optionString); runMacro = "
                        + "a macro calling it; operator = Executer + the real dialog, Process pressed, Recorder on; test = the Test button",
                "timeStamp", "batch/TimeStamp.ijm",
                "cases", cases);
        Kit.writeJson(root.resolve("batch-golden.json"), doc);
        deleteTree(scratch);
        System.exit(0);
    }

    static String rel(String path, Path root) { return rel(path, root, null, null); }
    static String rel(String path, Path root, Path out, String outName) {
        if (path == null || path.isEmpty()) return path;
        String p = path.replace('\\', '/');
        if (out != null && p.startsWith(slash(out))) return outName + p.substring(slash(out).length());
        String r = slash(root);
        return p.startsWith(r) ? p.substring(r.length()) : "<elsewhere>";
    }

    static List<Object> fileList(Case k) {
        List<Object> l = new ArrayList<>();
        for (F f : k.files) l.add(Kit.map("name", f.name, "kind", f.kind, "seed", f.seed));
        return l;
    }

    /**
     * Input names the macro ran on, in order: from the Log when the code prints the title (every print-title case), else from the
     * names of the saved files (the input name, extension changed by the format), else empty.
     */
    static Map<String, Object> processedOf(Case k, Kit.Watched r, Map<String, Object> outs) {
        List<String> names = new ArrayList<>();
        for (F f : k.files) if (!f.kind.equals("dir")) names.add(f.name);
        names.sort((x, y) -> y.length() - x.length());
        List<Object> l = new ArrayList<>();
        for (String s : r.log) {
            if (s.startsWith("openImage()") || s.startsWith("Opener:") || s.contains("/")) continue;
            for (String n : names) if (s.contains(n)) { if (!l.contains(n)) l.add(n); break; }
        }
        if (!l.isEmpty()) return Kit.map("from", "log", "names", l);
        for (String o : outs.keySet()) {
            String base = o.contains(".") ? o.substring(0, o.lastIndexOf('.')) : o;
            for (F f : k.files) {
                String fb = f.name.contains(".") ? f.name.substring(0, f.name.lastIndexOf('.')) : f.name;
                if (fb.equals(base) && !l.contains(f.name)) { l.add(f.name); break; }
            }
        }
        return Kit.map("from", l.isEmpty() ? "none" : "outputs", "names", l);
    }

    static void closeImages() { for (ImagePlus i : openImages()) { i.changes = false; i.close(); } }

    static List<ImagePlus> openImages() {
        List<ImagePlus> l = new ArrayList<>();
        int[] ids = WindowManager.getIDList();
        if (ids != null) for (int id : ids) { ImagePlus i = WindowManager.getImage(id); if (i != null) l.add(i); }
        return l;
    }
    static List<Object> openTitles() { List<Object> l = new ArrayList<>(); for (ImagePlus i : openImages()) l.add(i.getTitle()); return l; }

    static void setStaticFormat(String f) throws Exception {
        java.lang.reflect.Field fl = BatchProcessor.class.getDeclaredField("format");
        fl.setAccessible(true);
        fl.set(null, f);
    }

    /** The operator: fills the "Batch Process" dialog (folders come from Prefs as ImageJ's own TextFields read them) and presses Process / Test. */
    static boolean operate(Case k, Window w, Map<String, Object>[] testImage) throws Exception {
        if (!(w instanceof GenericDialog) || !"Batch Process".equals(((Dialog) w).getTitle())) return false;
        GenericDialog gd = (GenericDialog) w;
        SwingUtilities.invokeAndWait(() -> {
            Vector<?> ch = gd.getChoices();
            ((Choice) ch.get(0)).select(k.format);
            Vector<?> sf = gd.getStringFields();
            ((TextField) sf.get(sf.size() - 1)).setText(k.filter);
            gd.getTextArea1().setText(k.code);
        });
        Thread.sleep(100);
        if (k.mode.equals("test")) {
            Kit.press(gd, "Test");
            long t0 = System.currentTimeMillis();
            ImagePlus shown = null;
            while (System.currentTimeMillis() - t0 < 20000) {
                shown = WindowManager.getCurrentImage();
                if (shown != null && shown.getWindow() != null && shown.getWindow().isVisible()) break;
                Thread.sleep(50);
            }
            Thread.sleep(300);
            if (shown != null) testImage[0] = Kit.map("title", shown.getTitle(), "width", shown.getWidth(), "height", shown.getHeight(),
                    "bitDepth", shown.getBitDepth(), "sha256", Kit.sha256(Kit.planes(shown)));
            Kit.press(gd, "Cancel");
        } else {
            Kit.press(gd, "Process");
        }
        return true;
    }
}
