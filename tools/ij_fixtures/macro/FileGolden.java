import java.io.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.nio.file.attribute.BasicFileAttributes;
import java.security.MessageDigest;
import java.util.*;
import java.util.concurrent.*;
import java.util.regex.*;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;

/**
 * ImageJ 1.54p file-function oracle for the macro VFS of the Advanced Studio (contract: DOCS/studio-advanced/macros/FILES.md 15).
 *
 *   FileGolden <filesDir> <out.json>          run every tests/fixtures/ij-macro/files/<group>/<case>/macro.ijm
 *   FileGolden --make-inputs <filesDir>       run every case's setup.ijm (when it has one) and merge the files it writes into <case>/in/
 *   FileGolden --case <macro.ijm> <out>        (internal) one macro in a JVM of its own, result as a serialized Object[]
 *
 * A setup.ijm runs on a desktop JVM (run() needs the menus table, which is AWT). Per case: the granted folder is the real directory /ijm-vfs-golden/ of the current drive (the macro's {ROOT}); it is emptied, filled
 * from <case>/in/ (mtimes 1700000000000, or case.json "mtime"), the macro runs through ij.macro.Interpreter (FileProbe, one class
 * loader per case: fresh ImageJ statics), and the final tree is read back. Output normalised as FILES.md 15.2 says (README "Files").
 * The directory is never touched unless the marker file /ijm-vfs-golden.marker sits beside it, or it does not exist.
 * Local only: never shipped, never run in CI.
 */
@SuppressWarnings("unchecked")
public class FileGolden {
    static final String ROOT_NAME = "ijm-vfs-golden";
    static final String ROOT_PATH = "/" + ROOT_NAME + "/";
    static final long DEFAULT_MTIME = 1700000000000L;
    static final int CASE_TIMEOUT_S = 90;
    static final Set<String> TEXT_EXT = new HashSet<>(Arrays.asList("txt", "csv", "tsv", "xls", "ijm", "java", "html", "htm", "json", "md", "log"));
    static final Set<String> PIXEL_EXT = new HashSet<>(Arrays.asList("tif", "tiff", "png", "gif", "bmp"));

    static File rootDir, markerFile;
    static String srcDir;   // 1.54p sources, for the dialog titles

    public static void main(String[] args) throws Exception {
        Locale.setDefault(Locale.ROOT);
        rootDir = new File("/" + ROOT_NAME).getAbsoluteFile();
        markerFile = new File("/" + ROOT_NAME + ".marker").getAbsoluteFile();
        srcDir = System.getProperty("ijm.srcdir");
        if (args.length == 3 && args[0].equals("--case")) { caseChild(Paths.get(args[1]), Paths.get(args[2])); return; }
        System.setProperty("java.awt.headless", "true");
        boolean makeInputs = args.length == 2 && args[0].equals("--make-inputs");
        Path filesDir = Paths.get(makeInputs ? args[1] : args[0]).toAbsolutePath().normalize();
        Path out = makeInputs ? null : Paths.get(args[1]).toAbsolutePath().normalize();
        TreeMap<String, Path> cases = new TreeMap<>();
        try (DirectoryStream<Path> groups = Files.newDirectoryStream(filesDir)) {
            for (Path g : groups) {
                if (!Files.isDirectory(g) || g.getFileName().toString().startsWith("_")) continue;
                try (DirectoryStream<Path> cs = Files.newDirectoryStream(g)) {
                    for (Path c : cs) if (Files.isDirectory(c) && Files.exists(c.resolve(makeInputs ? "setup.ijm" : "macro.ijm")))
                        cases.put(g.getFileName() + "/" + c.getFileName(), c);
                }
            }
        }
        String only = System.getProperty("ijm.only");   // a substring of group/case (or group/case$ for an exact name): a partial run, for working on a case
        if (only != null && !only.isEmpty()) cases.keySet().removeIf(k -> only.endsWith("$") ? !k.equals(only.substring(0, only.length() - 1)) : !k.contains(only));
        claimRoot();
        try {
            if (makeInputs) makeInputs(cases); else record(cases, out);
        } catch (Throwable t) {
            t.printStackTrace();
            try { releaseRoot(); } catch (Throwable u) { System.err.println("could not clean " + rootDir + ": " + u); }
            System.exit(1);
        }
    }

