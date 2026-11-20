import ij.*;
import ij.gui.*;
import ij.process.*;
import java.awt.*;
import java.awt.event.*;
import java.util.*;
import java.util.List;
import java.util.function.Supplier;
import javax.swing.SwingUtilities;

/**
 * dialogs: the structure of every dialog of the stack commands, recorded by RUNNING the command in GUI mode (no macro options) and walking the
 * visible AWT dialog (public API only, the technique of fiji/DialogCapture.java). A command that asks twice (a filter on a stack:
 * its own dialog, then PlugInFilterRunner's "Process all N images?") is walked step by step: OK / Yes is pressed on every step but the last,
 * the last one is cancelled. Also: the watchdog that answers dialogs nobody expected while a macro-mode case runs.
 */
final class W4Dlg {
    static volatile boolean guard = false;
    static volatile boolean capturing = false;
    static final List<Object> unexpected = Collections.synchronizedList(new ArrayList<>());
    static final Set<Window> handled = Collections.newSetFromMap(new IdentityHashMap<>());

    // ------------------------------------------------------------------ watchdog
    static void startWatchdog() {
        Thread t = new Thread(() -> {
            while (true) {
                try { Thread.sleep(150); } catch (InterruptedException e) { return; }
                if (!guard || capturing) continue;
                for (Window w : Window.getWindows()) {
                    if (!(w instanceof Dialog) || !w.isVisible() || handled.contains(w) || noise(w)) continue;
                    handled.add(w);
                    List<Object> comps = new ArrayList<>();
                    try { walk(w, comps, new IdentityHashMap<>()); } catch (Throwable ignore) { }
                    unexpected.add(J.o("class", w.getClass().getSimpleName(), "title", ((Dialog) w).getTitle(), "components", comps));
                    final Dialog d = (Dialog) w;
                    try { SwingUtilities.invokeAndWait(() -> { if (!click(d, "OK", "Yes", "Cancel")) d.dispose(); }); } catch (Throwable e) { d.dispose(); }
                }
            }
        }, "w4-watchdog");
        t.setDaemon(true);
        t.start();
    }

    // ------------------------------------------------------------------ walking a dialog
    /** The Channels tool opens by itself beside any composite image: not part of a command's dialogs. */
    static boolean noise(Window w) { return w.getClass().getSimpleName().equals("Channels"); }

    static String norm(String s) { return s == null ? null : s.replaceAll("\\(\\d+MB free\\)", "(? MB free)"); }

    static String text(Component c) {
        if (c instanceof Label) return ((Label) c).getText();
        if (c instanceof MultiLineLabel) {
            try { String[] l = (String[]) Gen.get(c, "lines"); return norm(String.join("\n", l)); } catch (Exception e) { return "?"; }
        }
        return null;
    }

    static void walk(Component c, List<Object> out, Map<Component, Boolean> numeric) {
        Object[] pend = new Object[1];
        walk1(c, out, numeric, pend);
    }

    static void walk1(Component c, List<Object> out, Map<Component, Boolean> numeric, Object[] pend) {
        if (c instanceof Label) { String s = norm(((Label) c).getText()); out.add(J.o("t", "label", "text", s)); pend[0] = s; }
        else if (c instanceof MultiLineLabel) out.add(J.o("t", "message", "text", text(c)));
        else if (c instanceof TextField) {
            TextField tf = (TextField) c;
            Boolean isNum = numeric.get(tf);
            String lab = pend[0] == null ? null : (String) pend[0];
            out.add(J.o("t", isNum == null ? "text" : isNum ? "numeric" : "string", "label", lab, "key", lab == null ? null : Macro.trimKey(lab.trim()), "value", tf.getText(), "columns", tf.getColumns()));
            pend[0] = null;
        } else if (c instanceof Checkbox) {
            Checkbox cb = (Checkbox) c;
            out.add(J.o("t", cb.getCheckboxGroup() != null ? "radio" : "checkbox", "label", cb.getLabel(), "key", Macro.trimKey(cb.getLabel().trim()), "keyRaw", Macro.trimKey(cb.getLabel()), "state", cb.getState()));
        } else if (c instanceof Choice) {
            Choice ch = (Choice) c;
            String[] items = new String[ch.getItemCount()];
            for (int i = 0; i < items.length; i++) items[i] = ch.getItem(i);
            String lab = pend[0] == null ? null : (String) pend[0];
            out.add(J.o("t", "choice", "label", lab, "key", lab == null ? null : Macro.trimKey(lab.trim()), "items", items, "selected", ch.getSelectedItem()));
            pend[0] = null;
        } else if (c instanceof Scrollbar) {
            Scrollbar sb = (Scrollbar) c;
            out.add(J.o("t", "slider", "min", sb.getMinimum(), "max", sb.getMaximum(), "value", sb.getValue()));
        } else if (c instanceof Button) out.add(J.o("t", "button", "label", ((Button) c).getLabel()));
        else if (c instanceof TextArea) out.add(J.o("t", "textarea", "text", ((TextArea) c).getText()));
        if (c instanceof Container) for (Component k : ((Container) c).getComponents()) walk1(k, out, numeric, pend);
    }

