import java.io.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.util.*;
import java.util.concurrent.*;
import java.util.regex.*;

/**
 * ImageJ 1.54p macro-language oracle (pure language: no image, no GUI, no file).
 * Usage: MacroGolden <corpusDir> <out.json>
 * Runs corpus/<group>/<case>.ijm through ij.macro.Interpreter (headless) and writes
 *   { "<group>/<case>": { "log": [...print() lines...],
 *                         "error": null | {"message","line","excerpt"?,"calledFrom"?,"silent"?},
 *                         "exited"?: true, "dialogs"?: [{"kind","text","afterLog"}],
 *                         "logWindow"?: "..." } }
 * Each case runs in a fresh class loader (fresh ImageJ statics): no case can depend on another.
 * The cases of the group "log-window" also run once more in a child JVM that is NOT headless, with a
 * real ij.text.TextPanel as the Log, and record its final text ("logWindow" = getInfo("log")).
 * Keys sorted, UTF-8, no clock: two runs give identical bytes.
 * Local only: never shipped, never run in CI.
 */
@SuppressWarnings("unchecked")
public class MacroGolden {
    static final String LOG_WINDOW_GROUP = "log-window";
    static final int CASE_TIMEOUT_S = 60;   // a case takes milliseconds; generous so a loaded machine never aborts a run

    public static void main(String[] args) throws Exception {
        Locale.setDefault(Locale.ROOT);
        if (args.length == 3 && args[0].equals("--log-window")) { logWindowPass(Paths.get(args[1]), Paths.get(args[2])); return; }
        System.setProperty("java.awt.headless", "true");
        Path corpus = Paths.get(args[0]).toAbsolutePath().normalize();
        Path out = Paths.get(args[1]).toAbsolutePath().normalize();
        TreeMap<String, Path> cases = new TreeMap<>();
        try (DirectoryStream<Path> groups = Files.newDirectoryStream(corpus)) {
            for (Path g : groups) {
                if (!Files.isDirectory(g)) continue;
                try (DirectoryStream<Path> fs = Files.newDirectoryStream(g, "*.ijm")) {
                    for (Path f : fs) {
                        String n = f.getFileName().toString();
                        cases.put(g.getFileName() + "/" + n.substring(0, n.length() - 4), f);
                    }
                }
            }
        }
        Map<String, String> logWindows = runLogWindowChild(cases);
        ExecutorService ex = Executors.newSingleThreadExecutor(r -> { Thread t = new Thread(r); t.setDaemon(true); return t; });
        StringBuilder sb = new StringBuilder("{\n");
        boolean first = true;
        int suspicious = 0;
        for (Map.Entry<String, Path> e : cases.entrySet()) {
            String code = new String(Files.readAllBytes(e.getValue()), StandardCharsets.UTF_8);
            Future<Object[]> fu = ex.submit(() -> runIsolated(code));
            Object[] o;
            try { o = fu.get(CASE_TIMEOUT_S, TimeUnit.SECONDS); }
            catch (TimeoutException t) { System.err.println("TIMEOUT " + e.getKey()); System.exit(2); return; }
            Res r = new Res();
            r.events = (List<String[]>) o[0]; r.error = (String) o[1]; r.line = (Integer) o[2]; r.source = (String) o[3]; r.thrown = (String) o[4];
            // A Java exception text inside a message (PatternSyntaxException...) carries System.lineSeparator():
            // recorded as "\n" so the golden does not depend on the OS that produced it.
            String rawError = r.error;
            if (r.error != null) r.error = r.error.replace("\r\n", "\n");
            boolean exited = r.error == null && r.thrown != null && r.thrown.contains("Macro canceled");
            if (r.thrown != null && !exited && r.error == null) {
                System.err.println("UNEXPECTED JAVA EXCEPTION " + e.getKey() + ": " + r.thrown);
                suspicious++;
            }
            // The top-level error's dialog is the LAST errorDialog whose text starts with "<message> in line <n>\n"
            // (an eval error with the same text may come earlier: that one stays a dialog). Its text is
            //   <message> in line <n>\n <stack> " \n" <excerpt>,  stack = ("\t\t(called from line <k>)\n")*, innermost caller first.
            int topDialog = -1;
            if (r.error != null) {
                String prefix = rawError + " in line " + r.line + "\n";
                for (int i = 0; i < r.events.size(); i++) {
                    String[] ev = r.events.get(i);
                    if (ev[0].equals("errorDialog") && ev[1].startsWith(prefix)) topDialog = i;
                }
            }
            String excerpt = null;
            List<Integer> calledFrom = new ArrayList<>();
            if (topDialog >= 0) {
                String rest = r.events.get(topDialog)[1].substring((rawError + " in line " + r.line + "\n").length());
                int cut = rest.indexOf(" \n");
                String stack = cut >= 0 ? rest.substring(0, cut) : "";
                excerpt = cut >= 0 ? rest.substring(cut + 2) : rest;
                Matcher m = Pattern.compile("\t\t\\(called from line (-?\\d+)\\)\n").matcher(stack);
                int at = 0;
                while (m.find()) {
                    if (m.start() != at) throw new IllegalStateException("unparsed error stack in " + e.getKey() + ": " + stack);
                    calledFrom.add(Integer.valueOf(m.group(1)));
                    at = m.end();
                }
                if (at != stack.length()) throw new IllegalStateException("unparsed error stack in " + e.getKey() + ": " + stack);
            }
            List<String> lines = new ArrayList<>();
            List<String[]> dialogs = new ArrayList<>();
            for (int i = 0; i < r.events.size(); i++) {
                String[] ev = r.events.get(i);
                if (ev[0].equals("handleException")) {   // a headless artifact (an error in a nested macro tries to open a dialog): not language behaviour
                    System.err.println("HEADLESS ARTIFACT, remove or rewrite this case: " + e.getKey());
                    suspicious++;
                }
                if (i == topDialog) continue;   // the top-level error: already in "error"
                if (ev[0].equals("log")) lines.add(ev[1]); else dialogs.add(new String[] { ev[0], ev[1], String.valueOf(lines.size()) });
            }
            if (!first) sb.append(",\n");
            first = false;
            sb.append("  ").append(q(e.getKey())).append(": {\"log\": [");
            for (int i = 0; i < lines.size(); i++) { if (i > 0) sb.append(", "); sb.append(q(lines.get(i))); }
            sb.append("], \"error\": ");
            if (r.error == null) sb.append("null");
            else {
                sb.append("{\"message\": ").append(q(r.error)).append(", \"line\": ").append(r.line);
                if (topDialog < 0) sb.append(", \"silent\": true");   // raised once the program had ended (done): ImageJ shows nothing, the macro just stops
                else {
                    sb.append(", \"excerpt\": ").append(q(excerpt));
                    if (!calledFrom.isEmpty()) {
                        sb.append(", \"calledFrom\": [");
                        for (int i = 0; i < calledFrom.size(); i++) { if (i > 0) sb.append(", "); sb.append(calledFrom.get(i)); }
                        sb.append("]");
                    }
                }
                sb.append("}");
            }
            if (exited) sb.append(", \"exited\": true");
            if (!dialogs.isEmpty()) {   // what headless ImageJ prints instead of a dialog; afterLog = log lines already written
                sb.append(", \"dialogs\": [");
                for (int i = 0; i < dialogs.size(); i++) {
                    String[] d = dialogs.get(i);
                    if (i > 0) sb.append(", ");
                    sb.append("{\"kind\": ").append(q(d[0])).append(", \"text\": ").append(q(d[1])).append(", \"afterLog\": ").append(d[2]).append("}");
                }
                sb.append("]");
            }
            if (logWindows.containsKey(e.getKey())) {
                String w = logWindows.get(e.getKey());
                sb.append(", \"logWindow\": ").append(w == null ? "null" : q(w));
            }
            sb.append("}");
        }
        sb.append("\n}\n");
        Files.createDirectories(out.getParent());
        Files.write(out, sb.toString().getBytes(StandardCharsets.UTF_8));
        System.out.println("cases: " + cases.size() + ", unexpected java exceptions: " + suspicious + " -> " + out);
        System.exit(suspicious == 0 ? 0 : 3);
    }