    // ---- the granted folder ---------------------------------------------------------------------------------------------

    static void claimRoot() throws IOException {
        if (rootDir.exists() && !markerFile.exists())
            throw new IllegalStateException(rootDir + " exists and " + markerFile + " does not: not ours, refusing to touch it");
        Files.write(markerFile.toPath(), "ijm-vfs-golden\n".getBytes(StandardCharsets.US_ASCII));
    }

    static void releaseRoot() throws IOException {
        deleteTree(rootDir.toPath());
        Files.deleteIfExists(markerFile.toPath());
    }

    /** Windows keeps a file busy for a moment after a virus scan or a just-closed writer: a few retries. */
    static void deleteTree(Path p) throws IOException {
        for (int attempt = 0; ; attempt++) {
            try { deleteTreeOnce(p); return; }
            catch (FileSystemException e) {
                if (attempt >= 20) throw e;
                try { Thread.sleep(250); } catch (InterruptedException ie) { throw new IOException(ie); }
            }
        }
    }

    static void deleteTreeOnce(Path p) throws IOException {
        if (!Files.exists(p)) return;
        Files.walkFileTree(p, new SimpleFileVisitor<Path>() {
            @Override public FileVisitResult visitFile(Path f, BasicFileAttributes a) throws IOException { f.toFile().setWritable(true); Files.delete(f); return FileVisitResult.CONTINUE; }
            @Override public FileVisitResult postVisitDirectory(Path d, IOException e) throws IOException { Files.delete(d); return FileVisitResult.CONTINUE; }
        });
    }

    static void prepare(Path caseDir, Path inDir, Map<String, Long> mtimes) throws IOException {
        if (!markerFile.exists()) throw new IllegalStateException("marker vanished");
        deleteTree(rootDir.toPath());
        Files.createDirectories(rootDir.toPath());
        if (inDir != null && Files.isDirectory(inDir)) {
            Files.walkFileTree(inDir, new SimpleFileVisitor<Path>() {
                @Override public FileVisitResult preVisitDirectory(Path d, BasicFileAttributes a) throws IOException {
                    Files.createDirectories(rootDir.toPath().resolve(inDir.relativize(d).toString())); return FileVisitResult.CONTINUE; }
                @Override public FileVisitResult visitFile(Path f, BasicFileAttributes a) throws IOException {
                    Files.copy(f, rootDir.toPath().resolve(inDir.relativize(f).toString())); return FileVisitResult.CONTINUE; }
            });
            List<Path> all = new ArrayList<>();
            try (java.util.stream.Stream<Path> s = Files.walk(rootDir.toPath())) { s.forEach(all::add); }
            for (Path p : all) {
                if (p.equals(rootDir.toPath())) continue;
                String rel = rootDir.toPath().relativize(p).toString().replace('\\', '/');
                Long m = mtimes.get(rel);
                p.toFile().setLastModified(m != null ? m : DEFAULT_MTIME);
            }
        }
    }

    static Map<String, Long> mtimes(String caseJson) {
        Map<String, Long> m = new HashMap<>();
        Matcher blk = Pattern.compile("\"mtime\"\\s*:\\s*\\{([^}]*)\\}").matcher(caseJson);
        if (blk.find()) {
            Matcher e = Pattern.compile("\"([^\"]+)\"\\s*:\\s*(\\d+)").matcher(blk.group(1));
            while (e.find()) m.put(e.group(1), Long.parseLong(e.group(2)));
        }
        return m;
    }

    static String readCaseJson(Path caseDir) throws IOException {
        Path p = caseDir.resolve("case.json");
        return Files.exists(p) ? new String(Files.readAllBytes(p), StandardCharsets.UTF_8) : "{}";
    }