    static Map<Component, Boolean> fieldKinds(Dialog d) {
        Map<Component, Boolean> m = new IdentityHashMap<>();
        if (d instanceof GenericDialog) {
            GenericDialog gd = (GenericDialog) d;
            if (gd.getNumericFields() != null) for (Object o : gd.getNumericFields()) m.put((Component) o, true);
            if (gd.getStringFields() != null) for (Object o : gd.getStringFields()) m.put((Component) o, false);
        }
        return m;
    }

    static boolean click(Container c, String... labels) {
        List<Button> bs = new ArrayList<>();
        buttons(c, bs);
        for (String l : labels) for (Button b : bs) if (b.getLabel().trim().equals(l)) { b.dispatchEvent(new ActionEvent(b, ActionEvent.ACTION_PERFORMED, l)); return true; }
        return false;
    }

    static void buttons(Container c, List<Button> out) {
        for (Component k : c.getComponents()) {
            if (k instanceof Button) out.add((Button) k);
            if (k instanceof Container) buttons((Container) k, out);
        }
    }

    // ------------------------------------------------------------------ capture
    static Set<Window> visible() {
        Set<Window> s = Collections.newSetFromMap(new IdentityHashMap<>());
        for (Window w : Window.getWindows()) if (w.isVisible()) s.add(w);
        return s;
    }

    static Dialog waitDialog(Set<Window> known, long ms) throws InterruptedException {
        long end = System.currentTimeMillis() + ms;
        while (System.currentTimeMillis() < end) {
            for (Window w : Window.getWindows()) if (w instanceof Dialog && w.isVisible() && !known.contains(w) && !noise(w)) { Thread.sleep(250); return (Dialog) w; }
            Thread.sleep(100);
        }
        return null;
    }

    static Map<String, Object> capture(String cmd, ImagePlus cur, int steps, long waitMs) throws Exception {
        Set<Window> known = visible();
        Thread t = new Thread(() -> {
            try { if (cur != null) IJ.run(cur, cmd, ""); else IJ.run(cmd, ""); } catch (Throwable e) { /* a refused command is recorded as "no dialog" */ }
        }, "cap-" + cmd);
        t.setDaemon(true);
        capturing = true;
        List<Object> out = new ArrayList<>();
        List<Object> other = new ArrayList<>();
        try {
            t.start();
            for (int s = 1; s <= steps; s++) {
                Dialog d = waitDialog(known, s == 1 ? waitMs : 6000);
                if (d == null) break;
                known.add(d);
                List<Object> comps = new ArrayList<>();
                walk(d, comps, fieldKinds(d));
                out.add(J.o("class", d.getClass().getSimpleName(), "title", d.getTitle(), "modal", d.isModal(), "components", comps));
                final Dialog fd = d;
                final boolean last = s == steps;
                SwingUtilities.invokeAndWait(() -> {
                    boolean ok = last ? click(fd, "Cancel", "OK", "No") : click(fd, "OK", "Yes");
                    if (!ok) fd.dispose();
                });
                Thread.sleep(300);
            }
            t.join(4000);
        } finally {
            capturing = false;
            for (Window w : Window.getWindows()) {
                if (!w.isVisible() || w instanceof ij.ImageJ || w instanceof ImageWindow || known.contains(w)) continue;
                if (w instanceof Frame) other.add(J.o("class", w.getClass().getSimpleName(), "title", ((Frame) w).getTitle()));
                w.dispose();
            }
        }
        LinkedHashMap<String, Object> r = new LinkedHashMap<>();
        r.put("command", cmd);
        r.put("menuClass", Menus.getCommands().get(cmd));
        r.put("menuPath", menuPathOf(cmd));
        r.put("steps", out);
        if (out.isEmpty()) r.put("noDialog", true);
        if (!other.isEmpty()) r.put("windows", other);
        return r;
    }

    static String menuPathOf(String cmd) {
        MenuBar mb = IJ.getInstance().getMenuBar();
        if (mb == null) return null;
        for (int i = 0; i < mb.getMenuCount(); i++) {
            String r = find(mb.getMenu(i), mb.getMenu(i).getLabel(), cmd);
            if (r != null) return r;
        }
        return null;
    }

