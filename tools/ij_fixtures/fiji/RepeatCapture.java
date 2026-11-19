import ij.*;
import ij.gui.*;
import ij.process.*;
import java.awt.*;
import java.awt.event.ActionEvent;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.util.*;
import java.util.List;
import javax.swing.SwingUtilities;

/** Does Process > Repeat Command re-show the dialog with the last values? (ImageJ 1.54p, GUI mode.) Usage: run_fiji.sh RepeatCapture <out.json> */
public class RepeatCapture {
    static Dialog waitDialog(Set<Window> before, long ms) throws Exception {
        long end = System.currentTimeMillis() + ms;
        while (System.currentTimeMillis() < end) {
            Thread.sleep(150);
            for (Window w : Window.getWindows()) if (!before.contains(w) && w.isVisible() && w instanceof GenericDialog) return (Dialog) w;
        }
        return null;
    }

    static void click(Container c, String label) {
        for (Component k : c.getComponents()) {
            if (k instanceof Button && ((Button) k).getLabel().trim().equals(label)) { k.dispatchEvent(new ActionEvent(k, ActionEvent.ACTION_PERFORMED, label)); return; }
            if (k instanceof Container) click((Container) k, label);
        }
    }

    public static void main(String[] a) throws Exception {
        Locale.setDefault(Locale.ROOT);
        new ImageJ(ImageJ.NO_SHOW);
        ImageProcessor ip = new ByteProcessor(64, 64);
        for (int i = 0; i < 4096; i++) ip.set(i, (i * 37) & 255);
        ImagePlus imp = new ImagePlus("rep", ip);
        imp.show();
        List<String> out = new ArrayList<>();
        // 1. Gaussian Blur... through the menu executer; answer the dialog with sigma 3.5
        Set<Window> before = new HashSet<>(Arrays.asList(Window.getWindows()));
        new Executer("Gaussian Blur...", imp);
        Dialog d1 = waitDialog(before, 15000);
        String first = d1 == null ? "none" : DialogCapture.q(d1.getTitle());
        List<String> comps1 = new ArrayList<>();
        if (d1 != null) {
            for (Component k : ((Container) d1).getComponents()) { }
            TextField tf = findField(d1);
            if (tf != null) { tf.setText("3.5"); }
            final Dialog fd = d1;
            SwingUtilities.invokeAndWait(() -> click(fd, "OK"));
            Thread.sleep(1500);
        }
        // 2. Repeat Command
        before = new HashSet<>(Arrays.asList(Window.getWindows()));
        new Executer("Repeat Command", imp);
        Dialog d2 = waitDialog(before, 15000);
        List<String> comps = new ArrayList<>();
        if (d2 != null) { DialogCapture.walk(d2, comps); final Dialog fd = d2; SwingUtilities.invokeAndWait(() -> click(fd, "Cancel")); }
        // 3. Undo and Close are not remembered. Every command runs through the Executer and its thread is joined: no sleeps.
        int beforeInvert = imp.getProcessor().get(1);
        sync(imp, "Invert");
        int afterInvert = imp.getProcessor().get(1);
        sync(imp, "Undo");
        int afterUndo = imp.getProcessor().get(1);
        sync(imp, "Repeat Command");          // the last REMEMBERED command: Invert, not Undo
        int afterRepeat = imp.getProcessor().get(1);
        // Close: invert image A, close A, repeat on image B. B inverted => Invert is still the remembered command (Close is not remembered).
        ImageProcessor ipB = new ByteProcessor(64, 64);
        for (int i = 0; i < 4096; i++) ipB.set(i, (i * 37) & 255);
        ImagePlus impB = new ImagePlus("repB", ipB);
        impB.show();
        ImagePlus impA = new ImagePlus("repA", ipB.duplicate());
        impA.show();
        sync(impA, "Invert");
        impA.changes = false;
        sync(impA, "Close");
        boolean closed = WindowManager.getImage("repA") == null;
        int bBefore = impB.getProcessor().get(1);
        sync(impB, "Repeat Command");
        int bAfter = impB.getProcessor().get(1);
        String json = "{\"imagej\":\"1.54p\",\"firstDialogTitle\":" + first + ",\"repeatDialogShown\":" + (d2 != null)
            + ",\"repeatDialogTitle\":" + (d2 == null ? "null" : DialogCapture.q(d2.getTitle())) + ",\"repeatDialogComponents\":[" + String.join(",", comps) + "]"
            + ",\"undoNotRemembered\":{\"pixel1BeforeInvert\":" + beforeInvert + ",\"afterInvert\":" + afterInvert + ",\"afterUndo\":" + afterUndo + ",\"afterRepeatAfterUndo\":" + afterRepeat + "}"
            + ",\"closeNotRemembered\":{\"imageAClosed\":" + closed + ",\"pixel1BBeforeRepeat\":" + bBefore + ",\"pixel1BAfterRepeat\":" + bAfter + ",\"repeatReranInvert\":" + (bAfter == 255 - bBefore) + "}}";
        Files.write(Paths.get(a[0]), (json + "\n").getBytes(StandardCharsets.UTF_8));
        System.exit(0);
    }

    /** Runs a command through the menu's own Executer (IJ.run does not record the command as repeatable) and joins the thread it starts (named after the command). */
    static void sync(ImagePlus imp, String cmd) throws Exception {
        new Executer(cmd, imp);
        Thread t = null;
        for (Thread x : Thread.getAllStackTraces().keySet()) if (x.getName().equals(cmd) && x.isAlive()) t = x;
        if (t != null) { t.join(20000); if (t.isAlive()) throw new IllegalStateException(cmd + " did not finish (a dialog?)"); }
    }

    static TextField findField(Container c) {
        for (Component k : c.getComponents()) {
            if (k instanceof TextField) return (TextField) k;
            if (k instanceof Container) { TextField t = findField((Container) k); if (t != null) return t; }
        }
        return null;
    }
}
