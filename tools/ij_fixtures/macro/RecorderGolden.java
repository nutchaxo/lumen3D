import ij.*;
import ij.gui.*;
import ij.measure.ResultsTable;
import ij.plugin.frame.Recorder;
import ij.plugin.frame.RoiManager;
import ij.process.*;
import java.awt.*;
import java.awt.event.*;
import java.lang.reflect.Field;
import java.lang.reflect.Method;
import java.nio.file.*;
import java.util.*;
import java.util.List;
import javax.swing.JList;
import javax.swing.SwingUtilities;

/**
 * Lines ImageJ 1.54p's Recorder writes for what an OPERATOR does, from the real ij-1.54p.jar in a desktop session: ImageJ shown,
 * a real Recorder (its text read back), real image windows; actions driven as the operator drives them — synthetic MouseEvents
 * dispatched on the event thread to the ImageCanvas after Toolbar.setTool, menu commands through Executer (IJ.doCommand, the menu
 * path), their dialogs answered by setting the fields and pressing the dialog's own buttons, tool windows (Threshold, B&C, ROI
 * Manager, Channels) through their buttons / choices / check boxes (dispatched AWT events to the listeners the window installed).
 * Each case says how it was driven (`driven`). Writes tests/fixtures/ij-macro/recorder-golden.json and recorder/<id>.ijm (the text).
 * Contract: DOCS/studio-advanced/macros/EXTRAS.md section 14.2.
 *
 * Usage: RecorderGolden <outDir (tests/fixtures/ij-macro)>      Local only, never CI. Shows windows: leave the machine alone.
 */
public class RecorderGolden {
    // ------------------------------------------------------------------ case model
    static final class Img {
        final String title, fill; final int bitDepth, w, h, c, z, t;
        Img(String title, int bitDepth, int w, int h, int c, int z, int t, String fill) {
            this.title = title; this.bitDepth = bitDepth; this.w = w; this.h = h; this.c = c; this.z = z; this.t = t; this.fill = fill;
        }
        Map<String, Object> json() { return Kit.map("title", title, "bitDepth", bitDepth, "width", w, "height", h, "c", c, "z", z, "t", t, "fill", fill); }
    }
    interface Body { void run(S s) throws Exception; }
    static final class Case {
        final String id; final List<Img> images = new ArrayList<>(); String current; Body body; String note;
        final List<Body> prep = new ArrayList<>();
        Case(String id) { this.id = id; }
        Case img(String title, int bd, int w, int h, String fill) { images.add(new Img(title, bd, w, h, 1, 1, 1, fill)); if (current == null) current = title; return this; }
        Case img(String title, int bd, int w, int h, int c, int z, int t, String fill) { images.add(new Img(title, bd, w, h, c, z, t, fill)); if (current == null) current = title; return this; }
        Case current(String t) { current = t; return this; }
        Case prep(Body b) { prep.add(b); return this; }
        Case does(Body b) { body = b; return this; }
        Case note(String n) { note = n; return this; }
        String formatWhy, formatText; List<Object> formatActions;
        /** A case the jar cannot be driven to record: its text comes from the cited Recorder.java code, nothing runs. */
        Case formatOnly(String why, String text, List<Object> actions) { formatWhy = why; formatText = text; formatActions = actions; return this; }
    }
    static final List<Case> CASES = new ArrayList<>();
    static Case add(String id) { Case c = new Case(id); CASES.add(c); return c; }

    static final int[][] P(int... xy) { int[][] p = new int[xy.length / 2][]; for (int i = 0; i < p.length; i++) p[i] = new int[] { xy[2 * i], xy[2 * i + 1] }; return p; }