    static String find(Menu m, String path, String cmd) {
        for (int i = 0; i < m.getItemCount(); i++) {
            MenuItem it = m.getItem(i);
            if (it instanceof Menu) { String r = find((Menu) it, path + ">" + it.getLabel(), cmd); if (r != null) return r; }
            else if (it.getLabel().equals(cmd) || it.getLabel().replaceAll(" \\[.*\\]$", "").equals(cmd)) return path;
        }
        return null;
    }

    // ------------------------------------------------------------------ the roster
    static ImagePlus[] one(ImagePlus a) { return new ImagePlus[]{a}; }

    static void dlg(String name, String cmd, int steps, Supplier<ImagePlus[]> imgs) {
        W4Stk.kase("dialogs", name, "dialog", f -> {
            ImagePlus[] a = imgs.get();
            for (ImagePlus i : a) i.show();
            ImagePlus cur = a.length == 0 ? null : a[a.length - 1];
            if (cur != null) IJ.selectWindow(cur.getID());
            f.put("command", cmd);
            f.put("image", cur == null ? null : describe(cur));
            f.put("others", othersOf(a));
            Map<String, Object> r = capture(cmd, cur, steps, steps > 1 ? 8000 : 4000);
            for (Map.Entry<String, Object> e : r.entrySet()) f.put(e.getKey(), e.getValue());
        });
    }

    static Object describe(ImagePlus i) {
        return J.o("title", i.getTitle(), "bitDepth", i.getBitDepth(), "dims", J.o("c", i.getNChannels(), "z", i.getNSlices(), "t", i.getNFrames()),
            "hyperstack", i.isHyperStack(), "composite", i.isComposite(), "width", i.getWidth(), "height", i.getHeight(), "roi", i.getRoi() == null ? null : J.roi(i.getRoi()));
    }

    static List<Object> othersOf(ImagePlus[] a) {
        List<Object> l = new ArrayList<>();
        for (int k = 0; k < a.length - 1; k++) l.add(describe(a[k]));
        return l;
    }

    static ImagePlus stk8() { return In.stack("stk", 8, 37, 23, 4, 1); }
    static ImagePlus hyp16() { return In.hyper("hyp", 16, 40, 30, 2, 3, 2, 2, true); }
    static ImagePlus hypColor() { ImagePlus h = hyp16(); ((CompositeImage) h).setMode(IJ.COLOR); return h; }
    static ImagePlus rect(ImagePlus i) { i.setRoi(new Roi(4, 3, 16, 10)); return i; }
    static ImagePlus line(ImagePlus i) { i.setRoi(new Line(3, 3, 22, 13)); return i; }

