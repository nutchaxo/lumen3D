import ij.*;
import ij.gui.*;
import ij.io.*;
import ij.Macro;
import ij.measure.Calibration;
import ij.plugin.*;
import ij.plugin.filter.XYWriter;
import ij.process.*;
import java.awt.Color;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.util.*;
import java.util.zip.*;

/** io: RoiEncoder bytes (every type / option), RoiSet zips, RoiDecoder round trips, TextEncoder, TextReader, the two XY writers. */
final class W3Io {
    static void run() throws Exception {
        roiFiles();
        roiSets();
        decodeOurs();
        textEncoder();
        textReader();
        xyWriter();
        xyCoordinates();
    }

    static String b64(byte[] b) { return Base64.getEncoder().encodeToString(b); }

    // ------------------------------------------------------------------ ROI list
    static LinkedHashMap<String, Roi> rois() {
        LinkedHashMap<String, Roi> m = new LinkedHashMap<>();
        m.put("rect", new Roi(10, 8, 30, 20));
        Roi rr = new Roi(10, 8, 30, 20); rr.setCornerDiameter(8); m.put("rect_rounded", rr);
        m.put("rect_subpixel", new Roi(10.5, 8.25, 30.75, 20.5));
        m.put("oval", new OvalRoi(12, 6, 28, 22));
        m.put("oval_subpixel", new OvalRoi(12.5, 6.5, 27.25, 22.75));
        m.put("polygon", W3Sel.intPoly(Roi.POLYGON, 8, 6, 40, 10, 52, 30, 30, 22, 36, 40, 14, 34));
        m.put("polygon_subpixel", W3Sel.poly(Roi.POLYGON, 8.5f, 6.25f, 40.5f, 10f, 52f, 30.5f, 20f, 40f));
        m.put("freehand", W3Sel.freehand());
        m.put("traced", W3Sel.traced());
        m.put("freehand_subpixel", W3Sel.poly(Roi.FREEROI, 10.5f, 10f, 14f, 9.5f, 18f, 12f, 17f, 18.5f, 11f, 17f));
        m.put("line", new Line(6, 40, 58, 8));
        m.put("line_subpixel", new Line(6.5, 40.25, 58.75, 8.5));
        Roi lw = new Line(6, 40, 58, 8); lw.setStrokeWidth(4); m.put("line_width4", lw);
        m.put("polyline", W3Sel.intPoly(Roi.POLYLINE, 6, 38, 18, 12, 33, 30, 46, 10, 58, 28));
        m.put("polyline_subpixel", W3Sel.poly(Roi.POLYLINE, 6.5f, 38f, 18f, 12.5f, 33.25f, 30f));
        m.put("freeline", W3Sel.freelineRoi());
        m.put("angle", W3Sel.intPoly(Roi.ANGLE, 10, 10, 30, 20, 40, 8));
        m.put("point_single", new PointRoi(21, 17));
        m.put("points_multi", new PointRoi(new int[]{10, 30, 46, 40}, new int[]{10, 8, 20, 38}, 4));
        m.put("points_subpixel", new PointRoi(new float[]{10.5f, 30.25f, 46f}, new float[]{10f, 8.75f, 20.5f}, 3));
        m.put("ellipse", new EllipseRoi(10, 20, 50, 28, 0.6));
        m.put("rotated_rect", new RotatedRectRoi(12, 30, 52, 20, 9));
        m.put("composite_holed", W3Sel.holed());
        Roi two = new ShapeRoi(new Roi(2, 2, 10, 10)); two = ((ShapeRoi) two).or(new ShapeRoi(new Roi(20, 6, 12, 14))); m.put("composite_two_rects", two);
        Roi named = new Roi(4, 4, 20, 16); named.setName("cell-7"); m.put("rect_named", named);
        Roi col = new OvalRoi(8, 8, 24, 24); col.setStrokeColor(new Color(255, 128, 0)); col.setFillColor(new Color(0x80, 0x00, 0xff, 0x60)); col.setStrokeWidth(3.5); col.setName("styled"); m.put("oval_styled", col);
        Roi pos = new Roi(6, 6, 12, 12); pos.setPosition(2, 3, 4); m.put("rect_position_czt", pos);
        Roi sc = new Roi(6, 6, 12, 12); sc.setStrokeColor(Color.cyan); m.put("rect_stroke_only", sc);
        return m;
    }

