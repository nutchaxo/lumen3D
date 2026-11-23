// Times the benchmark macros of tests/js/bench_ijm with the real ImageJ 1.54p interpreter (headless), for the speed
// gate of the JS interpreter (PLAN.md: <= 3x ImageJ). Local only, never CI.
//   tools/ij_fixtures/macro/run_bench.sh <path/to/ij-1.54p.jar> [out.json]
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.util.*;
import java.util.regex.*;

public class BenchIjm {
  public static void main(String[] a) throws Exception {
    Path dir = Paths.get(a[0]);
    int runs = a.length > 2 ? Integer.parseInt(a[2]) : 5;
    StringBuilder out = new StringBuilder("{\n");
    List<Path> files = new ArrayList<>();
    try (DirectoryStream<Path> ds = Files.newDirectoryStream(dir, "*.ijm")) { for (Path p : ds) files.add(p); }
    Collections.sort(files);
    PrintStream real = System.out;
    boolean firstFile = true;
    for (Path p : files) {
      String name = p.getFileName().toString().replace(".ijm", "");
      String code = new String(Files.readAllBytes(p), StandardCharsets.UTF_8);
      if (name.equals("pixels")) code = "setBatchMode(true);\nnewImage(\"t\", \"8-bit black\", 512, 512, 1);\n" + code;
      List<Long> ms = new ArrayList<>();
      for (int r = 0; r < runs; r++) {
        ByteArrayOutputStream bo = new ByteArrayOutputStream();
        System.setOut(new PrintStream(bo, true, "UTF-8"));
        ij.IJ.runMacro(code, "");
        System.setOut(real);
        Matcher m = Pattern.compile("ELAPSED ([0-9]+)").matcher(bo.toString("UTF-8"));
        ms.add(m.find() ? Long.parseLong(m.group(1)) : -1L);
      }
      long min = Long.MAX_VALUE; for (long v : ms) min = Math.min(min, v);
      if (!firstFile) out.append(",\n");
      firstFile = false;
      out.append("  \"").append(name).append("\": { \"cold\": ").append(ms.get(0)).append(", \"min\": ").append(min).append(", \"runs\": ").append(ms).append(" }");
    }
    out.append("\n}\n");
    Files.write(Paths.get(a[1]), out.toString().getBytes(StandardCharsets.UTF_8));
    real.println(out);
  }
}