    static {
        add("rect").img("a", 8, 200, 150, "ramp").does(s -> s.tool("rect", "draw", P(20, 30, 90, 80)));
        add("rect-move").img("a", 8, 200, 150, "ramp").does(s -> { s.tool("rect", "draw", P(20, 30, 90, 80)); s.tool("rect", "move", P(50, 50, 70, 60)); });
        add("rect-resize").img("a", 8, 200, 150, "ramp").does(s -> { s.tool("rect", "draw", P(20, 30, 90, 80)); s.tool("rect", "resize", P(90, 80, 120, 100)); });
        add("oval").img("a", 8, 200, 150, "ramp").does(s -> s.tool("oval", "draw", P(30, 20, 110, 90)));
        add("oval-move").img("a", 8, 200, 150, "ramp").does(s -> { s.tool("oval", "draw", P(30, 20, 110, 90)); s.tool("oval", "move", P(70, 55, 80, 65)); });
        add("line").img("a", 8, 200, 150, "ramp").does(s -> s.tool("line", "draw", P(10, 20, 150, 100)));
        add("line-move").img("a", 8, 200, 150, "ramp").does(s -> { s.tool("line", "draw", P(10, 20, 150, 100)); s.tool("line", "move", P(80, 60, 90, 70)); });
        add("line-width5").img("a", 8, 200, 150, "ramp").does(s -> { s.lineWidth(5); s.tool("line", "draw", P(10, 20, 150, 100)); });
        add("polyline").img("a", 8, 200, 150, "ramp").does(s -> s.tool("polyline", "draw", P(10, 10, 60, 40, 100, 20, 140, 90)));
        add("polygon").img("a", 8, 200, 150, "ramp").does(s -> s.tool("polygon", "draw", P(20, 20, 120, 30, 100, 110, 30, 90)));
        add("polygon-move").img("a", 8, 200, 150, "ramp").does(s -> { s.tool("polygon", "draw", P(20, 20, 120, 30, 100, 110, 30, 90)); s.tool("polygon", "move", P(70, 60, 80, 70)); })
            .note("the move of a polygon adds nothing (only the construction is recorded)");
        add("freehand").img("a", 8, 200, 150, "ramp").does(s -> s.tool("freehand", "draw", P(20, 20, 60, 25, 90, 60, 70, 100, 30, 80)));
        add("angle").img("a", 8, 200, 150, "ramp").does(s -> s.tool("angle", "draw", P(20, 100, 80, 40, 150, 90)));
        add("point").img("a", 8, 200, 150, "ramp").does(s -> s.tool("point", "draw", P(42, 37)));
        add("point-shift-add").img("a", 8, 200, 150, "ramp").does(s -> { s.tool("point", "draw", P(42, 37)); s.toolShift("point", "draw", P(100, 80)); });
        add("wand-8-tol0").img("a", 8, 200, 150, "squares").prep(s -> s.wandOptions(0, 8)).does(s -> s.wand(60, 50, 0, 8));
        add("wand-4-tol10").img("a", 8, 200, 150, "squares").prep(s -> s.wandOptions(10, 4)).does(s -> s.wand(130, 70, 10, 4));
        add("activate").img("a", 8, 120, 90, "ramp").img("b", 8, 120, 90, "black").current("a").does(s -> s.activate("b"));
        add("activate-back").img("a", 8, 120, 90, "ramp").img("b", 8, 120, 90, "black").current("a").does(s -> { s.activate("b"); s.activate("a"); });
        add("window-results").img("a", 8, 120, 90, "ramp").prep(s -> s.quiet("Measure")).does(s -> s.window("Results"));
        add("choose-tool-oval").img("a", 8, 120, 90, "ramp").does(s -> s.chooseTool("oval"));
        add("choose-tool-several").img("a", 8, 120, 90, "ramp").does(s -> { s.chooseTool("polygon"); s.chooseTool("wand"); s.chooseTool("hand"); s.chooseTool("rect"); });
        add("thr-open-8bit").img("a", 8, 200, 150, "ramp").does(s -> s.thresholdOpen());
        add("thr-method-otsu-dark").img("a", 8, 200, 150, "ramp").does(s -> { s.thresholdOpen(); s.thrMethod("Otsu"); s.thrDark(true); });
        add("thr-set-8bit").img("a", 8, 200, 150, "ramp").does(s -> { s.thresholdOpen(); s.thrSet("50", "150"); });
        add("thr-set-16bit").img("a", 16, 200, 150, "ramp").does(s -> { s.thresholdOpen(); s.thrSet("1000", "20000"); });
        add("thr-set-32bit").img("a", 32, 200, 150, "ramp").does(s -> { s.thresholdOpen(); s.thrSet("0.5", "10.25"); });
        add("thr-reset").img("a", 8, 200, 150, "ramp").does(s -> { s.thresholdOpen(); s.thrButton("Reset"); });
        add("thr-auto").img("a", 8, 200, 150, "ramp").does(s -> { s.thresholdOpen(); s.thrSet("50", "150"); s.thrButton("Auto"); });
        add("thr-mode-bw").img("a", 8, 200, 150, "ramp").does(s -> { s.thresholdOpen(); s.thrMode("B&W"); });
        add("thr-apply-8bit").img("a", 8, 200, 150, "squares").does(s -> { s.thresholdOpen(); s.thrButton("Apply"); });
        add("thr-apply-8bit-set").img("a", 8, 200, 150, "squares").does(s -> { s.thresholdOpen(); s.thrSet("100", "255"); s.thrButton("Apply"); });
        add("thr-apply-16bit").img("a", 16, 200, 150, "squares").does(s -> { s.thresholdOpen(); s.thrButton("Apply"); });
        add("thr-apply-32bit").img("a", 32, 200, 150, "squares").does(s -> { s.thresholdOpen(); s.thrButtonAnswer("Apply", "Convert to Mask"); });
        add("bc-open").img("a", 8, 200, 150, "ramp").does(s -> s.bcOpen());
        add("bc-set-8bit").img("a", 8, 200, 150, "ramp").does(s -> { s.bcOpen(); s.bcSet("10", "200"); });
        add("bc-set-16bit").img("a", 16, 200, 150, "ramp").does(s -> { s.bcOpen(); s.bcSet("100", "30000"); });
        add("bc-set-32bit-fraction").img("a", 32, 200, 150, "ramp").does(s -> { s.bcOpen(); s.bcSet("0.25", "7.5"); s.tool("rect", "draw", P(20, 30, 90, 80)); })
            .note("ImageJ writes the fractional setMinAndMax without its newline: the next line follows on the same line");
        add("bc-reset").img("a", 8, 200, 150, "ramp").does(s -> { s.bcOpen(); s.bcSet("10", "200"); s.bcButton("Reset"); });
        add("bc-auto").img("a", 8, 200, 150, "ramp").does(s -> { s.bcOpen(); s.bcButton("Auto"); });
        add("bc-apply-8bit").img("a", 8, 200, 150, "ramp").does(s -> { s.bcOpen(); s.bcSet("10", "200"); s.bcApply(); });
        add("rm-add").img("a", 8, 200, 150, "ramp").prep(s -> s.rmOpen()).does(s -> { s.tool("rect", "draw", P(20, 30, 90, 80)); s.rm("Add [t]"); });
        add("rm-select-one").img("a", 8, 200, 150, "ramp").prep(s -> s.rmTwo()).does(s -> s.rmSelect(0));
        add("rm-select-many").img("a", 8, 200, 150, "ramp").prep(s -> s.rmTwo()).does(s -> s.rmSelect(0, 1))
            .note("row 0 clicked, then row 1 added to the selection (Shift+click): ImageJ records each list change");
        add("rm-delete").img("a", 8, 200, 150, "ramp").prep(s -> { s.rmTwo(); s.rmSelect(1); }).does(s -> s.rm("Delete"));
        add("rm-delete-none").img("a", 8, 200, 150, "ramp").prep(s -> s.rmTwo()).does(s -> s.rm("Delete", s.yes()))
            .note("Delete with no row selected: ImageJ asks whether to delete all");
        add("rm-rename").img("a", 8, 200, 150, "ramp").prep(s -> { s.rmTwo(); s.rmSelect(0); }).does(s -> s.rmRename("first"));
        add("rm-measure").img("a", 8, 200, 150, "ramp").prep(s -> s.rmTwo()).does(s -> s.rm("Measure"));
        add("rm-deselect").img("a", 8, 200, 150, "ramp").prep(s -> { s.rmTwo(); s.rmSelect(0); }).does(s -> s.rm("Deselect"));
        add("rm-update").img("a", 8, 200, 150, "ramp").prep(s -> { s.rmTwo(); s.rmSelect(0); }).does(s -> { s.tool("rect", "move", P(40, 40, 50, 45)); s.rm("Update"); });
        add("rm-show-all").img("a", 8, 200, 150, "ramp").prep(s -> s.rmTwo()).does(s -> s.rmCheck("Show All", true));
        add("rm-show-none").img("a", 8, 200, 150, "ramp").prep(s -> { s.rmTwo(); s.rmCheck("Show All", true); }).does(s -> s.rmCheck("Show All", false));
        add("rm-labels").img("a", 8, 200, 150, "ramp").prep(s -> { s.rmTwo(); s.rmCheck("Show All", true); }).does(s -> { s.rmCheck("Labels", true); s.rmCheck("Labels", false); });
        add("rm-sort").img("a", 8, 200, 150, "ramp").prep(s -> s.rmTwo()).does(s -> s.rmMore("Sort"));
        add("rm-or").img("a", 8, 200, 150, "ramp").prep(s -> { s.rmTwo(); s.rmSelect(0, 1); }).does(s -> s.rmMore("OR (Combine)"));
        add("rm-and").img("a", 8, 200, 150, "ramp").prep(s -> { s.rmTwoOverlapping(); s.rmSelect(0, 1); }).does(s -> s.rmMore("AND"));
        add("rm-fill").img("a", 8, 200, 150, "ramp").prep(s -> { s.rmTwo(); s.rmSelect(0); }).does(s -> s.rm("Fill"));
        add("close").img("a", 8, 120, 90, "ramp").img("b", 8, 120, 90, "black").current("b").does(s -> s.command("Close"));
        add("cmd-invert").img("a", 8, 120, 90, "ramp").does(s -> s.command("Invert"));
        add("cmd-fill-first").img("a", 8, 120, 90, "ramp").prep(s -> s.roi(10, 10, 40, 30)).does(s -> s.command("Fill"));
        add("cmd-fill-second").img("a", 8, 120, 90, "ramp").prep(s -> s.roi(10, 10, 40, 30)).does(s -> { s.command("Fill"); s.command("Fill"); });
        add("cmd-draw").img("a", 8, 120, 90, "ramp").prep(s -> s.roi(10, 10, 40, 30)).does(s -> s.command("Draw"));
        add("cmd-clear").img("a", 8, 120, 90, "ramp").prep(s -> s.roi(10, 10, 40, 30)).does(s -> s.command("Clear"));
        add("cmd-clear-outside").img("a", 8, 120, 90, "ramp").prep(s -> s.roi(10, 10, 40, 30)).does(s -> { s.command("Clear Outside"); s.command("Clear"); });
        add("cmd-convert-mask").img("a", 8, 120, 90, "squares").does(s -> s.command("Convert to Mask"));
        add("cmd-make-binary-single").img("a", 8, 120, 90, "squares").does(s -> s.command("Make Binary"));
        add("cmd-erode-after-mask").img("a", 8, 120, 90, "squares").does(s -> { s.command("Convert to Mask"); s.command("Erode"); });
        add("cmd-new-image-default").img("a", 8, 120, 90, "ramp").does(s -> s.command("Image...", s.ok(Kit.map())));
        add("cmd-new-image").img("a", 8, 120, 90, "ramp").does(s -> s.command("Image...", s.ok(Kit.map("Name:", "fresh", "Width:", "64", "Height:", "48"))));
        add("cmd-image-calculator").img("a", 8, 120, 90, "ramp").img("b", 8, 120, 90, "squares").current("a")
            .does(s -> s.command("Image Calculator...", s.ok(Kit.map("Image1:", "a", "Operation:", "Subtract", "Image2:", "b", "Create new window", true, "32-bit (float) result", false))));
        add("cmd-image-calculator-32").img("a", 8, 120, 90, "ramp").img("b", 8, 120, 90, "squares").current("a")
            .does(s -> s.command("Image Calculator...", s.ok(Kit.map("Image1:", "b", "Operation:", "Divide", "Image2:", "a", "Create new window", true, "32-bit (float) result", true))));
        add("cmd-rename").img("a", 8, 120, 90, "ramp").does(s -> s.command("Rename...", s.ok(Kit.map("Title:", "my \"new\" name"))));
        add("cmd-set-slice").img("st", 8, 120, 90, 1, 3, 1, "ramp").does(s -> s.command("Set Slice...", s.ok(Kit.map("Slice (1-3):", "2"))));
        add("cmd-duplicate-default").img("a", 8, 120, 90, "ramp").does(s -> s.command("Duplicate...", s.ok(Kit.map())));
        add("cmd-duplicate-title").img("a", 8, 120, 90, "ramp").does(s -> s.command("Duplicate...", s.ok(Kit.map("Title:", "copy"))));
        add("cmd-duplicate-stack").img("st", 8, 120, 90, 1, 3, 1, "ramp").does(s -> s.command("Duplicate...", s.ok(Kit.map())));
        add("cmd-gaussian").img("a", 8, 120, 90, "ramp").does(s -> s.command("Gaussian Blur...", s.ok(Kit.map("Sigma (Radius):", "3"))));
        add("cmd-gaussian-stack-yes").img("st", 8, 120, 90, 1, 3, 1, "ramp").does(s -> s.command("Gaussian Blur...", s.ok(Kit.map("Sigma (Radius):", "2")), s.yes()));
        add("cmd-gaussian-stack-no").img("st", 8, 120, 90, 1, 3, 1, "ramp").does(s -> s.command("Gaussian Blur...", s.ok(Kit.map("Sigma (Radius):", "2")), s.no()));
        add("cmd-invert-stack-yes").img("st", 8, 120, 90, 1, 3, 1, "ramp").does(s -> s.command("Invert", s.yes()));
        add("cmd-cancel").img("a", 8, 120, 90, "ramp").does(s -> s.command("Gaussian Blur...", s.cancel()));
        add("cmd-repeat").img("a", 8, 120, 90, "ramp").does(s -> { s.command("Gaussian Blur...", s.ok(Kit.map("Sigma (Radius):", "1.5"))); s.command("Repeat Command", s.ok(Kit.map())); });
        add("cmd-repeat-invert").img("a", 8, 120, 90, "ramp").does(s -> { s.command("Invert"); s.command("Repeat Command"); });
        add("cmd-measure").img("a", 8, 120, 90, "ramp").does(s -> s.command("Measure"));
        add("cmd-properties-units").img("a", 8, 120, 90, "ramp").does(s -> s.command("Properties...", s.ok(Kit.map("#text:4", "micron", "Pixel width:", "0.5", "Pixel height:", "0.5"))));
        add("cmd-scale-bar").img("a", 8, 200, 150, "ramp").prep(s -> s.calibrate(0.5, "micron")).does(s -> s.command("Scale Bar...", s.ok(Kit.map())));
        add("cmd-8bit-from-16").img("a", 16, 120, 90, "ramp").does(s -> s.command("8-bit"));
        add("cmd-add-value").img("a", 8, 120, 90, "ramp").does(s -> s.command("Add...", s.ok(Kit.map("Value:", "25"))));
        add("cmd-enhance-contrast").img("a", 8, 120, 90, "ramp").does(s -> s.command("Enhance Contrast...", s.ok(Kit.map())));
        add("cmd-non-ascii-title").img("a", 8, 120, 90, "ramp").does(s -> s.command("Rename...", s.ok(Kit.map("Title:", "été µm"))));
        add("cmd-select-all").img("a", 8, 120, 90, "ramp").does(s -> { s.command("Select All"); s.command("Select None"); });
        add("cmd-put-behind").img("a", 8, 120, 90, "ramp").img("b", 8, 120, 90, "black").current("a").does(s -> s.command("Put Behind [tab]"));
        add("channels-mode").img("c3", 8, 64, 48, 3, 1, 1, "ramp").prep(s -> s.channelsOpen()).does(s -> s.chMode("Color"));
        add("channels-active").img("c3", 8, 64, 48, 3, 1, 1, "ramp").prep(s -> s.channelsOpen()).does(s -> s.chActive(1, false));
        add("channels-channel").img("c3", 8, 64, 48, 3, 1, 1, "ramp").prep(s -> { s.channelsOpen(); s.chMode("Color"); }).does(s -> s.chChannel(2))
            .note("in Color mode a channel check box moves to that channel");
        add("file-open").img("a", 8, 120, 90, "ramp").formatOnly(
            "File > Open shows the native picker (or JFileChooser), which cannot be driven; with the path given as macro options OpenDialog "
            + "keeps no title (OpenDialog.java:36-60), so Recorder.recordPath(null, path) records nothing. After a pick, getFileName "
            + "(:209-216) calls Recorder.recordPath(\"Open\", dir+name) -> options open=<path>; Recorder.saveCommand :585-586 then "
            + "recordOpen(strip(options)) :484-498 writes open(\"<path>\"); with the path through fixPath (forward slashes)",
            "open(\"<dir>/in.tif\");\n", List.of(Kit.map("do", "command", "name", "Open...", "file", "in.tif")));
        add("file-saveas-tiff").img("a", 8, 120, 90, "ramp").does(s -> s.file("Tiff...", "out.tif"));
        add("file-saveas-png").img("a", 8, 120, 90, "ramp").does(s -> s.file("PNG...", "out.png"));
        add("file-saveas-jpeg").img("a", 8, 120, 90, "ramp").does(s -> s.file("Jpeg...", "out.jpg"));
        add("channels-grayscale").img("c3", 8, 64, 48, 3, 1, 1, "ramp").prep(s -> s.channelsOpen()).does(s -> s.chMode("Grayscale"));
        add("macro-paused-select").img("a", 8, 120, 90, "ramp").img("b", 8, 120, 90, "black").current("a")
            .does(s -> s.duringWaitForUser(x -> { s.activate("b"); s.tool("rect", "draw", P(10, 10, 50, 40)); s.command("Invert"); }))
            .note("waitForUser holds a macro: the operator selects another image, draws a selection, runs Invert, then presses OK");
    }