    static String macroText(Path ijm) throws IOException {
        return new String(Files.readAllBytes(ijm), StandardCharsets.UTF_8).replace("{ROOT}", ROOT_PATH);
    }

    // ---- --make-inputs ---------------------------------------------------------------------------------------------------

    static void makeInputs(TreeMap<String, Path> cases) throws Exception {
        for (Map.Entry<String, Path> e : cases.entrySet()) {
            Path in = e.getValue().resolve("in");
            Files.createDirectories(in);
            prepare(e.getValue(), in, new HashMap<>());
            Object[] o = runCase(e.getKey(), macroText(e.getValue().resolve("setup.ijm")), true);
            if (o[1] != null || o[3] != null && !String.valueOf(o[3]).contains("Macro canceled"))
                throw new IllegalStateException("setup of " + e.getKey() + " failed: " + o[1] + " " + o[3]);
            for (String[] ev : (List<String[]>) o[0]) if (!ev[0].equals("log")) throw new IllegalStateException("setup of " + e.getKey() + " wrote a dialog: " + ev[1]);
            // merge what the setup wrote (new and changed files) back into in/
            Files.walkFileTree(rootDir.toPath(), new SimpleFileVisitor<Path>() {
                @Override public FileVisitResult preVisitDirectory(Path d, BasicFileAttributes a) throws IOException {
                    Files.createDirectories(in.resolve(rootDir.toPath().relativize(d).toString())); return FileVisitResult.CONTINUE; }
                @Override public FileVisitResult visitFile(Path f, BasicFileAttributes a) throws IOException {
                    Files.copy(f, in.resolve(rootDir.toPath().relativize(f).toString()), StandardCopyOption.REPLACE_EXISTING); return FileVisitResult.CONTINUE; }
            });
            System.out.println("inputs: " + e.getKey());
        }
        releaseRoot();
        System.exit(0);
    }

    // ---- run ------------------------------------------------------------------------------------------------------------

    /** One JVM per case: ImageJ keeps statics (messages shown once, batch mode, OpenDialog directories, the macro file writer that an
     *  aborted macro never closes), and a file handle left open by an aborted macro would keep the folder from being emptied. */
    static Object[] runCase(String key, String code, boolean gui) throws Exception {
        Path in = Files.createTempFile("filegolden", ".ijm"), out = Files.createTempFile("filegolden", ".ser");
        try {
            Files.write(in, code.getBytes(StandardCharsets.UTF_8));
            List<String> cmd = new ArrayList<>(Arrays.asList(Paths.get(System.getProperty("java.home"), "bin", "java").toString(),
                "-Djava.awt.headless=" + !gui, "-Dfile.encoding=UTF-8", "-Duser.timezone=UTC", "-Duser.language=en", "-Duser.country=US",
                "-Duser.home=" + System.getProperty("user.home")));
            String stub = System.getProperty("macro.stubdir");   // headless: the GenericDialog stand-in goes first on the class path; with a desktop the real dialogs are closed by FileProbe
            cmd.addAll(Arrays.asList("-cp", (stub != null && !gui ? stub + File.pathSeparator : "") + System.getProperty("java.class.path"), "FileGolden", "--case", in.toString(), out.toString()));
            Process p = new ProcessBuilder(cmd).inheritIO().start();
            if (!p.waitFor(CASE_TIMEOUT_S, TimeUnit.SECONDS)) { p.destroyForcibly(); throw new IllegalStateException("timeout: " + key); }
            if (p.exitValue() != 0) throw new IllegalStateException("case JVM failed: " + key + " exit " + p.exitValue());
            try (ObjectInputStream ois = new ObjectInputStream(Files.newInputStream(out))) { return (Object[]) ois.readObject(); }
        } finally { Files.deleteIfExists(in); Files.deleteIfExists(out); }
    }