    static void roiFiles() {
        List<Object> cases = new ArrayList<>();
        for (Map.Entry<String, Roi> e : rois().entrySet()) {
            Roi r = e.getValue();
            byte[] bytes = RoiEncoder.saveAsByteArray(r);
            Object dec;
            try { dec = W3Sel.roiFull(RoiDecoder.openFromByteArray(bytes)); } catch (Throwable t) { dec = J.o("error", String.valueOf(t)); }
            cases.add(J.o("kind", "roi-file", "name", e.getKey(), "roi", W3Sel.roiFull(r), "length", bytes.length, "b64", b64(bytes), "decoded", dec));
        }
        new Fx("io", "roi_files", "roiCodec")
            .call("RoiEncoder.saveAsByteArray(roi) (64-byte header + coordinates + header2 [name, stroke/fill colour, width, position]) and RoiDecoder.openFromByteArray of the same bytes")
            .put("cases", cases).write();
    }

    static byte[] zip(List<String> names, List<byte[]> data, boolean stored) throws IOException {
        ByteArrayOutputStream bo = new ByteArrayOutputStream();
        ZipOutputStream zos = new ZipOutputStream(new BufferedOutputStream(bo));
        for (int i = 0; i < names.size(); i++) {
            ZipEntry ze = new ZipEntry(names.get(i));
            ze.setTime(946684800000L);
            if (stored) {
                ze.setMethod(ZipEntry.STORED); ze.setSize(data.get(i).length); ze.setCompressedSize(data.get(i).length);
                CRC32 c = new CRC32(); c.update(data.get(i)); ze.setCrc(c.getValue());
            }
            zos.putNextEntry(ze); zos.write(data.get(i)); zos.closeEntry();
        }
        zos.close();
        return bo.toByteArray();
    }

    static void roiSets() throws Exception {
        List<String> names = new ArrayList<>();
        List<byte[]> data = new ArrayList<>();
        List<Object> entries = new ArrayList<>();
        int k = 1;
        for (String key : new String[]{"rect", "oval", "polygon", "line", "points_multi", "composite_holed", "oval_styled"}) {
            Roi r = rois().get(key);
            String nm = String.format("%04d-%04d-%04d.roi", k, (int) r.getBounds().y + 1, (int) r.getBounds().x + 1);
            names.add(nm); data.add(RoiEncoder.saveAsByteArray(r));
            entries.add(J.o("entry", nm, "roi", W3Sel.roiFull(r)));
            k++;
        }
        new Fx("io", "roiset_zip", "roiSet")
            .call("ZipOutputStream of '<label>.roi' entries as RoiManager.saveMultiple writes them (DEFLATED), plus the same entries STORED; entry time fixed (2000-01-01) for reproducibility")
            .put("kind", "roi-file").put("entries", entries).put("zipDeflatedB64", b64(zip(names, data, false)))
            .put("zipStoredB64", b64(zip(names, data, true))).write();
    }

    /** Files written by OUR encoder (dropped in tests/fixtures/ij-wave3/io/ours/*.roi by P-io's test) decoded by the 1.54p RoiDecoder. */
    static void decodeOurs() throws Exception {
        Path dir = Fx.root.resolve("io").resolve("ours");
        List<Object> cases = new ArrayList<>();
        if (Files.isDirectory(dir)) {
            List<Path> fs = new ArrayList<>();
            try (DirectoryStream<Path> ds = Files.newDirectoryStream(dir, "*.roi")) { for (Path p : ds) fs.add(p); }
            Collections.sort(fs);
            for (Path p : fs) {
                byte[] b = Files.readAllBytes(p);
                Object dec;
                try { dec = W3Sel.roiFull(RoiDecoder.openFromByteArray(b)); } catch (Throwable t) { dec = J.o("error", String.valueOf(t)); }
                cases.add(J.o("file", p.getFileName().toString(), "length", b.length, "decoded", dec));
            }
        }
        new Fx("io", "decode_ours", "roiCodec")
            .call("RoiDecoder.openFromByteArray over io/ours/*.roi (empty until P-io drops files there; run again with `run3.sh <jar> io`)")
            .put("count", cases.size()).put("cases", cases).write();
    }

    // ------------------------------------------------------------------ text image
    static String encode(ImageProcessor ip, Calibration cal, int precision) throws IOException {
        ByteArrayOutputStream bo = new ByteArrayOutputStream();
        DataOutputStream out = new DataOutputStream(bo);
        new TextEncoder(ip, cal, precision).write(out);
        out.flush();
        return lf(bo.toString("UTF-8"));
    }