    // ------------------------------------------------------------------ fills (documented in the golden)
    static double fill(String fill, int bd, int x, int y, int z, int c) {
        if (fill.equals("black")) return 0;
        if (fill.equals("squares")) {
            double v = (x >= 40 && x < 100 && y >= 30 && y < 80) ? 200 : (x >= 120 && x < 160 && y >= 60 && y < 100) ? 120 : 0;
            return bd == 16 ? v * 100 : bd == 32 ? v * 0.05 : v;
        }
        switch (bd) {
            case 16: return (x * 150 + y * 37 + z * 5000 + c * 900) % 65536;
            case 32: return x * 0.125 - y * 0.03125 + z + c * 0.5;
            default: return (x + 2 * y + z * 30 + c * 60) & 255;
        }
    }

    static ImagePlus build(Img m) {
        ImageStack st = new ImageStack(m.w, m.h);
        for (int t = 0; t < m.t; t++) for (int z = 0; z < m.z; z++) for (int c = 0; c < m.c; c++) {
            ImageProcessor ip = m.bitDepth == 16 ? new ShortProcessor(m.w, m.h) : m.bitDepth == 32 ? new FloatProcessor(m.w, m.h)
                    : m.bitDepth == 24 ? new ColorProcessor(m.w, m.h) : new ByteProcessor(m.w, m.h);
            for (int y = 0; y < m.h; y++) for (int x = 0; x < m.w; x++) {
                double v = fill(m.fill, m.bitDepth == 24 ? 8 : m.bitDepth, x, y, z, c);
                if (m.bitDepth == 32) ip.setf(x, y, (float) v);
                else if (m.bitDepth == 24) ip.set(x, y, 0xff000000 | ((int) v << 16) | (((int) v / 2) << 8) | (255 - (int) v));
                else ip.set(x, y, (int) v);
            }
            st.addSlice("", ip);
        }
        ImagePlus imp = new ImagePlus(m.title, st);
        if (m.c > 1 || m.t > 1) {
            imp.setDimensions(m.c, m.z, m.t);
            if (m.c > 1) imp = new CompositeImage(imp, IJ.COMPOSITE);
            imp.setOpenAsHyperStack(true);
        }
        return imp;
    }

    // ------------------------------------------------------------------ the operator
    static TextArea recText;
    /** Folder of the file cases (forward slashes); written as <dir> in the golden. */
    static String fileDir;

    /** One answer per dialog the step expects, in order: OK with fields set by label, Cancel, Yes, No, or a named button. */
    static final class Answer {
        final String button; final Map<String, Object> fields;
        Answer(String button, Map<String, Object> fields) { this.button = button; this.fields = fields; }
    }

    static final class S {
        final List<Object> actions = new ArrayList<>();
        final List<String> driven = new ArrayList<>();
        final List<Map<String, Object>> unexpected = new ArrayList<>();
        final Deque<Answer> answers = new ArrayDeque<>();
        Window held;
        /** selectImage lines the operator's own activations write; any other one comes from the OS activating a window. */
        final List<String> expectedSelect = new ArrayList<>();

        Answer ok(Map<String, Object> f) { return new Answer("OK", f); }
        Answer cancel() { return new Answer("Cancel", null); }
        Answer yes() { return new Answer("Yes", null); }
        Answer no() { return new Answer("No", null); }

        ImagePlus imp() { return WindowManager.getCurrentImage(); }

        void how(String d) { if (!driven.contains(d)) driven.add(d); }