    static void caseChild(Path macro, Path out) throws Exception {
        Locale.setDefault(Locale.ROOT);
        Object[] o = ij.macro.FileProbe.runFlat(new String(Files.readAllBytes(macro), StandardCharsets.UTF_8));
        try (ObjectOutputStream oos = new ObjectOutputStream(Files.newOutputStream(out))) { oos.writeObject(o); }
        System.exit(0);
    }

    static void record(TreeMap<String, Path> cases, Path out) throws Exception {
        StringBuilder sb = new StringBuilder("{\n  \"imagej\": \"1.54p\", \"generator\": \"tools/ij_fixtures/macro/FileGolden.java\", \"root\": ")
            .append(q(ROOT_PATH)).append(", \"tz\": \"UTC\",\n  \"cases\": {\n");
        boolean first = true;
        int suspicious = 0;
        for (Map.Entry<String, Path> e : cases.entrySet()) {
            Path dir = e.getValue();
            String cj = readCaseJson(dir);
            boolean gui = Pattern.compile("\"gui\"\\s*:\\s*true").matcher(cj).find();
            prepare(dir, dir.resolve("in"), mtimes(cj));
            Object[] o = runCase(e.getKey(), macroText(dir.resolve("macro.ijm")), gui);
            List<String[]> events = (List<String[]>) o[0];
            String rawError = (String) o[1];
            int line = (Integer) o[2];
            String thrown = (String) o[3];
            List<String[]> images = (List<String[]>) o[4];
            boolean exited = rawError == null && thrown != null && thrown.contains("Macro canceled");
            if (thrown != null && !exited && rawError == null) { System.err.println("UNEXPECTED JAVA EXCEPTION " + e.getKey() + ": " + thrown); suspicious++; }
            int top = -1;
            if (rawError != null) {
                String prefix = rawError + " in line " + line + "\n";
                for (int i = 0; i < events.size(); i++) if (events.get(i)[0].equals("errorDialog") && events.get(i)[1].startsWith(prefix)) top = i;
            }
            List<String> log = new ArrayList<>();
            List<String[]> dialogs = new ArrayList<>();
            for (int i = 0; i < events.size(); i++) {
                String[] ev = events.get(i);
                if (i == top) continue;
                switch (ev[0]) {
                    case "log": log.add(norm(ev[1])); break;
                    case "showMessage": case "error":
                        dialogs.add(new String[] { ev[0], title(ev[2], ev[0]), norm(ev[1]), "" + log.size() }); break;
                    default:
                        System.err.println("NOT A GOLDEN (a picker, or an output the runner does not model) (" + ev[0] + ") in " + e.getKey() + ": " + ev[1]);
                        suspicious++;
                }
            }
            if (!first) sb.append(",\n");
            first = false;
            sb.append("    ").append(q(e.getKey())).append(": {\n      \"log\": [");
            for (int i = 0; i < log.size(); i++) { if (i > 0) sb.append(", "); sb.append(q(log.get(i))); }
            sb.append("],\n      \"error\": ");
            if (rawError == null) sb.append("null");
            else {
                sb.append("{\"message\": ").append(q(norm(rawError.replace("\r\n", "\n")))).append(", \"line\": ").append(line);
                if (top < 0) sb.append(", \"silent\": true");
                sb.append("}");
            }
            sb.append(",\n");
            if (exited) sb.append("      \"exited\": true,\n");
            sb.append("      \"dialogs\": [");
            for (int i = 0; i < dialogs.size(); i++) {
                String[] d = dialogs.get(i);
                if (i > 0) sb.append(", ");
                sb.append("{\"kind\": ").append(q(d[0])).append(", \"title\": ").append(q(d[1])).append(", \"text\": ").append(q(d[2])).append(", \"afterLog\": ").append(d[3]).append("}");
            }
            sb.append("],\n      \"tree\": [");
            List<String> tree = tree();
            for (int i = 0; i < tree.size(); i++) sb.append(i > 0 ? ",\n        " : "\n        ").append(tree.get(i));
            sb.append(tree.isEmpty() ? "" : "\n      ").append("],\n      \"images\": [");
            for (int i = 0; i < images.size(); i++) {
                String[] m = images.get(i);
                sb.append(i > 0 ? ",\n        " : "\n        ").append("{\"title\": ").append(q(norm(m[0]))).append(", \"pixels\": ").append(pixels(m, 3))
                    .append(", \"dir\": ").append(q(norm(m[1]))).append(", \"filename\": ").append(q(norm(m[2]))).append("}");
            }
            sb.append(images.isEmpty() ? "" : "\n      ").append("]\n    }");
        }
        sb.append("\n  }\n}\n");
        Files.createDirectories(out.getParent());
        Files.write(out, sb.toString().getBytes(StandardCharsets.UTF_8));
        System.out.println("cases: " + cases.size() + ", unexpected: " + suspicious + " -> " + out);
        releaseRoot();
        System.exit(suspicious == 0 ? 0 : 3);
    }

