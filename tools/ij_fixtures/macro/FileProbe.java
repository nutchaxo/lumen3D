package ij.macro;

import ij.ImagePlus;
import ij.ImageStack;
import ij.WindowManager;

import java.io.ByteArrayOutputStream;
import java.io.PrintStream;
import java.lang.reflect.Field;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Lives in package ij.macro (the jar is not sealed) for the same reason as MacroProbe: Interpreter.errorMessage /
 * lineNumber are package-private, and Interpreter.finishUp() (package-private) is where the images of a macro still
 * exist, because it drops the batch-mode table right after. Run by FileGolden, once per case, in a class loader of
 * its own (fresh ImageJ statics).
 *
 * runFlat returns JDK types only: Object[] { events, error, line, thrown, images } with
 *   events = List<String[]> { kind, text, site }  kind = log | showMessage | error | stdout | errorDialog | handleException,
 *                                                site = "<class>:<line>" of the caller of IJ.error / IJ.showMessage
 *   images = List<String[]> { title, dir, filename, w, h, c, z, t, bitDepth, sha256 }
 */
public class FileProbe {

    static class Cap extends Interpreter {
        List<String[]> images;
        @Override void finishUp() {
            if (images == null) images = snapshot();
            super.finishUp();
        }
    }

    static Object get(Object o, String name) throws Exception {
        Field f = Interpreter.class.getDeclaredField(name);
        f.setAccessible(true);
        return f.get(o);
    }

    /** The images a macro leaves behind: its batch-mode table plus the temporary current image (what a headless
     *  ImagePlus.show() makes current), each once, in creation order. */
    static List<String[]> snapshot() {
        Map<Integer, ImagePlus> m = new LinkedHashMap<>();
        try {
            int[] ids = Interpreter.getBatchModeImageIDs();
            for (int id : ids) { ImagePlus imp = Interpreter.getBatchModeImage(id); if (imp != null) m.put(imp.getID(), imp); }
            int[] wids = WindowManager.getIDList();
            if (wids != null) for (int id : wids) { ImagePlus imp = WindowManager.getImage(id); if (imp != null) m.put(imp.getID(), imp); }
            ImagePlus cur = WindowManager.getCurrentImage();
            if (cur != null && !m.containsKey(cur.getID())) m.put(cur.getID(), cur);
        } catch (Throwable t) { /* no images */ }
        List<String[]> out = new ArrayList<>();
        for (ImagePlus imp : m.values()) {
            ij.io.FileInfo fi = imp.getOriginalFileInfo();
            String[] d = describe(imp);
            out.add(new String[] { imp.getTitle(), fi != null && fi.directory != null ? fi.directory : "",
                fi != null && fi.fileName != null ? fi.fileName : "", d[0], d[1], d[2], d[3], d[4], d[5], d[6] });
        }
        return out;
    }

    /** { w, h, c, z, t, bitDepth, sha256 }: the pixel digest of the contract (FILES.md 15.3): SHA-256 of the ASCII header
     *  "w,h,c,z,t,bitDepth\n" then every plane in stack order; 8-bit bytes, 16-bit LE u16, 32-bit LE IEEE bits, RGB = R,G,B. */
    public static String[] describe(ImagePlus imp) {
        int w = imp.getWidth(), h = imp.getHeight(), c = imp.getNChannels(), z = imp.getNSlices(), t = imp.getNFrames();
        int bd = imp.getBitDepth();
        try {
            MessageDigest md = MessageDigest.getInstance("SHA-256");
            md.update((w + "," + h + "," + c + "," + z + "," + t + "," + bd + "\n").getBytes(StandardCharsets.US_ASCII));
            ImageStack st = imp.getStack();
            for (int i = 1; i <= st.getSize(); i++) {
                Object px = st.getPixels(i);
                if (px instanceof byte[]) md.update((byte[]) px);
                else if (px instanceof short[]) {
                    short[] s = (short[]) px;
                    ByteBuffer bb = ByteBuffer.allocate(s.length * 2).order(ByteOrder.LITTLE_ENDIAN);
                    for (short v : s) bb.putShort(v);
                    md.update(bb.array());
                } else if (px instanceof float[]) {
                    float[] f = (float[]) px;
                    ByteBuffer bb = ByteBuffer.allocate(f.length * 4).order(ByteOrder.LITTLE_ENDIAN);
                    for (float v : f) bb.putInt(Float.floatToRawIntBits(v));
                    md.update(bb.array());
                } else if (px instanceof int[]) {
                    int[] p = (int[]) px;
                    byte[] b = new byte[p.length * 3];
                    for (int k = 0; k < p.length; k++) { b[3 * k] = (byte) (p[k] >> 16); b[3 * k + 1] = (byte) (p[k] >> 8); b[3 * k + 2] = (byte) p[k]; }
                    md.update(b);
                }
            }
            return new String[] { "" + w, "" + h, "" + c, "" + z, "" + t, "" + bd, hex(md.digest()) };
        } catch (Exception e) { throw new IllegalStateException(e); }
    }