    static void run() {
        dlg("add_slice_stack", "Add Slice", 1, () -> one(stk8()));
        dlg("add_slice_hyper", "Add Slice", 1, () -> one(hyp16()));
        dlg("delete_slice_stack", "Delete Slice", 1, () -> one(stk8()));
        dlg("delete_slice_hyper", "Delete Slice", 1, () -> one(hyp16()));
        dlg("set_slice_stack", "Set Slice...", 1, () -> one(stk8()));
        dlg("set_slice_hyper", "Set Slice...", 1, () -> one(hyp16()));
        dlg("images_to_stack", "Images to Stack", 1, () -> new ImagePlus[]{In.image("a", 8, 37, 23, 3), In.image("b", 8, 37, 23, 4)});
        dlg("images_to_stack_sizes", "Images to Stack", 1, () -> new ImagePlus[]{In.image("a", 8, 37, 23, 3), In.image("b", 8, 30, 20, 4)});
        dlg("stack_to_images", "Stack to Images", 1, () -> one(stk8()));
        dlg("make_montage_stack", "Make Montage...", 1, () -> one(stk8()));
        dlg("make_montage_hyper", "Make Montage...", 1, () -> one(hyp16()));
        dlg("reslice_stack", "Reslice [/]...", 1, () -> one(stk8()));
        dlg("reslice_rect", "Reslice [/]...", 1, () -> one(rect(stk8())));
        dlg("reslice_line", "Reslice [/]...", 1, () -> one(line(stk8())));
        dlg("reslice_hyper", "Reslice [/]...", 1, () -> one(hyp16()));
        dlg("zproject_stack", "Z Project...", 1, () -> one(stk8()));
        dlg("zproject_hyper", "Z Project...", 1, () -> one(hyp16()));
        dlg("zproject_hyper_1c", "Z Project...", 1, () -> one(In.hyper("hyp1", 16, 40, 30, 1, 3, 2, 2, false)));
        dlg("zproject_hyper_nt1", "Z Project...", 1, () -> one(In.hyper("hypz", 16, 40, 30, 2, 3, 1, 2, true)));
        dlg("zaxis_profile_stack", "Plot Z-axis Profile", 1, () -> one(stk8()));
        dlg("zaxis_profile_rect", "Plot Z-axis Profile", 1, () -> one(rect(stk8())));
        dlg("zaxis_profile_hyper", "Plot Z-axis Profile", 1, () -> one(rect(hyp16())));
        dlg("measure_stack_hyper", "Measure Stack...", 1, () -> one(rect(hyp16())));
        dlg("new_image", "Image...", 1, () -> new ImagePlus[0]);
        dlg("conversions", "Conversions...", 1, () -> new ImagePlus[0]);
        dlg("set_measurements", "Set Measurements...", 1, () -> new ImagePlus[0]);
        dlg("properties_stack", "Properties...", 1, () -> one(stk8()));
        dlg("properties_hyper", "Properties...", 1, () -> one(hyp16()));
        dlg("channels_tool", "Channels Tool...", 1, () -> one(hyp16()));
        dlg("measure_stack", "Measure Stack...", 1, () -> one(rect(stk8())));
        dlg("label_stack", "Label...", 1, () -> one(stk8()));
        dlg("statistics_stack", "Statistics", 1, () -> one(stk8()));
        dlg("animation_options", "Animation Options...", 1, () -> one(stk8()));
        dlg("combine", "Combine...", 1, () -> new ImagePlus[]{In.stack("s1", 8, 37, 23, 4, 1), In.stack("s2", 8, 37, 23, 3, 9)});
        dlg("concatenate", "Concatenate...", 1, () -> new ImagePlus[]{In.stack("s1", 8, 37, 23, 4, 1), In.stack("s2", 8, 37, 23, 3, 9)});
        dlg("concatenate_hyper", "Concatenate...", 1, () -> new ImagePlus[]{In.hyper("h1", 16, 40, 30, 2, 3, 2, 2, true), In.hyper("h2", 16, 40, 30, 2, 3, 2, 8, true)});
        dlg("grouped_z_project", "Grouped Z Project...", 1, () -> one(stk8()));
        dlg("insert", "Insert...", 1, () -> new ImagePlus[]{In.stack("big", 8, 37, 23, 4, 1), In.stack("small", 8, 12, 9, 2, 9)});
        dlg("substack_stack", "Make Substack...", 1, () -> one(stk8()));
        dlg("substack_hyper", "Make Substack...", 1, () -> one(hyp16()));
        dlg("montage_to_stack", "Montage to Stack...", 1, () -> one(In.image("montage", 8, 60, 40, 5)));
        dlg("reduce_stack", "Reduce...", 1, () -> one(stk8()));
        dlg("reduce_hyper", "Reduce...", 1, () -> one(hyp16()));
        dlg("remove_slice_labels", "Remove Slice Labels", 1, () -> one(stk8()));
        dlg("reverse", "Reverse", 1, () -> one(stk8()));
        dlg("set_label_stack", "Set Label...", 1, () -> one(stk8()));
        dlg("new_hyperstack", "New Hyperstack...", 1, () -> new ImagePlus[0]);
        dlg("stack_to_hyperstack", "Stack to Hyperstack...", 1, () -> one(In.stack("stk12", 8, 37, 23, 12, 1)));
        dlg("stack_to_hyperstack_composite", "Stack to Hyperstack...", 1, () -> { ImagePlus h = hyp16(); h.setOpenAsHyperStack(false); return one(new ImagePlus("plain", h.getStack())); });
        dlg("hyperstack_to_stack", "Hyperstack to Stack", 1, () -> one(hyp16()));
        dlg("reduce_dimensionality", "Reduce Dimensionality...", 1, () -> one(hyp16()));
        dlg("make_subset", "Make Subset...", 1, () -> one(hyp16()));
        dlg("rgb_color_composite", "RGB Color", 1, () -> one(hyp16()));
        dlg("rgb_color_color_mode", "RGB Color", 1, () -> one(hypColor()));
        dlg("rgb_color_16bit_image", "RGB Color", 1, () -> one(In.image("g16", 16, 37, 23, 3)));
        dlg("rgb_color_stack8", "RGB Color", 1, () -> one(stk8()));
        dlg("stack_to_rgb_composite", "Stack to RGB", 1, () -> one(hyp16()));
        dlg("make_composite_rgb", "Make Composite", 1, () -> one(In.rgbImage("rgb", 37, 23, 3)));
        dlg("make_composite_stack3", "Make Composite", 1, () -> one(In.stack("stk3", 8, 37, 23, 3, 1)));
        dlg("make_composite_stack2", "Make Composite", 1, () -> one(In.stack("stk2", 8, 37, 23, 2, 1)));
        dlg("rgb_stack", "RGB Stack", 1, () -> one(In.rgbImage("rgb", 37, 23, 3)));
        dlg("hsb_stack", "HSB Stack", 1, () -> one(In.rgbImage("rgb", 37, 23, 3)));
        dlg("hsb_32bit", "HSB (32-bit)", 1, () -> one(In.rgbImage("rgb", 37, 23, 3)));
        dlg("lab_stack", "Lab Stack", 1, () -> one(In.rgbImage("rgb", 37, 23, 3)));
        dlg("eight_bit_color", "8-bit Color", 1, () -> one(In.rgbImage("rgb", 37, 23, 3)));
        dlg("split_channels_rgb", "Split Channels", 1, () -> one(In.rgbImage("rgb", 37, 23, 3)));
        dlg("merge_channels", "Merge Channels...", 1, () -> new ImagePlus[]{In.image("c1", 8, 37, 23, 1), In.image("c2", 8, 37, 23, 2), In.image("c3", 8, 37, 23, 3)});
        dlg("duplicate_image", "Duplicate...", 1, () -> one(In.image("img", 8, 37, 23, 1)));
        dlg("duplicate_stack", "Duplicate...", 1, () -> one(stk8()));
        dlg("duplicate_hyper", "Duplicate...", 1, () -> one(hyp16()));
        dlg("duplicate_hyper_nz1", "Duplicate...", 1, () -> one(In.hyper("hypt", 16, 40, 30, 2, 1, 3, 2, true)));
        dlg("size_stack", "Size...", 1, () -> one(stk8()));
        dlg("size_hyper", "Size...", 1, () -> one(hyp16()));
        dlg("size_image", "Size...", 1, () -> one(In.image("img", 8, 37, 23, 1)));
        dlg("scale_stack", "Scale...", 1, () -> one(stk8()));
        dlg("scale_image", "Scale...", 1, () -> one(In.image("img", 8, 37, 23, 1)));
        dlg("bin_stack", "Bin...", 1, () -> one(stk8()));
        dlg("bin_image", "Bin...", 1, () -> one(In.image("img", 8, 37, 23, 1)));
        dlg("histogram_stack", "Histogram", 1, () -> one(stk8()));
        dlg("histogram_image", "Histogram", 1, () -> one(In.image("img", 8, 37, 23, 1)));
        dlg("convert_to_mask_stack", "Convert to Mask", 1, () -> one(stk8()));
        dlg("make_binary_stack", "Make Binary", 1, () -> one(stk8()));
        dlg("process_all_invert", "Invert", 1, () -> one(stk8()));
        dlg("process_all_gaussian", "Gaussian Blur...", 2, () -> one(stk8()));
        dlg("convert_to_mask_stack_thresholded", "Convert to Mask", 1, () -> { ImagePlus s = stk8(); s.getProcessor().setThreshold(60, 255, ImageProcessor.NO_LUT_UPDATE); return one(s); });
        dlg("make_montage_composite_1z", "Make Montage...", 1, () -> one(In.hyper("comp", 16, 40, 30, 3, 1, 1, 2, true)));
        dlg("make_montage_hyper_1c", "Make Montage...", 1, () -> one(In.hyper("hz", 16, 40, 30, 1, 4, 1, 2, false)));
        dlg("process_all_add", "Add...", 2, () -> one(stk8()));
        dlg("process_all_invert_hyper_composite", "Invert", 1, () -> one(hyp16()));
        dlg("process_all_invert_hyper_color", "Invert", 1, () -> one(hypColor()));
        dlg("process_all_gaussian_hyper_color", "Gaussian Blur...", 2, () -> one(hypColor()));
        dlg("process_all_invert_rgbstack", "Invert", 1, () -> one(In.rgbStack("rgbstk", 37, 23, 3, 3)));
        dlg("image_calculator_stacks", "Image Calculator...", 2, () -> new ImagePlus[]{In.stack("s1", 8, 37, 23, 4, 1), In.stack("s2", 8, 37, 23, 4, 9)});
        dlg("image_calculator_stack_image", "Image Calculator...", 2, () -> new ImagePlus[]{In.image("img", 8, 37, 23, 9), In.stack("s1", 8, 37, 23, 4, 1)});
        dlg("analyze_particles_stack", "Analyze Particles...", 2, () -> { ImagePlus s = stk8(); return one(s); });
    }
}