    // ---- normalisation (FILES.md 15.2) ----------------------------------------------------------------------------------

    static String norm(String s) {
        if (s == null) return "";
        s = s.replace("\r\n", "\n").replace('\\', '/');
        s = s.replaceAll("(?i)[A-Za-z]:/" + ROOT_NAME, "/" + ROOT_NAME);
        // the wording of the Windows I/O errors follows the language of the OS: English and French here (the machine that records)
        s = s.replace("Le chemin d\u2019acc\u00e8s sp\u00e9cifi\u00e9 est introuvable", "No such file or directory")
             .replace("Le fichier sp\u00e9cifi\u00e9 est introuvable", "No such file or directory")
             .replace("Acc\u00e8s refus\u00e9", "Permission denied")
             .replace("Le nom de fichier, le nom de r\u00e9pertoire ou la syntaxe du nom de volume est incorrect", "Invalid argument");
        s = s.replace("The system cannot find the file specified", "No such file or directory")
             .replace("The system cannot find the path specified", "No such file or directory")
             .replace("Access is denied", "Permission denied")
             .replace("The filename, directory name, or volume label syntax is incorrect", "Invalid argument");
        return s;
    }

    /** The title ImageJ gave the message box. Headless ImageJ prints the text only, so the title is read from the 1.54p source
     *  line of the caller (site "<class>:<line>"), where the call spells it; IJ.error(msg) is "ImageJ", IJ.showMessage(msg) "Message". */
    static String title(String site, String kind) {
        if (site != null && site.startsWith("T:")) return site.substring(2);   // a desktop run: the dialog's own title
        String dflt = kind.equals("error") ? "ImageJ" : "Message";
        if (site == null || site.isEmpty() || srcDir == null) return dflt;
        int c = site.lastIndexOf(':');
        String cls = site.substring(0, c);
        int ln = Integer.parseInt(site.substring(c + 1));
        Path src = Paths.get(srcDir, cls.replace('.', '/').replaceAll("\\$.*", "") + ".java");
        if (!Files.exists(src)) { System.err.println("no source for the dialog title at " + site + " (" + src + "): \"" + dflt + "\" assumed"); return dflt; }
        try {
            List<String> lines = Files.readAllLines(src, StandardCharsets.ISO_8859_1);
            StringBuilder win = new StringBuilder();
            for (int i = Math.max(0, ln - 4); i < Math.min(lines.size(), ln + 3); i++) win.append(lines.get(i)).append('\n');
            Matcher m = Pattern.compile("\\b(?:IJ\\.)?(?:error|showMessage)\\s*\\(\\s*(\"(?:[^\"\\\\]|\\\\.)*\"|null|[A-Za-z_][A-Za-z0-9_]*)\\s*,").matcher(win);
            if (m.find()) {
                String t = m.group(1);
                if (t.startsWith("\"")) return t.substring(1, t.length() - 1).replace("\\\"", "\"").replace("\\n", "\n");
                if (t.equals("null")) return dflt;
                System.err.println("dialog title is a variable (" + t + ") at " + site + ": check by hand");
                return "?" + t;
            }
        } catch (IOException e) { /* fall through */ }
        return dflt;
    }