        // ---- selections
        void tool(String tool, String action, int[][] pts) throws Exception { tool(tool, action, pts, false, true); }
        void toolShift(String tool, String action, int[][] pts) throws Exception { tool(tool, action, pts, true, true); }
        void tool(String tool, String action, int[][] pts, boolean shift, boolean describe) throws Exception {
            if (describe) {
                Map<String, Object> a = Kit.map("do", "tool", "tool", tool, "points", toList(pts), "action", action);
                if (shift) a.put("shift", true);
                actions.add(a);
            }
            how("selection tools: Toolbar.setTool + MouseEvents dispatched on the event thread to the ImageCanvas (pressed / dragged / released)");
            setToolQuiet(toolId(tool));
            ImageCanvas ic = imp().getCanvas();
            int mods = shift ? InputEvent.SHIFT_DOWN_MASK | InputEvent.BUTTON1_DOWN_MASK : InputEvent.BUTTON1_DOWN_MASK;
            if (shift) IJ.setKeyDown(KeyEvent.VK_SHIFT);
            try {
                switch (tool) {
                    case "rect": case "oval": case "line":
                        drag(ic, pts[0], pts[1], mods);
                        break;
                    case "freehand": {
                        mouse(ic, MouseEvent.MOUSE_PRESSED, pts[0][0], pts[0][1], mods, 1);
                        for (int i = 1; i < pts.length; i++) {
                            int[] a = pts[i - 1], b = pts[i];
                            for (int k = 1; k <= 6; k++) mouse(ic, MouseEvent.MOUSE_DRAGGED, a[0] + (b[0] - a[0]) * k / 6, a[1] + (b[1] - a[1]) * k / 6, mods, 0);
                        }
                        mouse(ic, MouseEvent.MOUSE_DRAGGED, pts[0][0], pts[0][1], mods, 0);
                        mouse(ic, MouseEvent.MOUSE_RELEASED, pts[0][0], pts[0][1], mods, 1);
                        break;
                    }
                    case "polygon": case "polyline": case "angle": {
                        if (action.equals("move")) { drag(ic, pts[0], pts[1], mods); break; }
                        // PolygonRoi: a mouse-up away from the previous vertex adds one; a second mouse-up on the same point within
                        // 300 ms (a double click) finishes the selection; the angle tool finishes on its third vertex.
                        for (int i = 0; i < pts.length; i++) {
                            boolean last = i == pts.length - 1;
                            mouse(ic, MouseEvent.MOUSE_MOVED, pts[i][0], pts[i][1], 0, 0);
                            mouse(ic, MouseEvent.MOUSE_PRESSED, pts[i][0], pts[i][1], mods, 1);
                            mouse(ic, MouseEvent.MOUSE_RELEASED, pts[i][0], pts[i][1], mods, 1);
                            if (last && !tool.equals("angle")) {
                                mouse(ic, MouseEvent.MOUSE_PRESSED, pts[i][0], pts[i][1], mods, 2);
                                mouse(ic, MouseEvent.MOUSE_RELEASED, pts[i][0], pts[i][1], mods, 2);
                            }
                            Thread.sleep(last ? 50 : 350);
                        }
                        break;
                    }
                    case "point":
                        mouse(ic, MouseEvent.MOUSE_PRESSED, pts[0][0], pts[0][1], mods, 1);
                        mouse(ic, MouseEvent.MOUSE_RELEASED, pts[0][0], pts[0][1], mods, 1);
                        break;
                    default: throw new IllegalArgumentException(tool);
                }
            } finally { if (shift) IJ.setKeyUp(KeyEvent.VK_SHIFT); }
            settle(250);
        }

        void drag(ImageCanvas ic, int[] a, int[] b, int mods) throws Exception {
            mouse(ic, MouseEvent.MOUSE_PRESSED, a[0], a[1], mods, 1);
            for (int k = 1; k <= 8; k++) mouse(ic, MouseEvent.MOUSE_DRAGGED, a[0] + (b[0] - a[0]) * k / 8, a[1] + (b[1] - a[1]) * k / 8, mods, 0);
            mouse(ic, MouseEvent.MOUSE_RELEASED, b[0], b[1], mods, 1);
        }

        void wand(int x, int y, int tol, int conn) throws Exception {
            actions.add(Kit.map("do", "wand", "x", x, "y", y, "tolerance", tol, "connectivity", conn));
            how("wand: Wand Tool options set before the case, Toolbar.setTool(WAND), a click dispatched to the ImageCanvas");
            setToolQuiet(Toolbar.WAND);
            ImageCanvas ic = imp().getCanvas();
            mouse(ic, MouseEvent.MOUSE_PRESSED, x, y, InputEvent.BUTTON1_DOWN_MASK, 1);
            mouse(ic, MouseEvent.MOUSE_RELEASED, x, y, InputEvent.BUTTON1_DOWN_MASK, 1);
            settle(250);
        }

        void wandOptions(int tol, int conn) throws Exception {
            actions.add(Kit.map("do", "wandOptions", "tolerance", tol, "connectivity", conn));
            quietRun("Wand Tool...", "tolerance=" + tol + " mode=" + conn + "-connected"); }

        void roi(int x, int y, int w, int h) { actions.add(Kit.map("do", "setRoi", "roi", Kit.map("type", "rect", "x", x, "y", y, "width", w, "height", h))); imp().setRoi(new Roi(x, y, w, h)); }
        void saveFixture(String name) { IJ.saveAsTiff(new ImagePlus("in", new ByteProcessor(16, 12)), fileDir + "/" + name); }
        void calibrate(double px, String unit) { actions.add(Kit.map("do", "calibrate", "pixelWidth", px, "pixelHeight", px, "unit", unit)); ij.measure.Calibration c = imp().getCalibration(); c.pixelWidth = c.pixelHeight = px; c.setUnit(unit); }

        // ---- windows
        void activate(String title) throws Exception {
            actions.add(Kit.map("do", "activate", "title", title));
            how("activation: WindowManager.setCurrentWindow(window), what ImageWindow.windowActivated calls when the operator clicks a window");
            ImagePlus i = WindowManager.getImage(title);
            ImageWindow w = i.getWindow();
            boolean records = held == null && WindowManager.getCurrentImage() != i;
            SwingUtilities.invokeAndWait(() -> { w.toFront(); WindowManager.setCurrentWindow(w); });
            if (records) expectedSelect.add("selectImage(\"" + Recorder.fixString(title) + "\");");
            settle(250);
        }

        void window(String title) throws Exception {
            actions.add(Kit.map("do", "window", "title", title));
            how("Window menu: WindowManager.activateWindow(label, item), the handler of the Window menu's rows (package-private, by reflection)");
            Method m = WindowManager.class.getDeclaredMethod("activateWindow", String.class, MenuItem.class);
            m.setAccessible(true);
            CheckboxMenuItem item = new CheckboxMenuItem(title);
            SwingUtilities.invokeAndWait(() -> { try { m.invoke(null, title, item); } catch (Exception e) { throw new RuntimeException(e); } });
            settle(250);
        }

        void chooseTool(String tool) throws Exception {
            actions.add(Kit.map("do", "chooseTool", "tool", tool));
            how("tool choice: Toolbar.setTool(id) on the shown toolbar (the toolbar click path)");
            int id = toolId(tool);
            SwingUtilities.invokeAndWait(() -> Toolbar.getInstance().setTool(id));
            settle(300);
        }

        void lineWidth(int w) throws Exception {
            actions.add(Kit.map("do", "lineWidth", "width", w));
            how("line width: Edit > Options > Line Width... through Executer, its dialog answered");
            answers.add(ok(Kit.map("Line width:", String.valueOf(w))));
            runCommand("Line Width...");
        }

        // ---- commands
        void command(String name, Answer... as) throws Exception {
            Map<String, Object> a = Kit.map("do", "command", "name", name);
            Map<String, Object> values = new LinkedHashMap<>();
            String stack = null; boolean cancel = false;
            for (Answer x : as) {
                if (x.fields != null) values.putAll(x.fields);
                if (x.button.equals("Yes")) stack = "all";
                if (x.button.equals("No")) stack = "current";
                if (x.button.equals("Cancel")) cancel = true;
            }
            if (!values.isEmpty()) a.put("values", values);
            if (stack != null) a.put("stack", stack);
            if (cancel) a.put("cancel", true);
            actions.add(a);
            how("commands: Executer (IJ.doCommand, the menu path) with the Recorder on; dialogs answered by setting fields (by label) and pressing their buttons");
            answers.addAll(Arrays.asList(as));
            runCommand(name);
        }

