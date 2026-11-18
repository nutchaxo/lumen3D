import ij.Prefs;
import java.io.IOException;
import java.nio.file.*;
import java.util.*;

/**
 * Headless ImageJ 1.54p fixture generator (wave 2). Usage: Main <outDir> [pkg ...]
 * Packages: bg flt seg multi geom roi. Never shipped, never run in CI.
 */
public class Main {
    public static void main(String[] args) throws Exception {
        System.setProperty("java.awt.headless", "true");
        Locale.setDefault(Locale.ROOT);
        Prefs.blackBackground = true;    // binary: white objects on black
        Prefs.padEdges = false;
        Prefs.interpolateScaledImages = false;
        Fx.root = Paths.get(args[0]).toAbsolutePath().normalize();
        if (!Fx.root.getFileName().toString().equals("ij-wave2")) throw new IllegalArgumentException("outDir must end in ij-wave2");
        Set<String> only = new LinkedHashSet<>(Arrays.asList(args).subList(1, args.length));
        String[] pkgs = {"bg", "flt", "seg", "multi", "geom", "roi"};
        for (String p : pkgs) {
            if (!only.isEmpty() && !only.contains(p)) continue;
            clean(Fx.root.resolve(p));
            switch (p) {
                case "bg": P1.run(); break;
                case "flt": P2.run(); break;
                case "seg": P3.run(); break;
                case "multi": P4.run(); break;
                case "geom": P5.run(); break;
                case "roi": P6.run(); break;
            }
        }
        System.out.println("fixtures written: " + Fx.written.size());
        System.exit(0);   // ImageJ worker pools are non-daemon
    }

    static void clean(Path dir) throws IOException {
        if (!Files.isDirectory(dir)) return;
        try (DirectoryStream<Path> ds = Files.newDirectoryStream(dir, "*.json")) {
            for (Path f : ds) Files.delete(f);
        }
    }
}