    /** ImageJ writes text with the platform line separator (CRLF on Windows, LF on macOS / Linux): fixtures are normalised to LF so they do not depend on the capture machine. */
    static String lf(String s) { return s == null ? null : s.replace("\r\n", "\n"); }
    static final String LINE_ENDING_NOTE = "text normalised to LF (ImageJ emits System.lineSeparator(): CRLF on the Windows capture machine, LF on macOS/Linux); the port emits LF";

    static void textEncoder() throws Exception {
        List<Object> cases = new ArrayList<>();
        for (int bits : new int[]{8, 16, 32}) for (int prec : new int[]{0, 3, 6}) {
            ImageProcessor ip = Gen.tex(bits, 7, 5, 8 + bits);
            if (bits == 32) { ip.setf(1, 1, Float.NaN); ip.setf(2, 1, 1.0e-7f); ip.setf(3, 1, 123456.789f); ip.setf(0, 0, Float.POSITIVE_INFINITY); ip.setf(4, 3, 3.0f); }
            Calibration cal = new ImagePlus("x", ip).getCalibration();
            cases.add(J.o("bitDepth", bits, "precision", prec, "calibrated", false, "input", J.image(ip), "text", encode(ip, cal, prec)));
        }
        ImageProcessor ip = Gen.tex(16, 7, 5, 44);
        Calibration cal = new ImagePlus("x", ip).getCalibration();
        cal.setFunction(Calibration.STRAIGHT_LINE, new double[]{-100.0, 0.5}, "Gray Value");
        cases.add(J.o("bitDepth", 16, "precision", 3, "calibrated", true, "calibration", "STRAIGHT_LINE a=-100 b=0.5", "input", J.image(ip), "text", encode(ip, cal, 3)));
        new Fx("io", "text_encoder", "textImage")
            .call("new TextEncoder(ip, cal, precision).write(DataOutputStream): tab-separated rows, 32-bit with `precision` decimals (integers printed without decimals), calibrated values when the calibration is scaled")
            .put("lineEnding", LINE_ENDING_NOTE).put("capturedLineSeparator", System.lineSeparator()).put("cases", cases).write();
    }

    static void textReader() throws Exception {
        Path tmp = Files.createTempDirectory("w3txt");
        String[][] files = {
            {"ints8_tab", "0\t17\t255\n3\t90\t128\n"},
            {"ints16_tab", "0\t300\t65535\n3\t9000\t1280\n"},
            {"ints_negative", "-5\t17\t255\n3\t90\t128\n"},
            {"floats", "0.5\t17.25\t255\n3\t90\t1.0E-4\n"},
            {"comma", "0,17,255\n3,90,128\n"},
            {"spaces", "0 17 255\n3 90 128\n"},
            {"mixed_ws", "0  17,255\n3\t90 128\n"},
            {"header_row", "a\tb\tc\n1\t2\t3\n4\t5\t6\n"},
            {"ints_over_65535", "0\t70000\t5\n1\t2\t3\n"},
            {"nan_inf", "NaN\t1\t2\n3\tInfinity\t5\n"},
            {"crlf", "1\t2\t3\r\n4\t5\t6\r\n"},
            {"trailing_tab", "1\t2\t3\t\n4\t5\t6\t\n"}
        };
        List<Object> cases = new ArrayList<>();
        for (String[] f : files) {
            Path p = tmp.resolve(f[0] + ".txt");
            Files.write(p, f[1].getBytes(StandardCharsets.UTF_8));
            Object res;
            try {
                TextReader tr = new TextReader();
                tr.hideErrorMessages();
                ImageProcessor ip = tr.open(p.toString());
                res = ip == null ? J.o("null", true) : J.image(ip);
            } catch (Throwable t) { res = J.o("error", String.valueOf(t)); }
            cases.add(J.o("name", f[0], "text", f[1], "output", res));
        }
        new Fx("io", "text_reader", "textImage")
            .call("new TextReader().open(path) [File > Import > Text Image]: ALWAYS a 32-bit float image (all-NaN first row dropped as a header); there is no 8/16-bit auto type: TextReader.run shows open(path) without converting")
            .put("cases", cases).write();
    }

