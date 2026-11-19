import ij.*;
import ij.process.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.util.*;

/** Dialogs that change on a 2-channel composite and on a 16-bit image. Usage: run_fiji.sh CompositeCapture <out.json>. */
public class CompositeCapture {
    public static void main(String[] a) throws Exception {
        Locale.setDefault(Locale.ROOT);
        new ImageJ(ImageJ.NO_SHOW);
        Files.write(Paths.get(a[0]), (variants() + "\n").getBytes(StandardCharsets.UTF_8));
        System.exit(0);
    }

    /** The `variants` object of fiji-dialogs.json (DialogCapture writes the merged document). Needs a running ImageJ. */
    static String variants() throws Exception {
        ImageStack st = new ImageStack(64, 64);
        for (int c = 0; c < 2; c++) { ImageProcessor ip = new ByteProcessor(64, 64); for (int i = 0; i < 4096; i++) ip.set(i, (i * (37 + c) + (i / 64) * 11) & 255); st.addSlice(ip); }
        ImagePlus comp = new ImagePlus("comp", st);
        comp.setDimensions(2, 1, 1);
        comp = new CompositeImage(comp, CompositeImage.COMPOSITE);
        comp.show();
        ImageProcessor s = new ShortProcessor(64, 64);
        for (int i = 0; i < 4096; i++) s.set(i, (i * 37) & 4095);
        ImagePlus sh = new ImagePlus("sixteen", s);
        sh.show();
        List<String> out = new ArrayList<>();
        String[][] jobs = {
            {"comp", "Enhance Local Contrast (CLAHE)"}, {"comp", "Auto Threshold"}, {"comp", "Tubeness"},
            {"sixteen", "Auto Threshold"}, {"sixteen", "Enhance Local Contrast (CLAHE)"}, {"sixteen", "Tubeness"}
        };
        for (String[] j : jobs) {
            IJ.selectWindow(j[0]);
            out.add(DialogCapture.q(j[0] + " / " + j[1]) + ":{" + DialogCapture.capture(j[1], WindowManager.getImage(j[0])) + "}");
        }
        ImagePlus c0 = WindowManager.getImage("comp"), s0 = WindowManager.getImage("sixteen");
        if (c0 != null) { c0.changes = false; c0.close(); }
        if (s0 != null) { s0.changes = false; s0.close(); }
        return "{" + String.join(",", out) + "}";
    }
}