    public static String hex(byte[] b) {
        StringBuilder s = new StringBuilder();
        for (byte x : b) s.append(String.format("%02x", x & 0xff));
        return s.toString();
    }

    /** The log, as ImageJ with a window shows it: every IJ.log call becomes a "log" event (and still goes to the real panel, so
     *  selectWindow("Log") / saveAs("Text") see it). IJ.log hands the panel the text it was given, with a space appended when that
     *  ends with a line break (so the panel does not drop it); the event carries the text IJ.log was given, as the headless println does. */
    static class Rec extends ij.text.TextPanel {
        final List<String[]> events;
        Rec(List<String[]> events) { this.events = events; }
        @Override public void append(String data) {
            String raw = data;
            if (data.equals("\n \n ")) raw = "\n\n";
            else if (data.endsWith("\n \n ")) raw = data.substring(0, data.length() - 4) + "\n\n";
            else if (data.endsWith("\n ")) raw = data.substring(0, data.length() - 1);
            synchronized (events) { events.add(new String[] { "log", raw, "" }); }
            super.append(data);
        }
    }

    /** A running ImageJ (what Fiji is): the dialogs are real, the Log is a window. NO_SHOW keeps the main frame hidden; the Log window is
     *  made here, hidden, so that selectWindow("Log") finds it, and its panel is replaced by a recording one. */
    static void startInstance(List<String[]> events, Thread macroThread) throws Exception {
        new ij.ImageJ(ij.ImageJ.NO_SHOW);
        ij.text.TextWindow w = new ij.text.TextWindow("Log", "", 400, 250);
        Rec rec = new Rec(events);
        Field tp = ij.text.TextWindow.class.getDeclaredField("textPanel");
        tp.setAccessible(true);
        tp.set(w, rec);
        Field lp = ij.IJ.class.getDeclaredField("logPanel");
        lp.setAccessible(true);
        lp.set(null, rec);
        w.setVisible(false);
        watchDialogs(events, macroThread);
    }

    /** Dialogs are modal (the macro thread waits for them): a daemon thread records what each shows and closes it, as DialogKeys does.
     *  The error box of a failed macro ("Macro Error", or "No Image" when ImageJ says there is none) is kind errorDialog (as the headless stand-in reports it); a message box is
     *  kind error when the macro thread is inside IJ.error, else showMessage, with its exact title in the third field ("T:" prefix);
     *  a file chooser is kind "filedialog", which the runner treats as a case that must not exist (a picker has no golden). */
    static void watchDialogs(List<String[]> events, Thread macroThread) {
        Thread t = new Thread(() -> {
            java.util.Set<java.awt.Window> seen = java.util.Collections.newSetFromMap(new java.util.IdentityHashMap<>());
            while (true) {
                try { Thread.sleep(20); } catch (InterruptedException e) { return; }
                for (java.awt.Window w : java.awt.Window.getWindows()) {
                    if (!(w instanceof java.awt.Dialog) || !w.isShowing() || !seen.add(w)) continue;
                    String title = ((java.awt.Dialog) w).getTitle();
                    StringBuilder text = new StringBuilder();
                    collect(w, text);
                    boolean inError = false;
                    for (StackTraceElement e : macroThread.getStackTrace())
                        if (e.getClassName().equals("ij.IJ") && e.getMethodName().equals("error")) inError = true;
                    synchronized (events) {
                        if (w instanceof java.awt.FileDialog) events.add(new String[] { "filedialog", title, "" });
                        else if ("Macro Error".equals(title) || "No Image".equals(title)) events.add(new String[] { "errorDialog", text.toString(), "" });
                        else events.add(new String[] { inError ? "error" : "showMessage", text.toString(), "T:" + title });
                    }
                    java.awt.EventQueue.invokeLater(w::dispose);
                }
            }
        });
        t.setDaemon(true);
        t.start();
    }

