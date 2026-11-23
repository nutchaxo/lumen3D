import ij.*;
import ij.gui.*;
import ij.plugin.frame.Recorder;
import ij.process.*;
import java.awt.*;
import java.awt.event.*;
import java.lang.reflect.Field;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.util.*;
import java.util.List;
import javax.swing.SwingUtilities;

/**
 * Records, for every ImageJ (or Fiji) command, the GenericDialog it opens: components in order, defaults, choice items,
 * radio groups, sliders, and the macro KEY of each field as the jar itself computes it (GenericDialog.saveLabel, which only
 * runs when Recorder.record is on, then read back through reflection on the private `labels` table). The Recorder's own
 * text of the run (default option string) is stored beside as a cross-check.
 * Public AWT / ImageJ API plus that one reflective read: no plugin code of Fiji is read, no Fiji class is copied.
 *
 * Usage (see run_dialogkeys.sh):  DialogKeys <out.json> [--fiji] [--names a;b;c | --names-file f] [--only a;b]
 * Local only, never shipped, never in CI. Needs a desktop session (java.awt dialogs).
 */
public class DialogKeys {
    // ------------------------------------------------------------------ inputs
    static int W = 96, H = 64;

    static class Input {
        final String id; final int bitDepth, c, z, t; final String roi; final boolean binary, composite; int size;
        Input(String id, int bitDepth, int c, int z, int t, String roi, boolean binary, boolean composite) {
            this.id = id; this.bitDepth = bitDepth; this.c = c; this.z = z; this.t = t; this.roi = roi; this.binary = binary; this.composite = composite;
        }
    }

    /** Tried in this order; the first that makes a command show a dialog is the one recorded. */
    static final Input[] INPUTS = {
        new Input("8bit-rect", 8, 1, 1, 1, "rect", false, false),
        new Input("16bit", 16, 1, 1, 1, null, false, false),
        new Input("32bit", 32, 1, 1, 1, null, false, false),
        new Input("binary", 8, 1, 1, 1, null, true, false),
        new Input("composite2", 8, 2, 1, 1, null, false, true),
        new Input("8bit-line", 8, 1, 1, 1, "line", false, false),
        new Input("8bit-point", 8, 1, 1, 1, "point", false, false),
        new Input("stack3", 8, 1, 3, 1, null, false, false),
        new Input("rgb", 24, 1, 1, 1, null, false, false),
        new Input("8bit-oval", 8, 1, 1, 1, "oval", false, false),
        new Input("8bit-polygon", 8, 1, 1, 1, "polygon", false, false),
        new Input("hyper2x3x2", 8, 2, 3, 2, null, false, true),
        new Input("square256", 8, 1, 1, 1, null, false, false),
    };
    static { INPUTS[INPUTS.length - 1].size = 256; }
    /** Commands that need state a fresh image does not have: run first (same thread, same image). */
    static final Map<String, String> PREP = Map.of("Distribution...", "Measure");
    static final Input STACK3 = INPUTS[7];

    static float value(int x, int y, int k) {
        double v = 0.5 + 0.25 * Math.sin((x + 5 * k) * 0.21) * Math.cos(y * 0.17);
        double dx = x - (28 + 11 * k), dy = y - 30; if (dx * dx + dy * dy < 120) v += 0.3;
        dx = x - 70; dy = y - (22 + 7 * k); if (dx * dx + dy * dy < 60) v -= 0.25;
        return (float) Math.max(0, Math.min(1, v));
    }

    static ImageProcessor plane(int depth, int k, boolean binary) {
        ImageProcessor ip;
        switch (depth) {
            case 16: ip = new ShortProcessor(W, H); break;
            case 32: ip = new FloatProcessor(W, H); break;
            case 24: ip = new ColorProcessor(W, H); break;
            default: ip = new ByteProcessor(W, H);
        }
        for (int y = 0; y < H; y++) for (int x = 0; x < W; x++) {
            float v = value(x, y, k);
            if (binary) { ip.set(x, y, v > 0.6f ? 255 : 0); continue; }
            switch (depth) {
                case 16: ip.set(x, y, Math.round(v * 4000f)); break;
                case 32: ip.setf(x, y, v * 100f); break;
                case 24: ip.set(x, y, ((Math.round(v * 255) & 255) << 16) | ((Math.round(value(y, x, k)* 255) & 255) << 8) | (Math.round(value(x + 9, y, k) * 255) & 255)); break;
                default: ip.set(x, y, Math.round(v * 255f));
            }
        }
        return ip;
    }