        void runCommand(String name) throws Exception {
            Thread t = new Thread(() -> Kit.doCommandAndWait(name), "operator");
            t.start();
            long t0 = System.currentTimeMillis();
            while (t.isAlive() && System.currentTimeMillis() - t0 < 30000) { pump(); t.join(20); }
            settle(300);
        }

        /** A command ImageJ runs before the case starts (its lines are cleared with the rest of the setup). */
        void quiet(String name) throws Exception { actions.add(Kit.map("do", "command", "name", name)); runCommand(name); }
        void quietRun(String name, String options) throws Exception { IJ.run(name, options); }

        /**
         * File > Open / Save As. The native file picker cannot be driven, and ImageJ reads a path from macro options only on a "Run$_"
         * thread, which the Recorder skips unless `recordInMacros` is on: the command runs through Executer on such a thread with
         * `Recorder.recordInMacros = true` (the mode DialogKeys records `recorded` in) and options naming the file.
         */
        void file(String command, String fileName) throws Exception {
            String path = fileDir + "/" + fileName;
            actions.add(Kit.map("do", "command", "name", command, "file", fileName));
            how("files: Executer on a Run$_ thread with Recorder.recordInMacros on and options naming the file (in place of the file picker)");
            Thread t = new Thread(() -> {
                Recorder.recordInMacros = true;
                // File > Open picks JFileChooser (no options) unless IJ.macroRunning(): raised for the call only
                Field running = null;
                try {
                    running = IJ.class.getDeclaredField("macroRunning"); running.setAccessible(true); running.setBoolean(null, true);
                    Macro.setOptions(Thread.currentThread(), "open=[" + path + "] path=[" + path + "] save=[" + path + "]");
                    new Executer(command).run();
                } catch (Exception e) {
                    throw new RuntimeException(e);
                } finally {
                    Macro.setOptions(Thread.currentThread(), null);
                    Recorder.recordInMacros = false;
                    try { if (running != null) running.setBoolean(null, false); } catch (Exception e) { /* left as found */ }
                }
            }, "Run$_operator-file");
            t.start();
            long t0 = System.currentTimeMillis();
            while (t.isAlive() && System.currentTimeMillis() - t0 < 30000) { pump(); t.join(20); }
            settle(400);
        }

        // ---- Threshold
        Window thr() { return frame("Threshold"); }
        void thresholdOpen() throws Exception {
            actions.add(Kit.map("do", "threshold", "op", "open"));
            how("Threshold window: Image > Adjust > Threshold... through Executer; its buttons / choices / check boxes by dispatched AWT events");
            runCommand("Threshold...");
            waitFrame("Threshold");
            settle(1200);
        }
        void thrMethod(String m) throws Exception {
            actions.add(Kit.map("do", "threshold", "op", "method", "method", m));
            choose(thr(), 0, m); settle(900);
        }
        void thrMode(String m) throws Exception {
            actions.add(Kit.map("do", "threshold", "op", "mode", "mode", m));
            choose(thr(), 1, m); settle(900);
        }
        void thrDark(boolean on) throws Exception {
            actions.add(Kit.map("do", "threshold", "op", "dark", "dark", on));
            check(thr(), "Dark background", on); settle(900);
        }
        void thrSet(String lo, String hi) throws Exception {
            actions.add(Kit.map("do", "threshold", "op", "set", "lower", lo, "upper", hi));
            answers.add(ok(Kit.map("Lower threshold level:", lo, "Upper threshold level:", hi)));
            press(thr(), "Set"); settle(1500);
        }
        void thrButton(String b) throws Exception {
            actions.add(Kit.map("do", "threshold", "op", b.toLowerCase()));
            press(thr(), b); settle(1500);
        }
        void thrButtonAnswer(String b, String answer) throws Exception {
            actions.add(Kit.map("do", "threshold", "op", b.toLowerCase(), "answer", answer));
            answers.add(new Answer(answer, null));
            press(thr(), b); settle(1500);
        }

        // ---- B&C
        Window bc() { return frame("B&C"); }
        void bcOpen() throws Exception {
            actions.add(Kit.map("do", "bc", "op", "open"));
            how("B&C window: Image > Adjust > Brightness/Contrast... through Executer; its buttons by dispatched ActionEvents, the Set dialog answered");
            runCommand("Brightness/Contrast...");
            waitFrame("B&C");
            settle(800);
        }
        void bcSet(String min, String max) throws Exception {
            actions.add(Kit.map("do", "bc", "op", "set", "min", min, "max", max));
            answers.add(ok(Kit.map("Minimum displayed value:", min, "Maximum displayed value:", max)));
            press(bc(), "Set"); settle(1200);
        }
        void bcButton(String b) throws Exception {
            actions.add(Kit.map("do", "bc", "op", b.toLowerCase()));
            press(bc(), b); settle(1200);
        }
        /** Apply, then OK in ImageJ's "Apply Lookup Table?" confirmation (8-bit). */
        void bcApply() throws Exception {
            actions.add(Kit.map("do", "bc", "op", "apply", "confirm", "OK"));
            answers.add(ok(Kit.map()));
            press(bc(), "Apply"); settle(1200);
        }

        // ---- ROI Manager
        RoiManager rmgr() { return RoiManager.getInstance(); }
        void rmOpen() throws Exception { actions.add(Kit.map("do", "openWindow", "title", "ROI Manager")); runCommand("ROI Manager..."); waitFrame("ROI Manager"); settle(300); }
        void rmTwo() throws Exception {
            rmOpen();
            actions.add(Kit.map("do", "rmAddRois", "rois", List.of(Kit.map("type", "rect", "x", 20, "y", 30, "width", 70, "height", 50),
                    Kit.map("type", "oval", "x", 110, "y", 60, "width", 50, "height", 40))));
            imp().setRoi(new Roi(20, 30, 70, 50)); rmgr().addRoi(imp().getRoi());
            imp().setRoi(new OvalRoi(110, 60, 50, 40)); rmgr().addRoi(imp().getRoi());
            imp().deleteRoi();
            settle(200);
        }
        void rmTwoOverlapping() throws Exception {
            rmOpen();
            actions.add(Kit.map("do", "rmAddRois", "rois", List.of(Kit.map("type", "rect", "x", 20, "y", 30, "width", 70, "height", 50),
                    Kit.map("type", "rect", "x", 60, "y", 50, "width", 70, "height", 50))));
            imp().setRoi(new Roi(20, 30, 70, 50)); rmgr().addRoi(imp().getRoi());
            imp().setRoi(new Roi(60, 50, 70, 50)); rmgr().addRoi(imp().getRoi());
            imp().deleteRoi();
            settle(200);
        }
        void rm(String button, Answer... as) throws Exception {
            Map<String, Object> a = Kit.map("do", "rm", "op", button.replace(" [t]", ""));
            if (as.length > 0) a.put("confirm", as[0].button);
            actions.add(a);
            answers.addAll(Arrays.asList(as));
            how("ROI Manager: its buttons by dispatched ActionEvents (RoiManager.actionPerformed), list rows by JList selection, check boxes by ItemEvents");
            RoiManager r = rmgr();
            edtWhilePumping(() -> r.actionPerformed(new ActionEvent(r, ActionEvent.ACTION_PERFORMED, button)));
            settle(800);
        }
        void rmMore(String item) throws Exception {
            actions.add(Kit.map("do", "rm", "op", item));
            how("ROI Manager More>> menu: RoiManager.actionPerformed with the menu item's label (the listener of the popup menu)");
            RoiManager r = rmgr();
            edtWhilePumping(() -> r.actionPerformed(new ActionEvent(r, ActionEvent.ACTION_PERFORMED, item)));
            settle(800);
        }
        void rmSelect(int... idx) throws Exception {
            actions.add(Kit.map("do", "rm", "op", "Select", "indices", toList(idx)));
            how("ROI Manager: its buttons by dispatched ActionEvents (RoiManager.actionPerformed), list rows by JList selection, check boxes by ItemEvents");
            RoiManager r = rmgr();
            JList<?> list = (JList<?>) Kit2.field(r, "list");
            SwingUtilities.invokeAndWait(() -> { list.setSelectedIndex(idx[0]); for (int i = 1; i < idx.length; i++) list.addSelectionInterval(idx[i], idx[i]); });
            settle(500);
        }
        void rmRename(String name) throws Exception {
            actions.add(Kit.map("do", "rm", "op", "Rename", "name", name));
            how("ROI Manager: its buttons by dispatched ActionEvents (RoiManager.actionPerformed), list rows by JList selection, check boxes by ItemEvents");
            answers.add(ok(Kit.map("Rename As:", name)));
            RoiManager r = rmgr();
            Thread t = new Thread(() -> r.actionPerformed(new ActionEvent(r, ActionEvent.ACTION_PERFORMED, "Rename...")), "rm-rename");
            t.start();
            long t0 = System.currentTimeMillis();
            while (t.isAlive() && System.currentTimeMillis() - t0 < 20000) { pump(); t.join(20); }
            settle(500);
        }
        void rmCheck(String label, boolean on) throws Exception {
            actions.add(Kit.map("do", "rm", "op", label.equals("Labels") ? (on ? "Show All with labels" : "Show All without labels") : (on ? "Show All" : "Show None")));
            how("ROI Manager: its buttons by dispatched ActionEvents (RoiManager.actionPerformed), list rows by JList selection, check boxes by ItemEvents");
            check(frame("ROI Manager"), label, on);
            settle(500);
        }