    static class Res { List<String[]> events; String error, source, thrown; int line; }

    /** Runs the "log-window" cases in a child JVM that is not headless (ij.text.TextPanel builds AWT
     *  scrollbars). Returns key -> Log text (null when the macro closed the Log with "\\Closed"). */
    static Map<String, String> runLogWindowChild(TreeMap<String, Path> cases) throws Exception {
        Map<String, String> res = new TreeMap<>();
        StringBuilder list = new StringBuilder();
        for (Map.Entry<String, Path> e : cases.entrySet())
            if (e.getKey().startsWith(LOG_WINDOW_GROUP + "/")) list.append(e.getKey()).append('\t').append(e.getValue()).append('\n');
        if (list.length() == 0) return res;
        Path in = Files.createTempFile("macro-logwin", ".lst"), out = Files.createTempFile("macro-logwin", ".out");
        try {
            Files.write(in, list.toString().getBytes(StandardCharsets.UTF_8));
            List<String> cmd = new ArrayList<>(Arrays.asList(
                Paths.get(System.getProperty("java.home"), "bin", "java").toString(),
                "-Djava.awt.headless=false", "-Dfile.encoding=UTF-8"));
            if (System.getProperty("macro.stubdir") != null) cmd.add("-Dmacro.stubdir=" + System.getProperty("macro.stubdir"));
            cmd.addAll(Arrays.asList("-cp", System.getProperty("java.class.path"), "MacroGolden", "--log-window", in.toString(), out.toString()));
            Process p = new ProcessBuilder(cmd).inheritIO().start();
            if (!p.waitFor(300, TimeUnit.SECONDS)) { p.destroyForcibly(); throw new IllegalStateException("log-window pass timed out"); }
            if (p.exitValue() != 0) throw new IllegalStateException("log-window pass failed: exit " + p.exitValue());
            // One record per case: key \t 0|1 (null?) \t text with \\ \n \t escaped.
            for (String rec : new String(Files.readAllBytes(out), StandardCharsets.UTF_8).split("\n")) {
                if (rec.isEmpty()) continue;
                String[] f = rec.split("\t", 3);
                res.put(f[0], f[1].equals("1") ? null : unesc(f[2]));
            }
        } finally { Files.deleteIfExists(in); Files.deleteIfExists(out); }
        return res;
    }

