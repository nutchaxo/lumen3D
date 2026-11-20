package ij.macro;

import java.io.ByteArrayOutputStream;
import java.io.PrintStream;
import java.lang.reflect.Field;

/**
 * Lives in package ij.macro (the jar is not sealed) to read the package-private
 * Interpreter.lineNumber / errorMessage that showError() would otherwise only put in a dialog.
 */
public class MacroProbe {
    public static class Result {
        /** [kind, text]: kind = "log" for IJ.log (what print() writes), else the ij.IJ method that wrote it
         *  (showMessage, error, ...: dialogs that headless ImageJ prints to stdout), "stdout" if outside ij.IJ. */
        public java.util.List<String[]> events = new java.util.ArrayList<>();
        public String error;      // exact message, null if the macro ended normally
        public int line = -1;
        public String source;     // the source line text ImageJ shows under the message
        public String thrown;     // unexpected Java exception, null normally
    }

    static Object get(Object o, String name) throws Exception {
        Field f = Interpreter.class.getDeclaredField(name);
        f.setAccessible(true);
        return f.get(o);
    }

    /** Same as {@link #run} but flat (JDK types only) so a caller that loads this class in a private
     *  class loader, to get fresh ImageJ statics for every macro, needs no shared types:
     *  { events: List<String[]>, error, line (Integer), source, thrown }. */
    public static Object[] runFlat(String code) {
        Result r = run(code);
        return new Object[] { r.events, r.error, Integer.valueOf(r.line), r.source, r.thrown };
    }

    /** Text of the Log window after the macro (what getInfo("log") returns in Fiji): a real
     *  ij.text.TextPanel is installed as IJ.logPanel, so IJ.log applies its own "\Clear",
     *  "\Update:", "\Heading:"... commands and line splitting. Needs a non-headless JVM (the
     *  panel builds AWT scrollbars); the panel is never put in a window, nothing is shown. */
    public static String runLogWindow(String code) {
        PrintStream old = System.out;
        try {
            System.setOut(new PrintStream(new ByteArrayOutputStream(), true, "UTF-8"));
            Field f = ij.IJ.class.getDeclaredField("logPanel");
            f.setAccessible(true);
            ij.text.TextPanel tp = new ij.text.TextPanel();
            f.set(null, tp);
            try { new Interpreter().run(code); } catch (Throwable t) { }
            Object cur = f.get(null);   // "\Closed" drops the panel
            return cur == null ? null : ((ij.text.TextPanel) cur).getText();
        } catch (Exception e) {
            return "probe: " + e;
        } finally {
            System.setOut(old);
        }
    }

    public static Result run(String code) {
        Result r = new Result();
        PrintStream old = System.out;
        final java.util.List<String[]> ev = r.events;
        try {
            System.setOut(new PrintStream(new ByteArrayOutputStream(), true, "UTF-8") {
                private void rec(String text) {
                    String kind = "stdout";
                    for (StackTraceElement e : Thread.currentThread().getStackTrace()) {
                        if (e.getClassName().equals("ij.gui.GenericDialog")) { kind = "errorDialog"; break; }
                        if (e.getClassName().equals("ij.IJ")) {
                            if (kind.equals("stdout") || e.getMethodName().equals("handleException")) kind = e.getMethodName();
                        }
                    }
                    ev.add(new String[] { kind, text });
                }
                @Override public void println(String x) { rec(x); }
                @Override public void println(Object x) { rec(String.valueOf(x)); }
                @Override public void print(String x) { rec(x); }
            });
            Interpreter in = new Interpreter();
                        try {
                in.run(code);
            } catch (Throwable t) {
                r.thrown = t.getClass().getName() + ": " + t.getMessage();
            }
            if (in.wasError()) {
                r.error = (String) get(in, "errorMessage");
                r.line = (Integer) get(in, "lineNumber");
                try {
                    java.lang.reflect.Method m = Interpreter.class.getDeclaredMethod("getErrorLine");
                    m.setAccessible(true);
                    r.source = (String) m.invoke(in);
                } catch (Throwable t) { }
                if (r.error == null) r.error = "<wasError without message>";
            }
        } catch (Exception e) {
            r.thrown = "probe: " + e;
        } finally {
            System.out.flush();
            System.setOut(old);
        }
        return r;
    }
}