        // ---- Channels
        void channelsOpen() throws Exception { actions.add(Kit.map("do", "openWindow", "title", "Channels")); runCommand("Channels Tool..."); waitFrame("Channels"); settle(400); }
        void chMode(String mode) throws Exception {
            actions.add(Kit.map("do", "channels", "op", "mode", "mode", mode.toLowerCase()));
            how("Channels tool: its mode Choice and channel check boxes by dispatched ItemEvents");
            choose(frame("Channels"), 0, mode); settle(600);
        }
        void chChannel(int index) throws Exception {
            actions.add(Kit.map("do", "channels", "op", "channel", "channel", index + 1));
            how("Channels tool: its mode Choice and channel check boxes by dispatched ItemEvents");
            Window f = frame("Channels");
            List<Checkbox> boxes = new ArrayList<>();
            collect(f, Checkbox.class, boxes);
            fireCheck(f, boxes.get(index), true); settle(600);
        }
        void chActive(int index, boolean on) throws Exception {
            actions.add(Kit.map("do", "channels", "op", "active", "channel", index + 1, "on", on));
            how("Channels tool: its mode Choice and channel check boxes by dispatched ItemEvents");
            Window f = frame("Channels");
            List<Checkbox> boxes = new ArrayList<>();
            collect(f, Checkbox.class, boxes);
            Checkbox cb = boxes.get(index);
            fireCheck(f, cb, on); settle(600);
        }

        // ---- a macro waiting for the operator
        void duringWaitForUser(Body during) throws Exception {
            actions.add(Kit.map("do", "macroWait", "macro", "waitForUser(\"Waiting\");"));
            how("a macro (IJ.runMacro in its own thread) blocked in waitForUser; the operator acts, then presses OK in the WaitForUser window");
            Thread t = new Thread(() -> IJ.runMacro("waitForUser(\"Waiting\");"), "Run$_operator-test");
            t.start();
            long t0 = System.currentTimeMillis();
            while (held == null && System.currentTimeMillis() - t0 < 10000) {
                for (Window w : Window.getWindows()) if (w instanceof WaitForUserDialog && w.isVisible()) held = w;
                Thread.sleep(30);
            }
            Kit.seen.add(held);
            Thread.sleep(300);
            during.run(this);
            Window h = held; held = null;
            Kit.press(h, "OK");
            t.join(10000);
            settle(300);
        }

        // ---- dialog pump
        /** Answers the dialogs that appeared: the next queued answer for each, else ImageJ's OK / Yes and the dialog is listed as unexpected. */
        void pump() throws Exception {
            Window w = Kit.newDialog();
            if (w == null) return;
            Kit.seen.add(w);
            if (w instanceof ij.plugin.frame.PlugInDialog || w instanceof WaitForUserDialog) return;
            Thread.sleep(150);
            String title = ((Dialog) w).getTitle();
            Answer a = answers.poll();
            if (a == null) {
                unexpected.add(Kit.map("title", title, "text", Kit.textOf(w)));
                if (!Kit.press(w, "OK") && !Kit.press(w, "Yes")) SwingUtilities.invokeAndWait(w::dispose);
                return;
            }
            if (a.fields != null && w instanceof GenericDialog) {
                Map<String, String> keys = setFields((GenericDialog) w, a.fields);
                if (!keys.isEmpty() && !actions.isEmpty()) {
                    @SuppressWarnings("unchecked") Map<String, Object> last = (Map<String, Object>) actions.get(actions.size() - 1);
                    @SuppressWarnings("unchecked") Map<String, Object> ks = (Map<String, Object>) last.computeIfAbsent("keys", x -> new LinkedHashMap<String, Object>());
                    ks.putAll(keys);
                }
            }
            Thread.sleep(80);
            if (!Kit.press(w, a.button)) {
                unexpected.add(Kit.map("title", title, "text", Kit.textOf(w), "missingButton", a.button));
                SwingUtilities.invokeAndWait(w::dispose);
            }
        }

        /** Runs `r` on the event thread from a helper thread while this one answers dialogs (a listener may open a modal box). */
        void edtWhilePumping(Runnable r) throws Exception {
            Thread t = new Thread(() -> { try { SwingUtilities.invokeAndWait(r); } catch (Exception e) { throw new RuntimeException(e); } }, "edt-call");
            t.start();
            long t0 = System.currentTimeMillis();
            while (t.isAlive() && System.currentTimeMillis() - t0 < 20000) { pump(); t.join(20); }
        }

        void settle(long ms) throws Exception {
            long t0 = System.currentTimeMillis();
            while (System.currentTimeMillis() - t0 < ms) { pump(); Thread.sleep(25); }
            SwingUtilities.invokeAndWait(() -> { });
        }

        Window frame(String title) {
            for (Window w : Window.getWindows()) if (w.isVisible() && title.equals(titleOf(w))) return w;
            throw new IllegalStateException("no window " + title);
        }
        void waitFrame(String title) throws Exception {
            long t0 = System.currentTimeMillis();
            while (System.currentTimeMillis() - t0 < 10000) {
                for (Window w : Window.getWindows()) if (w.isVisible() && title.equals(titleOf(w))) { Kit.seen.add(w); return; }
                pump(); Thread.sleep(30);
            }
            throw new IllegalStateException("window did not open: " + title);
        }
    }

    // ------------------------------------------------------------------ AWT helpers
    static String titleOf(Window w) { return w instanceof Frame ? ((Frame) w).getTitle() : w instanceof Dialog ? ((Dialog) w).getTitle() : null; }

    static void mouse(Component c, int id, int x, int y, int mods, int clicks) throws Exception {
        long when = System.currentTimeMillis();
        int button = id == MouseEvent.MOUSE_MOVED || id == MouseEvent.MOUSE_DRAGGED ? MouseEvent.NOBUTTON : MouseEvent.BUTTON1;
        int m = id == MouseEvent.MOUSE_MOVED ? 0 : id == MouseEvent.MOUSE_RELEASED ? mods & ~InputEvent.BUTTON1_DOWN_MASK : mods;
        MouseEvent e = new MouseEvent(c, id, when, m, x, y, clicks, false, button);
        SwingUtilities.invokeAndWait(() -> c.dispatchEvent(e));
        Thread.sleep(id == MouseEvent.MOUSE_DRAGGED || id == MouseEvent.MOUSE_MOVED ? 8 : 40);
    }

    static int toolId(String tool) {
        switch (tool) {
            case "rect": return Toolbar.RECTANGLE;
            case "oval": return Toolbar.OVAL;
            case "polygon": return Toolbar.POLYGON;
            case "freehand": return Toolbar.FREEROI;
            case "line": return Toolbar.LINE;
            case "polyline": return Toolbar.POLYLINE;
            case "angle": return Toolbar.ANGLE;
            case "point": return Toolbar.POINT;
            case "wand": return Toolbar.WAND;
            case "hand": return Toolbar.HAND;
            case "zoom": return Toolbar.MAGNIFIER;
            default: throw new IllegalArgumentException(tool);
        }
    }

    /** Toolbar.setTool for a selection action; its own `//setTool` line is not part of what the case is about, so it is erased. */
    static void setToolQuiet(int id) throws Exception {
        if (Toolbar.getToolId() == id) return;
        int before = recText.getText().length();
        SwingUtilities.invokeAndWait(() -> Toolbar.getInstance().setTool(id));
        Thread.sleep(150);
        String t = recText.getText();
        if (t.length() > before && t.substring(before).startsWith("//setTool(")) {
            int end = t.indexOf('\n', before);
            String rest = end < 0 ? "" : t.substring(end + 1);
            recText.setText(t.substring(0, before) + rest);
        }
    }

