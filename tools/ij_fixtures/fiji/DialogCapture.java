import ij.*;
import ij.gui.*;
import ij.process.*;
import java.awt.*;
import java.awt.event.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.util.*;
import java.util.List;
import javax.swing.*;

/**
 * Records the GenericDialog / Swing structure of Fiji commands by RUNNING them (GUI mode, public AWT API only).
 * Usage: run_fiji.sh DialogCapture <out.json>. Local only, never shipped, never in CI.
 */
public class DialogCapture {
    static final List<String> entries = new ArrayList<>();
    /** Text fields of the GenericDialog being walked, by identity: numeric (getNumericFields) / string (getStringFields). */
    static final Set<Component> numericFields = Collections.newSetFromMap(new IdentityHashMap<>()), stringFields = Collections.newSetFromMap(new IdentityHashMap<>());

    static String q(String s) {
        if (s == null) return "null";
        StringBuilder b = new StringBuilder("\"");
        for (char c : s.toCharArray()) {
            switch (c) {
                case '"': b.append("\\\""); break;
                case '\\': b.append("\\\\"); break;
                case '\n': b.append("\\n"); break;
                case '\r': break;
                case '\t': b.append("\\t"); break;
                default: if (c < 32) b.append(String.format("\\u%04x", (int) c)); else b.append(c);
            }
        }
        return b.append('"').toString();
    }