    static void collect(java.awt.Component c, StringBuilder out) {
        if (c instanceof ij.gui.MultiLineLabel) {
            try {
                Field f = ij.gui.MultiLineLabel.class.getDeclaredField("lines");
                f.setAccessible(true);
                String[] lines = (String[]) f.get(c);
                int n = lines.length;
                try { Field nl = ij.gui.MultiLineLabel.class.getDeclaredField("num_lines"); nl.setAccessible(true); n = nl.getInt(c); } catch (Exception e) { }
                for (int i = 0; i < n && i < lines.length; i++) { if (i > 0) out.append((char) 10); out.append(lines[i]); }
            } catch (Exception e) { out.append("<unreadable: ").append(e).append('>'); }
        } else if (c instanceof java.awt.Label) out.append(((java.awt.Label) c).getText());
        if (c instanceof java.awt.Container) for (java.awt.Component k : ((java.awt.Container) c).getComponents()) collect(k, out);
    }

    public static Object[] runFlat(String code) {
        List<String[]> events = new ArrayList<>();
        String error = null, thrown = null;
        int line = -1;
        PrintStream old = System.out;
        Cap in = new Cap();
        try {
            if (!java.awt.GraphicsEnvironment.isHeadless()) startInstance(events, Thread.currentThread());
            System.setOut(new PrintStream(new ByteArrayOutputStream(), true, "UTF-8") {
                private void rec(String text) {
                    String kind = "stdout", site = "";
                    StackTraceElement[] st = Thread.currentThread().getStackTrace();
                    boolean error = false;
                    for (StackTraceElement e : st) {
                        if (e.getClassName().equals("ij.gui.GenericDialog")) { kind = "errorDialog"; break; }
                        if (e.getClassName().equals("ij.IJ")) {
                            String mn = e.getMethodName();
                            if (kind.equals("stdout") || mn.equals("handleException")) kind = mn;
                            if (mn.equals("error")) error = true;
                        }
                    }
                    if (kind.equals("showMessage") && error) kind = "error";
                    if (kind.equals("showMessage") || kind.equals("error")) {
                        int i = 0;
                        while (i < st.length && !(st[i].getClassName().equals("ij.IJ") && st[i].getMethodName().equals("showMessage"))) i++;
                        while (i < st.length && st[i].getClassName().equals("ij.IJ")
                            && (st[i].getMethodName().equals("showMessage") || st[i].getMethodName().equals("error"))) i++;
                        if (i < st.length) site = st[i].getClassName() + ":" + st[i].getLineNumber();
                    }
                    synchronized (events) { events.add(new String[] { kind, text, site }); }
                }
                @Override public void println(String x) { rec(x); }
                @Override public void println(Object x) { rec(String.valueOf(x)); }
                @Override public void print(String x) { rec(x); }
            });
            try { in.run(code); } catch (Throwable t) {
                thrown = t.getClass().getName() + ": " + t.getMessage();
                if (t.getMessage() == null || !t.getMessage().contains("Macro canceled")) {   // where an unexpected exception came from
                    StringBuilder w = new StringBuilder(thrown);
                    StackTraceElement[] st = t.getStackTrace();
                    for (int i = 0; i < Math.min(40, st.length); i++) w.append((char) 10).append("    at ").append(st[i]);
                    thrown = w.toString();
                }
            }
            if (in.wasError()) {
                error = (String) get(in, "errorMessage");
                line = (Integer) get(in, "lineNumber");
                if (error == null) error = "<wasError without message>";
            }
        } catch (Exception e) {
            thrown = "probe: " + e;
        } finally {
            System.out.flush();
            System.setOut(old);
        }
        List<String[]> images = in.images != null ? in.images : snapshot();
        return new Object[] { events, error, Integer.valueOf(line), thrown, images };
    }
}