    // ------------------------------------------------------------------ XY writers
    static String viaPath(String key, Runnable body, Path file) throws IOException {
        Files.deleteIfExists(file);
        Macro.setOptions(key);
        try { body.run(); } finally { Macro.setOptions(null); }
        return Files.exists(file) ? lf(new String(Files.readAllBytes(file), StandardCharsets.UTF_8)) : null;
    }

    static void xyWriter() throws Exception {
        Path tmp = Files.createTempDirectory("w3xy");
        List<Object> cases = new ArrayList<>();
        for (Map.Entry<String, Roi> e : rois().entrySet()) {
            Roi r = e.getValue();
            for (int cal = 0; cal < 2; cal++) {
                ImagePlus imp = Gen.imp("t", Gen.tex(8, 64, 48, 5));
                if (cal == 1) { Calibration c = imp.getCalibration(); c.pixelWidth = 0.5; c.pixelHeight = 0.5; c.setUnit("um"); }
                imp.setRoi((Roi) r.clone());
                Path f = tmp.resolve("xy.txt");
                String txt;
                try {
                    WindowManager.setTempCurrentImage(imp);
                    txt = viaPath("path=" + f.toString().replace('\\', '/'), () -> new XYWriter().saveXYCoordinates(imp), f);
                } catch (Throwable t) { txt = "error: " + t; }
                cases.add(J.o("name", e.getKey(), "calibrated", cal == 1, "text", txt));
            }
        }
        new Fx("io", "xy_writer", "saveXY")
            .call("XYWriter.saveXYCoordinates(imp) with macro option path=<file> (SaveDialog): polygon vertices tab-separated, IJ.d2s(v*pw,4) when calibrated or sub-pixel, integers otherwise; lines end with the platform separator (normalised to LF in this fixture)")
            .put("lineEnding", LINE_ENDING_NOTE).put("capturedLineSeparator", System.lineSeparator()).put("cases", cases).write();
    }

    static void xyCoordinates() throws Exception {
        Path tmp = Files.createTempDirectory("w3xyc");
        List<Object> cases = new ArrayList<>();
        ImageProcessor ip8 = new ByteProcessor(12, 9);
        for (int y = 2; y < 6; y++) for (int x = 3; x < 8; x++) ip8.set(x, y, 40 + x + y);
        ip8.set(0, 8, 9);
        FloatProcessor ipf = new FloatProcessor(12, 9);
        for (int y = 2; y < 6; y++) for (int x = 3; x < 8; x++) ipf.setf(x, y, 0.25f * (x + y));
        ImageProcessor[] ips = {ip8, ipf};
        for (ImageProcessor ip : ips) for (int inv = 0; inv < 2; inv++) {
            ImagePlus imp = Gen.imp("t", ip.duplicate());
            Path f = tmp.resolve("xyc.txt");
            String txt;
            try {
                WindowManager.setTempCurrentImage(imp);
                txt = viaPath("path=" + f.toString().replace('\\', '/') + " background=0" + (inv == 1 ? " invert" : "") + " suppress", () -> new XYCoordinates().run(""), f);
            } catch (Throwable t) { txt = "error: " + t; }
            cases.add(J.o("bitDepth", ip.getBitDepth(), "params", J.o("background", 0, "invertY", inv == 1), "selection", false, "input", J.image(ip), "text", txt));
        }
        // with a selection: the dialog is skipped, a ResultsTable of X, Y, Value is saved as .csv
        for (Roi roi : new Roi[]{new Roi(3, 2, 3, 2), new OvalRoi(2, 1, 6, 5)}) {
            ImagePlus imp = Gen.imp("t", ip8.duplicate());
            imp.setRoi((Roi) roi.clone());
            Path f = tmp.resolve("sel.csv");
            String txt;
            try {
                WindowManager.setTempCurrentImage(imp);
                txt = viaPath("path=" + f.toString().replace('\\', '/'), () -> new XYCoordinates().run(""), f);
            } catch (Throwable t) { txt = "error: " + t; }
            cases.add(J.o("bitDepth", 8, "selection", true, "roi", J.roi(roi), "input", J.image(ip8), "text", txt));
        }
        new Fx("io", "xy_coordinates", "xyCoordinates")
            .call("XYCoordinates.run(\"\") with macro options path= background= [invert]: every pixel != background as 'x<TAB>y<TAB>value' (y from the bottom unless invert); with an area selection: ResultsTable X,Y,Value saved as .csv")
            .put("lineEnding", LINE_ENDING_NOTE).put("capturedLineSeparator", System.lineSeparator()).put("cases", cases).write();
    }
}