    static ImagePlus build(Input in) {
        ImageStack st = new ImageStack(W, H);
        int n = in.c * in.z * in.t;
        for (int k = 0; k < n; k++) st.addSlice(plane(in.bitDepth, k, in.binary));
        ImagePlus imp = new ImagePlus("capture", st);
        if (in.c * in.z * in.t > 1) imp.setDimensions(in.c, in.z, in.t);
        if (in.composite) { imp = new CompositeImage(imp, IJ.COMPOSITE); imp.setTitle("capture"); }
        if (in.roi != null) {
            switch (in.roi) {
                case "rect": imp.setRoi(new Roi(16, 12, 48, 36)); break;
                case "oval": imp.setRoi(new OvalRoi(16, 12, 48, 36)); break;
                case "line": imp.setRoi(new Line(10, 10, 80, 50)); break;
                case "point": imp.setRoi(new PointRoi(30, 30)); break;
                case "polygon": imp.setRoi(new PolygonRoi(new int[]{14, 70, 80, 40, 20}, new int[]{10, 8, 50, 58, 40}, 5, Roi.POLYGON)); break;
            }
        }
        return imp;
    }

    // ------------------------------------------------------------------ JSON
    static void json(Object o, StringBuilder b, int depth) {
        if (o == null) b.append("null");
        else if (o instanceof String) quote((String) o, b);
        else if (o instanceof Number || o instanceof Boolean) b.append(o);
        else if (o instanceof Map) {
            Map<?, ?> m = (Map<?, ?>) o;
            if (m.isEmpty()) { b.append("{}"); return; }
            boolean inline = depth >= 4;
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
            boolean inline = depth >= 4 || l.stream().allMatch(x -> x == null || x instanceof String || x instanceof Number || x instanceof Boolean);
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
                default: if (c < 32 || c == 0x2028 || c == 0x2029) b.append(String.format("\\u%04x", (int) c)); else b.append(c);
            }
        }
        b.append('"');
    }

    static Map<String, Object> map(Object... kv) {
        Map<String, Object> m = new LinkedHashMap<>();
        for (int i = 0; i < kv.length; i += 2) m.put((String) kv[i], kv[i + 1]);
        return m;
    }

    // ------------------------------------------------------------------ reflection helpers
    static Object field(Object o, String name) {
        try {
            Class<?> c = o.getClass();
            while (c != null) {
                try { Field f = c.getDeclaredField(name); f.setAccessible(true); return f.get(o); } catch (NoSuchFieldException e) { c = c.getSuperclass(); }
            }
        } catch (Throwable t) { /* unreadable: the caller treats it as absent */ }
        return null;
    }

    static TextArea recorderText;

    static void installRecorder() throws Exception {
        new Recorder(false);                                 // sets Recorder.instance and its text area; nothing is shown
        Field f = Recorder.class.getDeclaredField("textArea");
        f.setAccessible(true);
        recorderText = (TextArea) f.get(null);
        Recorder.record = true;
        Recorder.recordInMacros = true;
    }

    // ------------------------------------------------------------------ walking a dialog
    static String lines(MultiLineLabel m) {
        Object l = field(m, "lines");
        if (l instanceof String[]) {
            StringBuilder b = new StringBuilder();
            for (Object s : (String[]) l) { if (s == null) continue; if (b.length() > 0) b.append('\n'); b.append(s); }
            return b.toString();
        }
        return "";
    }

    static String baseKey(String key) { return key == null ? null : key.replaceAll("_\\d+$", ""); }

    static String trimKey(String label) {
        String k = label;
        int i = k.indexOf(' '); if (i > -1) k = k.substring(0, i);
        i = k.indexOf(':'); if (i > -1) k = k.substring(0, i);
        return k.toLowerCase(Locale.US);
    }

    static int decimals(String text) {
        if (text == null) return 0;
        int e = text.indexOf('E'); String t = e > -1 ? text.substring(0, e) : text;
        int dot = t.indexOf('.');
        return dot < 0 ? 0 : t.length() - dot - 1;
    }

    static class Walk {
        final GenericDialog gd; final Map<Object, Object> keys; final List<Object> comps = new ArrayList<>();
        final List<String> buttons = new ArrayList<>();
        final Set<Object> numeric, strings, sliders, seenGroups = Collections.newSetFromMap(new IdentityHashMap<>());
        final Map<Object, Integer> sliderIndex = new IdentityHashMap<>();
        String pending = ""; boolean prevMsg; int textAreas; Scrollbar pendingSlider; Container numericParent; Map<String, Object> lastNumeric;
        Walk(GenericDialog gd) {
            this.gd = gd;
            Object l = field(gd, "labels");
            keys = l instanceof Map ? new IdentityHashMap<>((Map<?, ?>) l) : new IdentityHashMap<>();
            numeric = ident(gd.getNumericFields()); strings = ident(gd.getStringFields()); sliders = ident(gd.getSliders());
            int i = 0;
            if (gd.getSliders() != null) for (Object s : gd.getSliders()) sliderIndex.put(s, i++);
        }
        static Set<Object> ident(Vector<?> v) {
            Set<Object> s = Collections.newSetFromMap(new IdentityHashMap<>());
            if (v != null) s.addAll(v);
            return s;
        }
        String key(Object comp) { Object k = keys.get(comp); return k == null ? null : String.valueOf(k); }

        void visit(Component c, Container parent) {
            if (c instanceof MultiLineLabel) {
                String t = lines((MultiLineLabel) c);
                comps.add(map("t", "message", "text", t));
                pending = t; prevMsg = true;
                return;
            } else if (c instanceof Label) {
                prevMsg = false;
                String t = ((Label) c).getText();
                if (lastNumeric != null && parent != null && parent == numericParent && parent != gd) { lastNumeric.put("units", t.trim()); lastNumeric = null; }
                else pending = t;
            } else if (c instanceof Scrollbar && sliders.contains(c)) {
                pendingSlider = (Scrollbar) c;
            } else if (c instanceof TextField) {
                TextField tf = (TextField) c;
                String label = pending.trim();
                if (numeric.contains(tf)) {
                    Map<String, Object> m;
                    if (pendingSlider != null) {
                        double scale = 1; int idx = sliderIndex.getOrDefault(pendingSlider, -1);
                        Object sc = field(gd, "sliderScales");
                        if (sc instanceof Vector && idx >= 0 && idx < ((Vector<?>) sc).size()) scale = ((Number) ((Vector<?>) sc).get(idx)).doubleValue();
                        m = map("t", "slider", "label", label, "key", key(tf), "value", tf.getText(),
                                "min", pendingSlider.getMinimum() / scale, "max", (pendingSlider.getMaximum() - 1) / scale, "scale", scale);
                        pendingSlider = null; lastNumeric = null;
                    } else {
                        m = map("t", "numeric", "label", label, "key", key(tf), "value", tf.getText(), "decimals", decimals(tf.getText()));
                        lastNumeric = m; numericParent = parent;
                    }
                    comps.add(m);
                } else if (strings.contains(tf)) {
                    comps.add(map("t", "string", "label", label, "key", key(tf), "value", tf.getText()));
                    lastNumeric = null;
                } else comps.add(map("t", "string", "label", label, "key", null, "value", tf.getText(), "unregistered", true));
            } else if (c instanceof TextArea) {
                comps.add(map("t", "textarea", "key", "text" + (++textAreas), "value", ((TextArea) c).getText()));
            } else if (c instanceof Checkbox) {
                Checkbox cb = (Checkbox) c; CheckboxGroup g = cb.getCheckboxGroup();
                if (g == null) {
                    comps.add(map("t", "checkbox", "label", cb.getLabel(), "key", key(cb), "state", cb.getState()));
                } else if (seenGroups.add(g)) {
                    List<String> items = new ArrayList<>(); String sel = null;
                    for (Component k : gd.getComponents()) collectGroup(k, g, items);
                    if (g.getSelectedCheckbox() != null) sel = g.getSelectedCheckbox().getLabel();
                    comps.add(map("t", "radio", "label", prevMsg ? pending.trim() : "", "key", key(g), "items", items, "selected", sel));
                }
            } else if (c instanceof Choice) {
                Choice ch = (Choice) c; List<String> items = new ArrayList<>();
                for (int i = 0; i < ch.getItemCount(); i++) items.add(ch.getItem(i));
                comps.add(map("t", "choice", "label", pending.trim(), "key", key(ch), "items", items, "selected", ch.getSelectedItem()));
            } else if (c instanceof Button) {
                String bl = ((Button) c).getLabel();
                String tr = bl.trim();
                if (!tr.equals("OK") && !tr.equals("Cancel") && !tr.equals("Help") && !tr.equals("No")) buttons.add(bl);
            }
            if (!(c instanceof Container) || c instanceof TextField || c instanceof Choice) prevMsg = false;
            if (c instanceof Container) for (Component k : ((Container) c).getComponents()) visit(k, (Container) c);
        }

        void collectGroup(Component c, CheckboxGroup g, List<String> items) {
            if (c instanceof Checkbox && ((Checkbox) c).getCheckboxGroup() == g) items.add(((Checkbox) c).getLabel());
            if (c instanceof Container) for (Component k : ((Container) c).getComponents()) collectGroup(k, g, items);
        }
    }

    /**
     * `underscored`: the key is not what the DISPLAYED label gives. ImageJ shows `_` as a space but keeps the underscores in the key
     * ("Parameter_1" is shown "Parameter 1", key `parameter_1`), so the label alone cannot give the key. Decided by replaying
     * saveLabel's rule (trimKey, then `_0`, `_1` on a repeat) over the registered components in order.
     */
    static void markUnderscored(List<Object> comps) {
        Set<String> used = new HashSet<>();
        for (Object o : comps) {
            @SuppressWarnings("unchecked") Map<String, Object> m = (Map<String, Object>) o;
            Object k = m.get("key"), l = m.get("label");
            if (!(k instanceof String) || !(l instanceof String) || "textarea".equals(m.get("t"))) continue;
            String label = ((String) l).trim(), key = label.isEmpty() ? label : trimKey(label);
            if (!key.isEmpty() && used.contains(key)) {
                key += "_0";
                for (int n = 1; used.contains(key); n++) key = key.substring(0, key.lastIndexOf('_')) + "_" + n;
            }
            if ("radio".equals(m.get("t")) && label.isEmpty()) { used.add((String) k); continue; }
            if (!key.equals(k)) m.put("underscored", true);
            used.add((String) k);
        }
    }

    // ------------------------------------------------------------------ driving a command
    static Set<Window> baseline;
    static final Set<Window> handled = Collections.newSetFromMap(new IdentityHashMap<>());

    static Window newDialog() {
        for (Window w : Window.getWindows()) {
            if (baseline.contains(w) || handled.contains(w) || !w.isVisible()) continue;
            if (w instanceof Dialog) return w;
        }
        return null;
    }

    static void click(Container root, String label) {
        try {
            SwingUtilities.invokeAndWait(() -> fire(root, label));
        } catch (Throwable t) { /* a dialog that went away on its own */ }
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
            if (k instanceof MultiLineLabel) { if (b.length() > 0) b.append('\n'); b.append(lines((MultiLineLabel) k)); }
            else if (k instanceof Label) { if (b.length() > 0) b.append('\n'); b.append(((Label) k).getText()); }
            else if (k instanceof Container) { String s = textOf((Container) k); if (!s.isEmpty()) { if (b.length() > 0) b.append('\n'); b.append(s); } }
        }
        return b.toString();
    }

    static void closeAll() {
        int[] ids = WindowManager.getIDList();
        if (ids != null) for (int id : ids) { ImagePlus i = WindowManager.getImage(id); if (i != null) { i.changes = false; i.close(); } }
        for (Window w : Window.getWindows()) if (!baseline.contains(w) && w.isVisible()) { try { SwingUtilities.invokeAndWait(w::dispose); } catch (Throwable t) { w.dispose(); } }
        handled.clear();
    }

    static class Run {
        final List<Map<String, Object>> dialogs = new ArrayList<>();
        final List<Map<String, Object>> messages = new ArrayList<>(), windowDialogs = new ArrayList<>();
        String processQuestion, recordedLine, skipped; boolean threw, timedOut; String windows;
        final List<String> perDialogRecorded = new ArrayList<>();
        boolean sawGeneric() { return dialogs.stream().anyMatch(d -> !"YesNoCancelDialog".equals(d.get("kind"))); }
    }

    static Run run(String cmd, Input in) throws Exception {
        closeAll();
        Run r = new Run();
        W = in.size > 0 ? in.size : 96; H = in.size > 0 ? in.size : 64;   // `other` has the size of the image, FD Math asks for it
        ImagePlus other = new ImagePlus("other", plane(8, 1, false)); other.show();
        ImagePlus imp = build(in); imp.show();
        Thread.sleep(80);
        recorderText.setText("");
        final ImagePlus fimp = imp;
        Thread t = new Thread(() -> {
            try {
                String prep = PREP.get(cmd);
                if (prep != null) IJ.run(fimp, prep, null);
                IJ.run(fimp, cmd, null);
            } catch (Throwable e) { r.threw = true; }
        }, "capture-run");
        t.setDaemon(true);
        t.start();
        long last = System.currentTimeMillis(); String lastOpts = null;
        while (true) {
            Window w = newDialog();
            if (w != null) {
                handled.add(w);
                last = System.currentTimeMillis();
                Thread.sleep(80);                       // let the dialog finish laying out
                handleDialog(w, r);
                Thread.sleep(100);
                continue;
            }
            if (!t.isAlive()) break;
            if (System.currentTimeMillis() - last > 12000) { r.timedOut = true; break; }
            Thread.sleep(40);
        }
        if (t.isAlive() && r.timedOut) {
            StringBuilder b = new StringBuilder();
            for (Window w : Window.getWindows()) if (!baseline.contains(w) && w.isVisible()) {
                String title = w instanceof Frame ? ((Frame) w).getTitle() : w instanceof Dialog ? ((Dialog) w).getTitle() : w.getClass().getName();
                if (b.length() > 0) b.append(" | ");
                b.append(w.getClass().getSimpleName()).append(':').append(title);
            }
            r.windows = b.toString();
        } else if (r.windows == null) {
            for (Window w : Window.getWindows()) if (!baseline.contains(w) && w.isVisible() && w instanceof Frame && !(w instanceof ImageWindow)) {
                r.windows = (r.windows == null ? "" : r.windows + " | ") + ((Frame) w).getTitle();
            }
        }
        Thread.sleep(60);
        String text = recorderText.getText();
        if (System.getenv("DK_DEBUG") != null) System.out.println("  [rec] text=" + text.replace("\n", "|") + " opts=" + Recorder.getCommandOptions() + " cmd=" + Recorder.getCommand());
        if (text != null && !text.isEmpty()) {
            String[] ls = text.split("\n");
            for (String l : ls) if (!l.trim().isEmpty()) r.recordedLine = l;
        }
        closeAll();
        return r;
    }

    static String prevOptions = "";

    static void handleDialog(Window w, Run r) throws Exception {
        if (w instanceof FileDialog) { r.skipped = "file picker"; try { SwingUtilities.invokeAndWait(w::dispose); } catch (Throwable t) { w.dispose(); } return; }
        if (w instanceof YesNoCancelDialog) {
            YesNoCancelDialog d = (YesNoCancelDialog) w;
            String q = textOf(d), title = d.getTitle();
            if (q.contains("Process all")) {
                r.processQuestion = q;
                if (!r.dialogs.isEmpty()) r.dialogs.get(r.dialogs.size() - 1).put("processStack", true);
                else r.dialogs.add(map("kind", "YesNoCancelDialog", "title", title, "smartRecording", false,
                        "components", new ArrayList<>(List.of(map("t", "message", "text", q))), "processStack", true, "recorded", null));
                click(d, "Yes");
            } else {
                r.dialogs.add(map("kind", "YesNoCancelDialog", "title", title, "smartRecording", false,
                        "components", new ArrayList<>(List.of(map("t", "message", "text", q))), "processStack", false, "recorded", null));
                click(d, "Yes");
            }
            return;
        }
        if (w instanceof GenericDialog) {
            GenericDialog gd = (GenericDialog) w;
            Walk wk = new Walk(gd);
            for (Component c : gd.getComponents()) wk.visit(c, gd);
            markUnderscored(wk.comps);
            Map<String, Object> d = map("kind", gd instanceof NonBlockingGenericDialog ? "NonBlockingGenericDialog" : "GenericDialog",
                    "title", gd.getTitle(), "smartRecording", Boolean.TRUE.equals(field(gd, "smartRecording")),
                    "components", wk.comps, "processStack", false, "recorded", null);
            if (!wk.buttons.isEmpty()) d.put("buttons", wk.buttons);
            if (gd.getTitle() == null) d.put("title", "");
            r.dialogs.add(d);
            prevOptions = Recorder.getCommandOptions() == null ? "" : Recorder.getCommandOptions();
            click(gd, "OK");
            // commandOptions accumulates over the dialogs of one command: its growth after this OK is this dialog's share
            for (int i = 0; i < 12; i++) {
                Thread.sleep(25);
                String now = Recorder.getCommandOptions();
                if (now != null && now.length() > prevOptions.length()) {
                    String share = now.substring(prevOptions.length()).trim();
                    d.put("recordedShare", share);
                    break;
                }
            }
            return;
        }
        // an error / message / other dialog
        Container c = w;
        String title = w instanceof Dialog ? ((Dialog) w).getTitle() : "";
        Map<String, Object> m = map("class", w.getClass().getName(), "title", title, "text", textOf(c));
        // ij.gui.MessageDialog is ImageJ's error / notice box; any other dialog is a tool window the command opened (Brightness/Contrast, Threshold...)
        if (w.getClass().getName().equals("ij.gui.MessageDialog")) { r.messages.add(m); if (!fire(c, "OK")) SwingUtilities.invokeAndWait(w::dispose); else click(c, "OK"); }
        else { r.windowDialogs.add(m); try { SwingUtilities.invokeAndWait(w::dispose); } catch (Throwable t) { w.dispose(); } }
    }

    static String unquoteRecorded(String line, String cmd) {
        String pre = "run(\"" + cmd.replace("\\", "\\\\").replace("\"", "\\\"") + "\"";
        if (!line.startsWith(pre)) return null;
        String rest = line.substring(pre.length());
        if (rest.startsWith(");")) return null;
        if (!rest.startsWith(", \"") || !rest.endsWith("\");")) return null;
        String body = rest.substring(3, rest.length() - 3);
        return body.replace("\\\"", "\"").replace("\\\\", "\\");
    }

    // ------------------------------------------------------------------ menu paths, deny list
    static String menuPathOf(String cmd) {
        MenuBar mb = IJ.getInstance().getMenuBar();
        for (int i = 0; i < mb.getMenuCount(); i++) {
            String r = find(mb.getMenu(i), mb.getMenu(i).getLabel(), cmd);
            if (r != null) return r;
        }
        return null;
    }

    static String find(Menu m, String path, String cmd) {
        for (int i = 0; i < m.getItemCount(); i++) {
            MenuItem it = m.getItem(i);
            if (it instanceof Menu) {
                String r = find((Menu) it, path + ">" + it.getLabel(), cmd);
                if (r != null) return r;
            } else if (it.getActionCommand().equals(cmd) || it.getLabel().equals(cmd)) return path;
        }
        return null;
    }

    static final String[] DENY_PATH_PREFIX = {
        "File>Open Samples", "File>Open Recent", "File>Import", "File>Save As", "File>Batch", "Help>", "Plugins>Macros", "Plugins>Shortcuts",
        "Plugins>Utilities", "Plugins>New", "Plugins>Tools", "Plugins>Install", "Plugins>Scripts", "Plugins>Hot Keys"
    };
    static final Map<String, String> DENY_NAME = new LinkedHashMap<>();
    static {
        String[][] d = {
            {"Quit", "quits ImageJ"}, {"Open...", "file picker"}, {"Open Next", "file picker"}, {"Revert", "needs a file on disk"},
            {"Save", "file picker"}, {"Tiff...", "file picker"}, {"Gif...", "file picker"}, {"Jpeg...", "file picker"}, {"Text Image... ", "file picker"},
            {"ZIP...", "file picker"}, {"Raw Data...", "file picker"}, {"AVI... ", "file picker"}, {"BMP...", "file picker"}, {"PNG...", "file picker"},
            {"PGM...", "file picker"}, {"FITS...", "file picker"}, {"LUT...", "file picker"}, {"Selection...", "file picker"}, {"XY Coordinates...", "file picker"},
            {"Results...", "file picker"}, {"Text...", "file picker"}, {"Measurements...", "file picker"},
            {"Install...", "installs code"}, {"Compile and Run...", "file picker"}, {"Run...", "file picker"}, {"Edit...", "file picker"}, {"Startup Macros...", "opens an editor"},
            {"Record...", "starts the recorder (would change the capture)"}, {"Update ImageJ...", "network"}, {"Update Menus", "reloads the menus"},
            {"Reload Plugins", "reloads plugins"}, {"Reload Menus", "reloads the menus"}, {"Memory & Threads...", "changes the JVM settings file"},
            {"Proxy Settings...", "network settings"}, {"Wand Tool...", "needs a tool click"}, {"ImageJ Web Site...", "opens a browser"}, {"Close", "tears the capture down"},
            {"Close All", "tears the capture down"}, {"Repeat Command", "repeats the capture's previous command"}, {"Monitor Memory...", "opens a monitor window"},
            {"Image Sequence...", "directory picker"}, {"Image Sequence... ", "directory picker"}, {"URL...", "network"}, {"Open as 3D image...", "network"}, {"Add to Manager", "uses the ROI Manager window"},
            {"Capture Screen ", "captures the desktop"}, {"Capture Image", "captures the desktop"}, {"Capture Screen", "captures the desktop"}, {"Configure Launcher...", "writes the host launcher"},
            {"Text File... ", "file picker"}, {"Table... ", "file picker"}, {"Save As... ", "file picker"}, {"Lookup Table... ", "file picker"}, {"Command Finder", "needs keyboard focus"}
        };
        for (String[] x : d) DENY_NAME.put(x[0], x[1]);
    }

    static String denied(String name, String path) {
        String r = DENY_NAME.get(name);
        if (r != null) return r;
        if (path != null) for (String p : DENY_PATH_PREFIX) if (path.startsWith(p)) return "menu excluded (" + path + ")";
        return null;
    }

    // ------------------------------------------------------------------ main
    public static void main(String[] a) throws Exception {
        Locale.setDefault(Locale.ROOT);
        String out = a[0]; boolean fiji = false; List<String> only = null; List<String> names = null;
        for (int i = 1; i < a.length; i++) {
            if (a[i].equals("--fiji")) fiji = true;
            else if (a[i].equals("--only")) only = Arrays.asList(a[++i].split(";", -1));
            else if (a[i].equals("--names")) names = Arrays.asList(a[++i].split(";", -1));
            else if (a[i].equals("--names-file")) names = Files.readAllLines(Paths.get(a[++i]), StandardCharsets.UTF_8);
        }
        ImageJ ij = new ImageJ(ImageJ.NO_SHOW);
        Hashtable<String, String> cmds = Menus.getCommands();
        installRecorder();
        baseline = new HashSet<>(Arrays.asList(Window.getWindows()));
        List<String> all = names != null ? new ArrayList<>(names) : new ArrayList<>(new TreeSet<>(cmds.keySet()));
        if (only != null) all = new ArrayList<>(only);
        if (names != null && names.stream().anyMatch(String::isEmpty)) all.removeIf(String::isEmpty);

        Map<String, Object> commands = new LinkedHashMap<>();
        List<String> unrecognized = new ArrayList<>();
        int n = 0;
        for (String name : all) {
            n++;
            String cls = cmds.get(name);
            if (cls == null) {
                // a SciJava command or a name of the Studio that is no IJ1 command: not capturable here
                unrecognized.add(name);
                continue;
            }
            String path = menuPathOf(name);
            Map<String, Object> e = map("class", cls, "menuPath", path);
            commands.put(name, e);
            String deny = denied(name, path);
            if (deny != null) { e.put("skipped", deny); System.out.println("[" + n + "/" + all.size() + "] skip " + name + ": " + deny); continue; }
            System.out.print("[" + n + "/" + all.size() + "] " + name + " ... ");
            System.out.flush();
            Run best = null; Input bestIn = null; Run first = null; Input firstIn = null; Run clean = null; Input cleanIn = null; List<String> msgs = new ArrayList<>();
            String windows = null; boolean timedOut = false; String skip = null;
            for (int ii = 0; ii < INPUTS.length; ii++) {
                Input in = INPUTS[ii];
                // a command that neither opened a dialog nor complained on the first two inputs is only retried on a stack and on RGB
                if (ii >= 2 && ii < 7 && msgs.isEmpty() && first != null && first.dialogs.isEmpty()) continue;
                if (ii >= 9 && msgs.isEmpty()) break;
                Run r = run(name, in);
                if (first == null) { first = r; firstIn = in; }
                if (clean == null && r.messages.isEmpty() && !r.timedOut && r.skipped == null) { clean = r; cleanIn = in; }
                if (r.skipped != null) skip = r.skipped;
                if (r.windows != null && windows == null) windows = r.windows;
                if (r.timedOut) timedOut = true;
                for (Map<String, Object> m : r.messages) msgs.add(in.id + ": " + m.get("text"));
                if (r.sawGeneric()) { best = r; bestIn = in; break; }
                if (r.timedOut || r.skipped != null) break;
            }
            Map<String, Object> inputDesc = null;
            if (best != null) {
                inputDesc = inputDescOf(bestIn);
                // the Process-all question is asked by the dialog's plugin only on a stack: one more run on it
                if (bestIn != STACK3 && !best.dialogs.isEmpty() && best.processQuestion == null) {
                    Run s = run(name, STACK3);
                    if (s.processQuestion != null) {
                        List<Map<String, Object>> sd = s.dialogs;
                        for (int i = sd.size() - 1; i >= 0; i--) if (Boolean.TRUE.equals(sd.get(i).get("processStack"))) {
                            Map<String, Object> flagged = i < best.dialogs.size() ? best.dialogs.get(i) : best.dialogs.get(best.dialogs.size() - 1);
                            flagged.put("processStack", true);
                            best.processQuestion = s.processQuestion;
                            break;
                        }
                    }
                }
                finishDialogs(best, name);
                e.put("input", inputDesc);
                e.put("dialogs", best.dialogs);
                if (best.processQuestion != null) e.put("processQuestion", best.processQuestion);
                if (!best.messages.isEmpty()) e.put("messages", best.messages);
                System.out.println(best.dialogs.size() + " dialog(s) on " + bestIn.id);
            } else if (skip != null) {
                e.put("skipped", skip);
                System.out.println("skipped: " + skip);
            } else if (timedOut && clean == null && windows != null && windows.matches("(?:(?:Image|Stack)Window:[^|]*(?: \\| )?)+")) {
                // it started something that keeps running (Start Animation) and opened no dialog
                e.put("noDialog", true); e.put("input", inputDescOf(firstIn)); e.put("opensWindow", windows); e.put("note", "still running after 12 s, no dialog");
                System.out.println("no dialog (keeps running)");
            } else if (timedOut) {
                e.put("skipped", "did not finish (" + (windows == null ? "no window" : windows) + ")");
                System.out.println("timed out");
            } else {
                // no GenericDialog on any input: the command has none, or it refused every input we built
                if (clean != null) {
                    e.put("noDialog", true); e.put("input", inputDescOf(cleanIn));
                    List<String> ow = new ArrayList<>();
                    if (clean.windows != null) ow.add(clean.windows);
                    for (Map<String, Object> wd : clean.windowDialogs) ow.add(String.valueOf(wd.get("title")));
                    if (!ow.isEmpty()) e.put("opensWindow", String.join(" | ", ow));
                    System.out.println("no dialog on " + cleanIn.id);
                } else {
                    e.put("skipped", "no dialog on any input; messages: " + String.join(" || ", new LinkedHashSet<>(msgs)));
                    System.out.println("refused on every input");
                }
            }
        }
        Map<String, Object> doc = map("imagej", IJ.getFullVersion().replaceAll("^(\\d+\\.\\d+\\w?).*", "$1"), "generator", "tools/ij_fixtures/macro/DialogKeys.java", "locale", "ROOT");
        if (fiji) doc.put("fiji", IJ.getFullVersion());
        doc.put("blackBackground", Prefs.blackBackground);
        doc.put("commands", commands);
        doc.put("unrecognized", unrecognized);
        StringBuilder b = new StringBuilder();
        json(doc, b, 0);
        Files.write(Paths.get(out), (b + "\n").getBytes(StandardCharsets.UTF_8));
        System.out.println("done: " + commands.size() + " commands, " + unrecognized.size() + " unrecognized");
        System.exit(0);
    }

    static Map<String, Object> inputDescOf(Input in) {
        return map("bitDepth", in.bitDepth, "dims", map("c", in.c, "z", in.z, "t", in.t), "roi", in.roi, "binary", in.binary, "composite", in.composite, "others", 1, "id", in.id);
    }

    /** `recorded`: the Recorder's option string of the whole run when the command had one dialog, else the per-dialog share. */
    static void finishDialogs(Run r, String cmd) {
        String whole = r.recordedLine == null ? null : unquoteRecorded(r.recordedLine, cmd);
        boolean callForm = r.recordedLine != null && !r.recordedLine.startsWith("run(\"");
        int generic = 0;
        for (Map<String, Object> d : r.dialogs) if (!"YesNoCancelDialog".equals(d.get("kind"))) generic++;
        for (Map<String, Object> d : r.dialogs) {
            Object share = d.remove("recordedShare");
            if ("YesNoCancelDialog".equals(d.get("kind"))) continue;
            if (generic == 1) d.put("recorded", whole != null ? whole : share);
            else d.put("recorded", share);
        }
        if (generic > 1 && whole != null) r.dialogs.get(0).put("recordedAll", whole);
        if (callForm && !r.dialogs.isEmpty()) r.dialogs.get(0).put("recordedCall", r.recordedLine);
    }
}