    static void press(Container root, String label) throws Exception {
        Component b = find(root, label);
        if (b == null) throw new IllegalStateException("no button " + label);
        SwingUtilities.invokeAndWait(() -> {
            ActionEvent e = new ActionEvent(b, ActionEvent.ACTION_PERFORMED, ((Button) b).getLabel());
            for (ActionListener l : ((Button) b).getActionListeners()) l.actionPerformed(e);
        });
    }

    static Component find(Container c, String label) {
        for (Component k : c.getComponents()) {
            if (k instanceof Button && ((Button) k).getLabel().trim().equals(label)) return k;
            if (k instanceof Container) { Component r = find((Container) k, label); if (r != null) return r; }
        }
        return null;
    }

    static <T> void collect(Container c, Class<T> cls, List<T> out) {
        for (Component k : c.getComponents()) {
            if (cls.isInstance(k)) out.add(cls.cast(k));
            if (k instanceof Container) collect((Container) k, cls, out);
        }
    }

    static void choose(Container root, int index, String item) throws Exception {
        List<Choice> cs = new ArrayList<>();
        collect(root, Choice.class, cs);
        Choice ch = cs.get(index);
        SwingUtilities.invokeAndWait(() -> {
            ch.select(item);
            ItemEvent e = new ItemEvent(ch, ItemEvent.ITEM_STATE_CHANGED, item, ItemEvent.SELECTED);
            for (ItemListener l : ch.getItemListeners()) l.itemStateChanged(e);
        });
    }

    static void check(Container root, String label, boolean on) throws Exception {
        List<Checkbox> cs = new ArrayList<>();
        collect(root, Checkbox.class, cs);
        for (Checkbox cb : cs) if (cb.getLabel().trim().equals(label)) { fireCheck(root, cb, on); return; }
        throw new IllegalStateException("no check box " + label);
    }

    static void fireCheck(Container root, Checkbox cb, boolean on) throws Exception {
        SwingUtilities.invokeAndWait(() -> {
            cb.setState(on);
            ItemEvent e = new ItemEvent(cb, ItemEvent.ITEM_STATE_CHANGED, cb, on ? ItemEvent.SELECTED : ItemEvent.DESELECTED);
            for (ItemListener l : cb.getItemListeners()) l.itemStateChanged(e);
        });
    }

    /**
     * Sets GenericDialog fields by the label shown before them (or the check box's own label); returns, per label set, the macro key
     * the jar itself derives (Recorder.trimKey of the label GenericDialog saved for that component while recording).
     */
    static Map<String, String> setFields(GenericDialog gd, Map<String, Object> fields) throws Exception {
        Map<String, Object> left = new LinkedHashMap<>(fields);
        Map<String, Component> set = new LinkedHashMap<>();
        SwingUtilities.invokeAndWait(() -> {
            // "#text:<n>": the n-th text field of the dialog, for a field whose label is empty (a unit field beside a number)
            List<TextField> tfs = new ArrayList<>();
            collect(gd, TextField.class, tfs);
            for (Iterator<Map.Entry<String, Object>> it = left.entrySet().iterator(); it.hasNext(); ) {
                Map.Entry<String, Object> e = it.next();
                if (e.getKey().startsWith("#text:")) {
                    TextField tf = tfs.get(Integer.parseInt(e.getKey().substring(6)));
                    tf.setText(String.valueOf(e.getValue()));
                    set.put(e.getKey(), tf);
                    it.remove();
                }
            }
            walkSet(gd, left, new String[1], set);
        });
        if (!left.isEmpty()) throw new IllegalStateException("fields not found in '" + gd.getTitle() + "': " + left.keySet());
        Map<String, String> keys = new LinkedHashMap<>();
        Object table = Kit2.fieldOrNull(gd, "labels");
        for (Map.Entry<String, Component> e : set.entrySet()) {
            Object saved = table instanceof Map ? ((Map<?, ?>) table).get(e.getValue()) : null;
            keys.put(e.getKey(), saved == null ? null : trimKey(String.valueOf(saved)));
        }
        return keys;
    }

    /** Recorder.trimKey (1.54p): the label up to its first space, then up to its first colon, lower case. */
    static String trimKey(String key) {
        int i = key.indexOf(' ');
        if (i > -1) key = key.substring(0, i);
        i = key.indexOf(':');
        if (i > -1) key = key.substring(0, i);
        return key.toLowerCase(Locale.US);
    }

    static void walkSet(Container c, Map<String, Object> left, String[] lastLabel, Map<String, Component> set) {
        for (Component k : c.getComponents()) {
            if (k instanceof Label) { lastLabel[0] = ((Label) k).getText().trim(); continue; }
            if (k instanceof Checkbox) {
                String l = ((Checkbox) k).getLabel().trim();
                if (left.containsKey(l)) {
                    Checkbox cb = (Checkbox) k; boolean v = Boolean.TRUE.equals(left.remove(l));
                    cb.setState(v);
                    ItemEvent e = new ItemEvent(cb, ItemEvent.ITEM_STATE_CHANGED, cb, v ? ItemEvent.SELECTED : ItemEvent.DESELECTED);
                    for (ItemListener li : cb.getItemListeners()) li.itemStateChanged(e);
                    set.put(l, cb);
                }
                continue;
            }
            if (k instanceof TextField && lastLabel[0] != null && left.containsKey(lastLabel[0])) {
                ((TextField) k).setText(String.valueOf(left.remove(lastLabel[0])));
                set.put(lastLabel[0], k);
                lastLabel[0] = null;
                continue;
            }
            if (k instanceof Choice && lastLabel[0] != null && left.containsKey(lastLabel[0])) {
                Choice ch = (Choice) k; String v = String.valueOf(left.remove(lastLabel[0]));
                ch.select(v);
                ItemEvent e = new ItemEvent(ch, ItemEvent.ITEM_STATE_CHANGED, v, ItemEvent.SELECTED);
                for (ItemListener li : ch.getItemListeners()) li.itemStateChanged(e);
                set.put(lastLabel[0], ch);
                lastLabel[0] = null;
                continue;
            }
            if (k instanceof Container) walkSet((Container) k, left, lastLabel, set);
        }
    }

    static List<Object> toList(int[][] pts) { List<Object> l = new ArrayList<>(); for (int[] p : pts) l.add(Arrays.asList(p[0], p[1])); return l; }
    static List<Object> toList(int[] a) { List<Object> l = new ArrayList<>(); for (int v : a) l.add(v); return l; }

    // ------------------------------------------------------------------ state between cases
    static void resetRecorderFlags() throws Exception {
        for (String f : new String[] { "fgColorSet", "bgColorSet", "bbSet" }) {
            Field fl = Recorder.class.getDeclaredField(f); fl.setAccessible(true); fl.setBoolean(null, false);
        }
        Field cn = Recorder.class.getDeclaredField("commandName"); cn.setAccessible(true); cn.set(null, null);
        Field co = Recorder.class.getDeclaredField("commandOptions"); co.setAccessible(true); co.set(null, null);
    }

    static void closeAll() throws Exception {
        int[] ids = WindowManager.getIDList();
        if (ids != null) for (int id : ids) { ImagePlus i = WindowManager.getImage(id); if (i != null) { i.changes = false; i.close(); } }
        for (Window w : Window.getWindows()) {
            if (!w.isVisible() || w == Recorder.getInstance() || w == IJ.getInstance()) continue;
            if (w instanceof Frame || w instanceof Dialog) {
                String t = w instanceof Frame ? ((Frame) w).getTitle() : ((Dialog) w).getTitle();
                if ("Log".equals(t)) continue;
                SwingUtilities.invokeAndWait(() -> { if (w instanceof ij.plugin.frame.PlugInFrame) ((ij.plugin.frame.PlugInFrame) w).close(); else if (w instanceof ij.plugin.frame.PlugInDialog) ((ij.plugin.frame.PlugInDialog) w).close(); else if (w instanceof ij.text.TextWindow) ((ij.text.TextWindow) w).close(false); else w.dispose(); });
            }
        }
        ResultsTable rt = ResultsTable.getResultsTable();
        if (rt != null) rt.reset();
        Thread.sleep(200);
        // tool windows remember their settings in Prefs and statics when closed: every case starts from ImageJ's defaults
        if (prefsAtStart != null) {
            Properties p = prefsTable();
            p.clear();
            p.putAll(prefsAtStart);
        }
        setStatic(ij.plugin.frame.ThresholdAdjuster.class, "method", "Default");
        setStatic(ij.plugin.frame.ThresholdAdjuster.class, "mode", 0);
    }

