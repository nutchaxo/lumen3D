import java.nio.file.*;
import java.util.*;
import java.util.regex.*;

/**
 * Reference for the 2 x 2 Jama eigenvalues of Frangi Vesselness (tests/fixtures/ij-wave3/enh/jama_ties.json).
 * net.imagej.ops DefaultFrangi sorts the eigenvalues of the Hessian by magnitude with a stable sort; when the two
 * magnitudes tie, Jama's last bits decide which one is "the larger". Jama (public domain) is in the Fiji install.
 *
 * Usage: run_fiji.sh JamaTies <in.json> <out.json>
 *   in.json  : any JSON holding objects with "h00", "h01", "h11" (the cases of the existing fixture is a valid input; the 326
 *              matrices are the Hessians of the Frangi fixtures whose eigenvalues tie in magnitude to 1e-9)
 *   out.json : the same cases with "bits" = Double.doubleToLongBits of the two eigenvalues in the order Jama returns them.
 */
public final class JamaTies {
    public static void main(String[] a) throws Exception {
        String text = new String(Files.readAllBytes(Paths.get(a[0])), "UTF-8");
        Pattern p = Pattern.compile("[{]\"h00\":([^,]+),\"h01\":([^,]+),\"h11\":([^,}]+)");
        Matcher m = p.matcher(text);
        StringBuilder sb = new StringBuilder();
        sb.append("{\"imagej\":\"jama-1.0.3 (Fiji install)\",\"case\":\"jama_ties\",\"op\":\"jamaEig2\",")
          .append("\"call\":\"new Jama.Matrix([[h00,h01],[h01,h11]]).eig().getRealEigenvalues() in Java 21; bits = Double.doubleToLongBits of the two eigenvalues in the order Jama returns them (ascending). The 326 matrices are the Hessians of the Frangi fixtures whose two eigenvalues tie in magnitude (to 1e-9).\",\"cases\":[");
        boolean first = true;
        while (m.find()) {
            double h00 = Double.parseDouble(m.group(1)), h01 = Double.parseDouble(m.group(2)), h11 = Double.parseDouble(m.group(3));
            double[] ev = new Jama.Matrix(new double[][]{{h00, h01}, {h01, h11}}).eig().getRealEigenvalues();
            if (!first) sb.append(',');
            first = false;
            sb.append("{\"h00\":").append(m.group(1)).append(",\"h01\":").append(m.group(2)).append(",\"h11\":").append(m.group(3))
              .append(",\"bits\":[\"").append(Double.doubleToLongBits(ev[0])).append("\",\"").append(Double.doubleToLongBits(ev[1])).append("\"]}");
        }
        sb.append("]}");
        Files.write(Paths.get(a[1]), sb.toString().getBytes("UTF-8"));
    }
}
