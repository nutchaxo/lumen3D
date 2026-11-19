import ij.Prefs;
import java.io.IOException;
import java.nio.file.*;
import java.util.*;

/**
 * Headless ImageJ 1.54p fixture generator (wave 3). Usage: Main3 <outDir ending in ij-wave3> [pkg ...]
 * Packages: thr enh fft sel io ov ana edit fiji lib. Never shipped, never run in CI.
 */
public class Main3 {
    public static void main(String[] args) throws Exception {
        // ImageJ reads macro options only on threads named "Run$_..." (Macro.getOptions): run the whole job on one
        final Throwable[] err = new Throwable[1];
        Thread t = new Thread(() -> { try { work(args); } catch (Throwable e) { err[0] = e; } }, "Run$_fixtures");
        t.start();
        t.join();
        if (err[0] != null) { err[0].printStackTrace(); System.exit(1); }
        System.out.println("fixtures written: " + Fx.written.size());
        System.exit(0);
    }

    static void work(String[] args) throws Exception {
        Locale.setDefault(Locale.ROOT);
        new ij.ImageJ(ij.ImageJ.NO_SHOW);   // menus for IJ.run; the preferences are set AFTER (the constructor reads IJ_Prefs)
        Prefs.blackBackground = true;
        Prefs.padEdges = false;
        Prefs.interpolateScaledImages = false;
        Fx.root = Paths.get(args[0]).toAbsolutePath().normalize();
        if (!Fx.root.getFileName().toString().equals("ij-wave3")) throw new IllegalArgumentException("outDir must end in ij-wave3");
        Set<String> only = new LinkedHashSet<>(Arrays.asList(args).subList(1, args.length));
        String[] pkgs = {"thr", "enh", "fft", "sel", "io", "ov", "ana", "edit", "fiji", "lib"};
        for (String p : pkgs) {
            if (!only.isEmpty() && !only.contains(p)) continue;
            clean(Fx.root.resolve(p));
            switch (p) {
                case "thr": W3Thr.run(); break;
                case "enh": W3Enh.run(); break;
                case "fft": W3Fft.run(); break;
                case "sel": W3Sel.run(); break;
                case "io": W3Io.run(); break;
                case "ov": W3Ov.run(); break;
                case "ana": W3Ana.run(); break;
                case "edit": W3Edit.run(); break;
                case "fiji": W3Fiji.run(); break;
                case "lib": W3Lib.run(); break;
            }
        }
    }

    static void clean(Path dir) throws IOException {
        if (!Files.isDirectory(dir)) return;
        try (DirectoryStream<Path> ds = Files.newDirectoryStream(dir)) {
            for (Path f : ds) {
                String n = f.getFileName().toString();
                if (n.equals("ours")) continue;   // files written by our own code (P-io round trip input) are never deleted
                if (Files.isRegularFile(f)) Files.delete(f);
            }
        }
    }
}