    // ---- the final tree -------------------------------------------------------------------------------------------------

    static List<String> tree() throws Exception {
        TreeMap<String, String> rows = new TreeMap<>();
        Path root = rootDir.toPath();
        List<Path> all = new ArrayList<>();
        try (java.util.stream.Stream<Path> s = Files.walk(root)) { s.forEach(all::add); }
        for (Path p : all) {
            if (p.equals(root)) continue;
            String rel = root.relativize(p).toString().replace('\\', '/');
            if (Files.isDirectory(p)) { rows.put(rel + "/", "{\"path\": " + q(rel + "/") + ", \"size\": 0, \"cmp\": \"exists\"}"); continue; }
            byte[] b = Files.readAllBytes(p);
            String ext = rel.contains(".") ? rel.substring(rel.lastIndexOf('.') + 1).toLowerCase(Locale.ROOT) : "";
            String name = rel.substring(rel.lastIndexOf('/') + 1);
            if (name.startsWith(".") && ext.equals(name.substring(1))) ext = "";
            if (TEXT_EXT.contains(ext)) b = new String(b, StandardCharsets.ISO_8859_1).replace("\r\n", "\n").getBytes(StandardCharsets.ISO_8859_1);
            String head = "{\"path\": " + q(rel) + ", \"size\": " + b.length + ", ";
            if (PIXEL_EXT.contains(ext) || ext.equals("jpg") || ext.equals("jpeg")) {
                ij.ImagePlus imp = new ij.io.Opener().openImage(p.toString());
                if (imp == null) { rows.put(rel, head + "\"cmp\": \"bytes\", \"sha256\": " + q(sha(b)) + "}"); System.err.println("not decodable by the jar: " + rel); continue; }
                String cmp = ext.startsWith("jp") ? "dims" : "pixels";
                String[] d = ij.macro.FileProbe.describe(imp);
                rows.put(rel, head + "\"cmp\": " + q(cmp) + ", \"pixels\": " + pixels(d, 0) + "}");
            } else if (ext.equals("zip")) {
                TreeMap<String, String> es = new TreeMap<>();
                try (ZipInputStream z = new ZipInputStream(new ByteArrayInputStream(b))) {
                    ZipEntry ze;
                    while ((ze = z.getNextEntry()) != null) {
                        if (ze.isDirectory()) continue;
                        ByteArrayOutputStream bo = new ByteArrayOutputStream();
                        byte[] buf = new byte[8192]; int n;
                        while ((n = z.read(buf)) > 0) bo.write(buf, 0, n);
                        es.put(ze.getName(), sha(bo.toByteArray()));
                    }
                }
                StringBuilder s = new StringBuilder(head + "\"cmp\": \"zipEntries\", \"entries\": [");
                int i = 0;
                for (Map.Entry<String, String> en : es.entrySet()) s.append(i++ > 0 ? ", " : "").append("{\"name\": ").append(q(en.getKey())).append(", \"sha256\": ").append(q(en.getValue())).append("}");
                rows.put(rel, s.append("]}").toString());
            } else rows.put(rel, head + "\"cmp\": \"bytes\", \"sha256\": " + q(sha(b)) + "}");
        }
        return new ArrayList<>(rows.values());
    }

    static String sha(byte[] b) throws Exception { return ij.macro.FileProbe.hex(MessageDigest.getInstance("SHA-256").digest(b)); }

    /** Pixels object from describe()-shaped fields starting at index o: w, h, c, z, t, bitDepth, sha256. */
    static String pixels(String[] f, int o) {
        return "{\"w\": " + f[o] + ", \"h\": " + f[o + 1] + ", \"c\": " + f[o + 2] + ", \"z\": " + f[o + 3] + ", \"t\": " + f[o + 4]
            + ", \"bitDepth\": " + f[o + 5] + ", \"sha256\": " + q(f[o + 6]) + "}";
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