    public static void main(String[] a) throws Exception {
        Locale.setDefault(Locale.ROOT);
        ImageJ ij = new ImageJ(ImageJ.NO_SHOW);
        // a[1] = "black=true|false" (default: the Prefs.blackBackground the clean user.home gives): the Fiji dialogs read it for their defaults
        for (int i = 1; i < a.length; i++) if (a[i].startsWith("black=")) Prefs.blackBackground = Boolean.parseBoolean(a[i].substring(6));
        boolean black = Prefs.blackBackground;
        Hashtable<String, String> cmds = Menus.getCommands();
        ImageProcessor ip = new ByteProcessor(64, 64);
        for (int i = 0; i < 4096; i++) ip.set(i, (i * 37 + (i / 64) * 11) & 255);
        ImagePlus imp = new ImagePlus("test", ip);
        imp.show();
        ImagePlus imp2 = new ImagePlus("test2", ip.duplicate());
        imp2.show();
        String[] commands = {
            "Auto Threshold", "Auto Local Threshold", "Enhance Local Contrast (CLAHE)", "Tubeness",
            "Anisotropic Diffusion 2D", "Directionality", "Analyze Skeleton (2D/3D)",
            "Local Thickness (complete process)", "Coloc 2"
        };
        StringBuilder menu = new StringBuilder("{");
        boolean first = true;
        for (String c : commands) {
            IJ.selectWindow("test");
            String cls = cmds.get(c);
            entries.add(q(c) + ":{\"class\":" + q(String.valueOf(cls)) + "," + capture(c, WindowManager.getImage("test")) + "}");
            if (!first) menu.append(','); first = false;
            menu.append(q(c)).append(':').append(q(menuPathOf(c)));
        }
        IJ.selectWindow("test");
        entries.add(q("Cell Counter") + ":{\"class\":" + q(String.valueOf(cmds.get("Cell Counter"))) + "," + captureWindow("Cell Counter", WindowManager.getImage("test")) + "}");
        menu.append(',').append(q("Cell Counter")).append(':').append(q(menuPathOf("Cell Counter")));
        // the SciJava command (Frangi) and the composite / 16-bit variants join the same document: one tool writes the whole file
        entries.add(q("Frangi Vesselness") + ":" + ModuleInfoCapture.frangiEntry());
        menu.append(',').append(q("Frangi Vesselness")).append(':').append(q("Process>Filters")).append('}');
        for (ImagePlus w : new ImagePlus[]{imp, imp2}) { w.changes = false; w.close(); }
        String variants = CompositeCapture.variants();
        List<String> notes = new ArrayList<>(Arrays.asList(
            "Captured by tools/ij_fixtures/fiji/DialogCapture.java (which calls CompositeCapture and ModuleInfoCapture) against the local Fiji install: public AWT/Swing/SciJava API only, no plugin code read. Rebuild: run_fiji.sh DialogCapture <out.json> [black=true|false].",
            "GenericDialog numeric text shows the default string the plugin put in the field (decimals visible = digits). Text fields of a GenericDialog are typed `numeric` / `string` by membership in getNumericFields() / getStringFields().",
            "The capture runs with a clean user.home (no IJ_Prefs): `prefsBlackBackground` is the Prefs.blackBackground in force (ImageJ 1.54p defaults it to true). fiji-dialogs.black-false.json is the same capture with Prefs.blackBackground=false: every dialog is identical, so the default of the `White objects on black background` checkbox (true) is Fiji's own, not the machine preference.",
            "Auto Threshold: the dialog default selection is \"Try all\"; the Fiji method list has no IJ_IsoData and calls MinError \"MinError(I)\"."));
        StringBuilder nj = new StringBuilder("[");
        for (int i = 0; i < notes.size(); i++) { if (i > 0) nj.append(','); nj.append(q(notes.get(i))); }
        nj.append(']');
        String json = "{\"fiji\":" + q(IJ.getFullVersion()) + ",\"prefsBlackBackground\":" + black + ",\"menuPaths\":" + menu + ",\"commands\":{" + String.join(",", entries) + "},\"variants\":" + variants + ",\"notes\":" + nj + "}";
        Files.write(Paths.get(a[0]), (json + "\n").getBytes(StandardCharsets.UTF_8));
        System.out.println("done");
        System.exit(0);
    }

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
            } else if (it.getLabel().equals(cmd)) return path;
        }
        return null;
    }

    static String capture(String cmd, ImagePlus imp) throws Exception {
        Thread t = new Thread(() -> { try { IJ.run(imp, cmd, ""); } catch (Throwable e) { e.printStackTrace(); } }, "run-" + cmd);
        t.setDaemon(true);
        Set<Window> before = new HashSet<>(Arrays.asList(Window.getWindows()));
        t.start();
        Dialog found = null;
        long end = System.currentTimeMillis() + 25000;
        while (System.currentTimeMillis() < end && found == null) {
            Thread.sleep(200);
            for (Window w : Window.getWindows()) {
                if (before.contains(w) || !w.isVisible()) continue;
                if (w instanceof Dialog) { found = (Dialog) w; break; }
            }
        }
        if (found == null) return "\"error\":\"no dialog\"";
        Thread.sleep(300);
        StringBuilder sb = new StringBuilder();
        sb.append("\"title\":").append(q(found.getTitle())).append(",\"components\":");
        List<String> comps = new ArrayList<>();
        numericFields.clear(); stringFields.clear();
        if (found instanceof GenericDialog) {
            GenericDialog gd = (GenericDialog) found;
            if (gd.getNumericFields() != null) numericFields.addAll(gd.getNumericFields());
            if (gd.getStringFields() != null) stringFields.addAll(gd.getStringFields());
        }
        walk(found, comps);
        numericFields.clear(); stringFields.clear();
        sb.append('[').append(String.join(",", comps)).append(']');
        final Dialog fd = found;
        SwingUtilities.invokeAndWait(() -> clickCancel(fd));
        t.join(5000);
        closeNew(before);
        return sb.toString();
    }

    static void clickCancel(Container c) {
        for (Component k : c.getComponents()) {
            if (k instanceof Button && ((Button) k).getLabel().equals("Cancel")) {
                k.dispatchEvent(new ActionEvent(k, ActionEvent.ACTION_PERFORMED, "Cancel"));
                return;
            }
            if (k instanceof Container) clickCancel((Container) k);
        }
    }

    static void closeNew(Set<Window> before) {
        for (Window w : Window.getWindows()) if (!before.contains(w) && w.isVisible()) w.dispose();
    }

    static void walk(Component c, List<String> out) {
        if (c instanceof Label) out.add("{\"t\":\"label\",\"text\":" + q(((Label) c).getText()) + "}");
        else if (c instanceof JLabel) out.add("{\"t\":\"label\",\"text\":" + q(((JLabel) c).getText()) + "}");
        else if (c instanceof TextField) {
            TextField tf = (TextField) c;
            out.add("{\"t\":\"" + (numericFields.contains(tf) ? "numeric" : stringFields.contains(tf) ? "string" : "text") + "\",\"value\":" + q(tf.getText()) + ",\"columns\":" + tf.getColumns() + "}");
        } else if (c instanceof Checkbox) {
            Checkbox cb = (Checkbox) c;
            out.add("{\"t\":\"checkbox\",\"label\":" + q(cb.getLabel()) + ",\"state\":" + cb.getState() + "}");
        } else if (c instanceof Choice) {
            Choice ch = (Choice) c;
            StringBuilder s = new StringBuilder("[");
            for (int i = 0; i < ch.getItemCount(); i++) { if (i > 0) s.append(','); s.append(q(ch.getItem(i))); }
            out.add("{\"t\":\"choice\",\"items\":" + s + "],\"selected\":" + q(ch.getSelectedItem()) + "}");
        } else if (c instanceof Scrollbar) {
            Scrollbar sb = (Scrollbar) c;
            out.add("{\"t\":\"slider\",\"min\":" + sb.getMinimum() + ",\"max\":" + sb.getMaximum() + ",\"value\":" + sb.getValue() + "}");
        } else if (c instanceof Button) out.add("{\"t\":\"button\",\"label\":" + q(((Button) c).getLabel()) + "}");
        else if (c instanceof TextArea) out.add("{\"t\":\"textarea\",\"text\":" + q(((TextArea) c).getText()) + "}");
        else if (c instanceof JButton) out.add("{\"t\":\"button\",\"label\":" + q(((JButton) c).getText()) + "}");
        else if (c instanceof JCheckBox) out.add("{\"t\":\"checkbox\",\"label\":" + q(((JCheckBox) c).getText()) + ",\"state\":" + ((JCheckBox) c).isSelected() + "}");
        else if (c instanceof JRadioButton) out.add("{\"t\":\"radio\",\"label\":" + q(((JRadioButton) c).getText()) + ",\"state\":" + ((JRadioButton) c).isSelected() + "}");
        else if (c instanceof JComboBox) {
            JComboBox<?> cb = (JComboBox<?>) c;
            StringBuilder s = new StringBuilder("[");
            for (int i = 0; i < cb.getItemCount(); i++) { if (i > 0) s.append(','); s.append(q(String.valueOf(cb.getItemAt(i)))); }
            out.add("{\"t\":\"choice\",\"items\":" + s + "],\"selected\":" + q(String.valueOf(cb.getSelectedItem())) + "}");
        } else if (c instanceof JTextField) out.add("{\"t\":\"text\",\"value\":" + q(((JTextField) c).getText()) + "}");
        else if (c instanceof JTable) {
            JTable tb = (JTable) c;
            StringBuilder s = new StringBuilder("[");
            for (int i = 0; i < tb.getColumnCount(); i++) { if (i > 0) s.append(','); s.append(q(tb.getColumnName(i))); }
            out.add("{\"t\":\"table\",\"columns\":" + s + "],\"rows\":" + tb.getRowCount() + "}");
        }
        if (c instanceof Container) {
            if (c instanceof JTabbedPane) {
                JTabbedPane tp = (JTabbedPane) c;
                for (int i = 0; i < tp.getTabCount(); i++) out.add("{\"t\":\"tab\",\"title\":" + q(tp.getTitleAt(i)) + "}");
            }
            for (Component k : ((Container) c).getComponents()) walk(k, out);
        }
    }

    static String captureWindow(String cmd, ImagePlus imp) throws Exception {
        Set<Window> before = new HashSet<>(Arrays.asList(Window.getWindows()));
        Thread t = new Thread(() -> { try { IJ.run(imp, cmd, ""); } catch (Throwable e) { e.printStackTrace(); } });
        t.setDaemon(true);
        t.start();
        Window found = null;
        long end = System.currentTimeMillis() + 20000;
        while (System.currentTimeMillis() < end && found == null) {
            Thread.sleep(300);
            for (Window w : Window.getWindows())
                if (!before.contains(w) && w.isVisible() && w instanceof Frame && !(w instanceof ImageWindow)) { found = w; break; }
        }
        if (found == null) return "\"error\":\"no window\"";
        Thread.sleep(1000);
        List<String> comps = new ArrayList<>();
        walk(found, comps);
        String title = ((Frame) found).getTitle();
        closeNew(before);
        return "\"title\":" + q(title) + ",\"components\":[" + String.join(",", comps) + "]";
    }
}