    static Properties prefsAtStart;
    static Properties prefsTable() throws Exception { Field f = Prefs.class.getDeclaredField("ijPrefs"); f.setAccessible(true); return (Properties) f.get(null); }
    static void setStatic(Class<?> c, String name, Object v) throws Exception { Field f = c.getDeclaredField(name); f.setAccessible(true); f.set(null, v); }

    public static void main(String[] a) throws Exception {
        Locale.setDefault(Locale.ROOT);
        Path out = Paths.get(a[0]).toAbsolutePath();
        Path dir = out.resolve("recorder");
        Files.createDirectories(dir);
        String only = System.getProperty("ijm.only", "");
        new ImageJ();
        Thread.sleep(800);
        new Recorder(false);
        Field f = Recorder.class.getDeclaredField("textArea"); f.setAccessible(true);
        recText = (TextArea) f.get(null);
        Kit.seen.addAll(Arrays.asList(Window.getWindows()));
        Path fdir = Files.createTempDirectory("ijm-rec");
        fileDir = fdir.toString().replace('\\', '/');
        prefsAtStart = new Properties();
        prefsAtStart.putAll(prefsTable());
        Map<String, Object> cases = new LinkedHashMap<>();
        for (Case k : CASES) {
            if (!only.isEmpty() && !k.id.contains(only)) continue;
            closeAll();
            Prefs.blackBackground = false;
            Toolbar.setForegroundColor(Color.white);
            Toolbar.setBackgroundColor(Color.black);
            Roi.setColor(Color.yellow);
            Line.setWidth(1);
            SwingUtilities.invokeAndWait(() -> Toolbar.getInstance().setTool(Toolbar.RECTANGLE));
            List<ImagePlus> imps = new ArrayList<>();
            for (Img m : k.images) { ImagePlus imp = build(m); imp.show(); imps.add(imp); }
            Thread.sleep(500);
            S s = new S();
            ImagePlus cur = WindowManager.getImage(k.current);
            ImageWindow cw = cur.getWindow();
            SwingUtilities.invokeAndWait(() -> { cw.toFront(); WindowManager.setCurrentWindow(cw); });
            s.settle(300);
            for (Body p : k.prep) p.run(s);
            s.settle(200);
            List<Object> prepDone = new ArrayList<>(s.actions);
            s.actions.clear(); s.driven.clear(); s.unexpected.clear();
            resetRecorderFlags();
            recText.setText("");
            Throwable failed = null;
            if (k.formatWhy != null) { s.actions.addAll(k.formatActions); recText.setText(k.formatText); s.how("not driven (format-only)"); }
            else try { k.body.run(s); } catch (Throwable t) { failed = t; }
            s.settle(500);
            keyValues(s.actions);
            String raw = recText.getText().replace(fileDir, "<dir>").replace(fileDir.replace('/', '\\'), "<dir>");
            List<Object> stripped = new ArrayList<>();
            String text = stripAsyncActivations(raw, s.expectedSelect, stripped);
            Files.write(dir.resolve(k.id + ".ijm"), text.getBytes(java.nio.charset.StandardCharsets.UTF_8));
            Map<String, Object> setup = Kit.map("images", new ArrayList<Object>(), "current", k.current,
                    "settings", Kit.map("blackBackground", false, "foreground", Arrays.asList(255, 255, 255), "background", Arrays.asList(0, 0, 0), "selectionColor", "yellow", "lineWidth", 1));
            for (Img m : k.images) ((List<Object>) setup.get("images")).add(m.json());
            if (!prepDone.isEmpty()) setup.put("prep", prepDone);
            Map<String, Object> e = Kit.map("source", k.formatWhy != null ? "Recorder.java" : "jar", "setup", setup, "actions", s.actions, "text", text, "lines", lines(text),
                    "driven", String.join("; ", s.driven));
            if (k.note != null) e.put("note", k.note);
            if (k.formatWhy != null) e.put("why", k.formatWhy);
            if (!stripped.isEmpty()) e.put("asyncActivationStripped", stripped);
            if (!s.unexpected.isEmpty()) e.put("unexpectedDialogs", s.unexpected);
            if (failed != null) e.put("driverError", String.valueOf(failed));
            cases.put(k.id, e);
            System.out.println(k.id + ": " + text.replace("\n", " | ") + (failed != null ? "  !! " + failed : "") + (s.unexpected.isEmpty() ? "" : "  unexpected=" + s.unexpected));
        }
        closeAll();
        Map<String, Object> doc = Kit.map("imagej", IJ.getVersion(), "generator", "tools/ij_fixtures/macro/RecorderGolden.java",
                "note", "text = the Recorder's whole text after the actions (the setup's own lines cleared first); lines = text split at newlines "
                        + "(a line ImageJ writes without its newline joins the next one, as in the text). Recorder state is fresh for each case "
                        + "(no foreground / background / black-background line written yet). setup.images fills: see fills; actions use the "
                        + "Studio tool ids and ImageJ command names; values are keyed by the dialog's label (ImageJ's own text); "
                        + "<dir> = the folder of the file cases (forward slashes, Recorder.fixPath), a granted folder's vpath in the Studio",
                "fills", Kit.map(
                        "ramp", "8-bit (x + 2*y + 30*z + 60*c) & 255; 16-bit (150*x + 37*y + 5000*z + 900*c) % 65536; 32-bit 0.125*x - 0.03125*y + z + 0.5*c",
                        "squares", "0, except 200 in x 40..99 / y 30..79 and 120 in x 120..159 / y 60..99 (16-bit x100, 32-bit x0.05)",
                        "black", "0"),
                "cases", cases);
        Kit.writeJson(out.resolve("recorder-golden.json"), doc);
        BatchGolden.deleteTree(fdir);
        System.exit(0);
    }

    /** A command action's `values` (by shown label) become { ImageJ key: value }, the labels kept in `fieldLabels`. */
    @SuppressWarnings("unchecked")
    static void keyValues(List<Object> actions) {
        for (Object o : actions) {
            Map<String, Object> a = (Map<String, Object>) o;
            Map<String, Object> keys = (Map<String, Object>) a.remove("keys");
            Map<String, Object> vals = (Map<String, Object>) a.get("values");
            if (vals == null || vals.isEmpty()) continue;
            Map<String, Object> byKey = new LinkedHashMap<>();
            for (Map.Entry<String, Object> e : vals.entrySet()) {
                Object k = keys == null ? null : keys.get(e.getKey());
                byKey.put(k == null ? "?" + e.getKey() : String.valueOf(k), e.getValue());
            }
            a.put("fieldLabels", vals);
            a.put("values", byKey);
        }
    }

    /**
     * Removes the selectImage lines the operator did not cause: when a command shows a new window or closes the active one, the OS
     * activates a window and ImageJ records selectImage for it some time later, or not at all when the JVM has no focus (EXTRAS.md X5,
     * P9: timing-dependent). They are listed in `asyncActivationStripped` (as seen in this run, so informative only).
     */
    static String stripAsyncActivations(String text, List<String> expected, List<Object> stripped) {
        List<String> want = new ArrayList<>(expected);
        StringBuilder b = new StringBuilder();
        int at = 0;
        while (at < text.length()) {
            int nl = text.indexOf('\n', at);
            String line = nl < 0 ? text.substring(at) : text.substring(at, nl + 1);
            at = nl < 0 ? text.length() : nl + 1;
            String bare = line.endsWith("\n") ? line.substring(0, line.length() - 1) : line;
            if (bare.startsWith("selectImage(") && bare.endsWith(");")) {
                if (!want.isEmpty() && want.get(0).equals(bare)) { want.remove(0); b.append(line); }
                else stripped.add(bare);
                continue;
            }
            b.append(line);
        }
        return b.toString();
    }

    static List<Object> lines(String text) {
        List<Object> l = new ArrayList<>();
        if (text.isEmpty()) return l;
        String t = text.endsWith("\n") ? text.substring(0, text.length() - 1) : text;
        l.addAll(Arrays.asList(t.split("\n", -1)));
        return l;
    }
}

/** Reflection read of a field (RecorderGolden only). */
final class Kit2 {
    static Object field(Object o, String name) throws Exception {
        Class<?> c = o.getClass();
        while (c != null) {
            try { Field f = c.getDeclaredField(name); f.setAccessible(true); return f.get(o); } catch (NoSuchFieldException e) { c = c.getSuperclass(); }
        }
        throw new NoSuchFieldException(name);
    }
    static Object fieldOrNull(Object o, String name) { try { return field(o, name); } catch (Exception e) { return null; } }
}