    static void logWindowPass(Path list, Path out) throws Exception {
        if (java.awt.GraphicsEnvironment.isHeadless()) throw new IllegalStateException("the log-window pass needs a display (non-headless AWT)");
        ExecutorService ex = Executors.newSingleThreadExecutor(r -> { Thread t = new Thread(r); t.setDaemon(true); return t; });
        StringBuilder sb = new StringBuilder();
        for (String rec : new String(Files.readAllBytes(list), StandardCharsets.UTF_8).split("\n")) {
            if (rec.isEmpty()) continue;
            String[] f = rec.split("\t", 2);
            String code = new String(Files.readAllBytes(Paths.get(f[1])), StandardCharsets.UTF_8);
            Future<String> fu = ex.submit(() -> {
                try (java.net.URLClassLoader cl = isolatedLoader()) {
                    return (String) cl.loadClass("ij.macro.MacroProbe").getMethod("runLogWindow", String.class).invoke(null, code);
                }
            });
            String w;
            try { w = fu.get(CASE_TIMEOUT_S, TimeUnit.SECONDS); }
            catch (TimeoutException t) { System.err.println("TIMEOUT (log window) " + f[0]); System.exit(2); return; }
            if (w != null && w.startsWith("probe: ")) { System.err.println("LOG WINDOW PROBE FAILED " + f[0] + ": " + w); System.exit(4); }
            sb.append(f[0]).append('\t').append(w == null ? "1\t" : "0\t" + esc(w)).append('\n');
        }
        Files.write(out, sb.toString().getBytes(StandardCharsets.UTF_8));
        System.exit(0);
    }

    static String esc(String s) { return s.replace("\\", "\\\\").replace("\n", "\\n").replace("\r", "\\r").replace("\t", "\\t"); }
    static String unesc(String s) {
        StringBuilder b = new StringBuilder();
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            if (c != '\\' || i + 1 >= s.length()) { b.append(c); continue; }
            char d = s.charAt(++i);
            b.append(d == 'n' ? '\n' : d == 'r' ? '\r' : d == 't' ? '\t' : d);
        }
        return b.toString();
    }

    static java.net.URLClassLoader isolatedLoader() throws Exception {
        List<java.net.URL> urls = new ArrayList<>();
        String stub = System.getProperty("macro.stubdir");
        if (stub != null) urls.add(new File(stub).toURI().toURL());
        for (String p : System.getProperty("java.class.path").split(File.pathSeparator)) urls.add(new File(p).toURI().toURL());
        return new java.net.URLClassLoader(urls.toArray(new java.net.URL[0]), ClassLoader.getPlatformClassLoader());
    }

    /** Every macro runs against its own copy of the ImageJ classes: its static state (messages shown
     *  once, List.*, random generators, batch mode...) cannot leak from one case into the next. */
    static Object[] runIsolated(String code) throws Exception {
        try (java.net.URLClassLoader cl = isolatedLoader()) {
            return (Object[]) cl.loadClass("ij.macro.MacroProbe").getMethod("runFlat", String.class).invoke(null, code);
        }
    }

    static String q(String s) {
        StringBuilder b = new StringBuilder("\"");
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            switch (c) {
                case '"': b.append("\\\""); break;
                case '\\': b.append("\\\\"); break;
                case '\n': b.append("\\n"); break;
                case '\r': b.append("\\r"); break;
                case '\t': b.append("\\t"); break;
                default:
                    if (c < 0x20 || (c >= 0xD800 && c <= 0xDFFF && !(Character.isHighSurrogate(c) && i + 1 < s.length() && Character.isLowSurrogate(s.charAt(i + 1))) && !(Character.isLowSurrogate(c) && i > 0 && Character.isHighSurrogate(s.charAt(i - 1)))))
                        b.append(String.format("\\u%04x", (int) c));
                    else b.append(c);
            }
        }
        return b.append('"').toString();
    }
}
