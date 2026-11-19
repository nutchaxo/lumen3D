import fiji.analyze.directionality.Directionality_;
import ij.*;
import ij.gui.*;
import ij.process.*;
import java.io.*;
import java.nio.file.*;
import java.util.*;
import net.imglib2.RandomAccess;
import net.imglib2.img.Img;
import net.imglib2.img.array.ArrayImgs;
import org.scijava.Context;
import org.scijava.command.CommandService;
import org.scijava.module.Module;

/** Second half of FijiRefs: Frangi (SciJava command), Directionality (public API), Cell Counter XML, RoiSet.zip. */
final class FijiRefs2 {
    // ------------------------------------------------------------------ Frangi
    @SuppressWarnings({"unchecked", "rawtypes"})
    static void frangi() throws Exception {
        Context ctx = new Context(CommandService.class, net.imagej.ops.OpService.class);
        CommandService cs = ctx.getService(CommandService.class);
        Class<?> cmd = Class.forName("net.imagej.ops.commands.filter.FrangiVesselness");
        ImageProcessor[] ims = {FijiRefs.vessels(64, 56, 5), FijiRefs.blobs8(64, 56, 3), FijiRefs.fibres(56, 30, Double.NaN, 4), Gen.touchingDisks(64, 56)};
        String[] nm = {"vessels", "blobs", "fibres", "disks"};
        String[][] settings = {{"false", "1, 1", "2, 5"}, {"true", "1, 1", "2, 5"}, {"false", "1, 1", "3"}, {"false", "1, 1", "1, 2, 3"}, {"false", "1, 2", "2"}};
        for (int k = 0; k < ims.length; k++) {
            ImageProcessor ip = ims[k];
            int w = ip.getWidth(), h = ip.getHeight();
            float[] data = new float[w * h];
            for (int i = 0; i < data.length; i++) data[i] = ip.get(i);
            List<Object> cases = new ArrayList<>();
            for (String[] s : settings) {
                Object res;
                try {
                    Img in = ArrayImgs.floats(data.clone(), w, h);
                    Module m = (Module) cs.run((Class) cmd, true, "input", in, "doGauss", Boolean.parseBoolean(s[0]), "spacingString", s[1], "scaleString", s[2]).get();
                    Img out = (Img) m.getOutput("result");
                    long[] dims = new long[out.numDimensions()];
                    out.dimensions(dims);
                    long total = 1;
                    for (long d : dims) total *= d;
                    float[] vals = new float[(int) total];
                    RandomAccess ra = out.randomAccess();
                    int[] pos = new int[dims.length];
                    for (int i = 0; i < total; i++) {
                        long rem = i;
                        for (int d = 0; d < dims.length; d++) { pos[d] = (int) (rem % dims[d]); rem /= dims[d]; }
                        ra.setPosition(pos);
                        vals[i] = ((net.imglib2.type.numeric.RealType) ra.get()).getRealFloat();
                    }
                    double[] dd = new double[dims.length]; for (int q = 0; q < dd.length; q++) dd[q] = dims[q];
                    res = J.o("dims", dd, "type", ra.get().getClass().getName(), "values", J.b64(toBytes(vals), "f32", vals.length));
                } catch (Throwable t) { res = J.o("error", String.valueOf(t) + (t.getCause() != null ? " / " + t.getCause() : "")); }
                cases.add(J.o("params", J.o("doGauss", Boolean.parseBoolean(s[0]), "spacing", s[1], "scales", s[2]), "result", res));
            }
            new Fx("fiji/frangi", nm[k], "frangi").call("CommandService.run(net.imagej.ops.commands.filter.FrangiVesselness, input = ArrayImg<FloatType> of the 8-bit values, doGauss, spacingString, scaleString): result Img dims (x, y[, scale planes]) in imglib2 order (x fastest)")
                .input(ip).put("cases", cases).write();
        }
    }

    static byte[] toBytes(float[] v) {
        java.nio.ByteBuffer b = java.nio.ByteBuffer.allocate(v.length * 4).order(java.nio.ByteOrder.LITTLE_ENDIAN);
        for (float f : v) b.putFloat(f);
        return b.array();
    }

    // ------------------------------------------------------------------ Directionality
    @SuppressWarnings({"unchecked", "rawtypes"})
    static void directionality() throws Exception {
        Class<?> mc = Class.forName("fiji.analyze.directionality.Directionality_$AnalysisMethod");
        Object[] methods = mc.getEnumConstants();
        List<Object> methodNames = new ArrayList<>();
        for (Object m : methods) methodNames.add(m.toString());
        Object[][] imgs = {
            {"grating0", FijiRefs.fibres(96, 0, Double.NaN, 1)}, {"grating30", FijiRefs.fibres(96, 30, Double.NaN, 2)}, {"grating60", FijiRefs.fibres(96, 60, Double.NaN, 3)},
            {"grating-45", FijiRefs.fibres(96, -45, Double.NaN, 4)}, {"mix30_120", FijiRefs.fibres(96, 30, 120, 5)}, {"noise", FijiRefs.fibres(96, 0, Double.NaN, 6)},
            {"grating30_128", FijiRefs.fibres(128, 30, Double.NaN, 7)},
            // piece size / filter count: sizes that are neither square nor a power of two, and a local patch of known angle in one corner
            {"rect100x60_30", rect(100, 60, 30, 8)}, {"rect200x130_60", rect(200, 130, 60, 9)}, {"rect256x64_0", rect(256, 64, 0, 10)},
            {"rect60x100_30", rect(60, 100, 30, 11)}, {"rect129x129_30", rect(129, 129, 30, 12)},
            {"patch160_corner60", patch(160, 160, 0, 60, 48, 13)}, {"patch200x130_corner90", patch(200, 130, 30, 90, 56, 14)}
        };
        ((ByteProcessor) imgs[5][1]).noise(60);
        List<Object> cases = new ArrayList<>();
        PrintStream so = System.out, se = System.err;
        for (Object[] im : imgs) for (Object m : methods) for (int[] cfg : (im[0].toString().matches("(rect|patch).*") ? new int[][]{{90, -90}, {45, -90}} : new int[][]{{90, -90}, {45, -90}, {60, 0}})) {
            ByteArrayOutputStream cap = new ByteArrayOutputStream();
            System.setOut(new PrintStream(cap)); System.setErr(new PrintStream(cap));
            Object res;
            try {
                IJ.log("\\Clear");
                Directionality_ d = new Directionality_();
                ImagePlus imp = new ImagePlus("d", ((ImageProcessor) im[1]).duplicate());
                d.setImagePlus(imp);
                d.setMethod((Directionality_.AnalysisMethod) m);
                d.setBinNumber(cfg[0]);
                d.setBinStart(cfg[1]);
                d.setDebugFlag(true);
                d.computeHistograms();
                d.fitHistograms();
                List<Object> fit = new ArrayList<>();
                for (double[] f : d.getFitAnalysis()) fit.add(f);
                List<Object> hist = new ArrayList<>();
                for (double[] f : d.getHistograms()) hist.add(f);
                List<Object> par = new ArrayList<>();
                for (double[] f : d.getFitParameters()) par.add(f);
                res = J.o("fitAnalysis", fit, "histograms", hist, "fitParameters", par, "goodness", d.getGoodnessOfFit(), "bins", d.getBins(), "binEnd", d.getBinEnd(), "log", IJ.getLog());
            } catch (Throwable t) { res = J.o("error", String.valueOf(t)); }
            System.setOut(so); System.setErr(se);
            cases.add(J.o("image", im[0], "method", m.toString(), "params", J.o("nbins", cfg[0], "start", cfg[1]), "stdout", cap.toString(), "result", res));
        }
        List<Object> inputs = new ArrayList<>();
        for (Object[] im : imgs) inputs.add(J.o("name", im[0], "image", J.image((ImageProcessor) im[1])));
        new Fx("fiji/directionality", "gratings", "directionality")
            .call("Directionality_ public API: setImagePlus, setMethod, setBinNumber, setBinStart, setDebugFlag(true), computeHistograms(), fitHistograms(), getFitAnalysis() [per slice: direction, dispersion, amount, goodness (order as the plugin returns it)], getHistograms(), getFitParameters(); debug output kept (piece size / filters, if the plugin prints them)")
            .put("methodNames", methodNames).put("inputs", inputs)
            .put("note", "rect* / patch* images exist to expose the piece (tile) size and the number of filters: non-square, non-power-of-two sizes, and a corner patch of a known angle (patch*: top-left square of `size` px at the second angle, a flat band on the right) so the histogram weight of the patch shows how the image is cut").put("cases", cases).write();
    }

    /** Sinusoidal fibres at `deg` degrees (same convention as FijiRefs.fibres) on a w x h image. */
    static ByteProcessor rect(int w, int h, double deg, long seed) { return patch(w, h, deg, Double.NaN, 0, seed); }

    /** Fibres at `deg`; the top-left `size` x `size` square carries fibres at `deg2` instead (NaN: none). A flat grey band (1/8 of the width) is left on the right edge when a patch exists. */
    static ByteProcessor patch(int w, int h, double deg, double deg2, int size, long seed) {
        float[] v = new float[w * h];
        Random r = new Random(seed);
        for (int y = 0; y < h; y++) for (int x = 0; x < w; x++) {
            double d = (!Double.isNaN(deg2) && x < size && y < size) ? deg2 : deg;
            double a = Math.toRadians(d), s = x * Math.sin(a) + y * Math.cos(a);
            double val = 0.5 + 0.35 * Math.sin(2 * Math.PI * s / 7.0);
            if (!Double.isNaN(deg2) && x >= w - w / 8) val = 0.5;
            v[y * w + x] = (float) Math.max(0, Math.min(1, val + 0.04 * r.nextGaussian()));
        }
        return (ByteProcessor) Gen.make(8, v, w, h);
    }

    // ------------------------------------------------------------------ Cell Counter XML
    static void cellCounter() throws Exception {
        Path tmp = Files.createTempDirectory("w3cc");
        Class<?> vc = Class.forName("sc.fiji.cellCounter.CellCntrMarkerVector");
        Class<?> mk = Class.forName("sc.fiji.cellCounter.CellCntrMarker");
        Class<?> wx = Class.forName("sc.fiji.cellCounter.WriteXML");
        Vector<Object> types = new Vector<>();
        int[][][] pts = {{{10, 12, 1}, {20, 30, 1}, {33, 8, 1}}, {{40, 40, 1}}, {}, {{5, 50, 1}, {15, 55, 1}}, {}, {}, {}, {{60, 10, 1}}};
        for (int t = 0; t < 8; t++) {
            Object v = vc.getConstructor(int.class, String.class).newInstance(t + 1, "Type " + (t + 1));
            for (int[] p : pts[t]) vc.getMethod("addMarker", mk).invoke(v, mk.getConstructor(int.class, int.class, int.class).newInstance(p[0], p[1], p[2]));
            types.add(v);
        }
        Path out = tmp.resolve("markers.xml");
        Object res;
        try {
            Object w = wx.getConstructor(String.class).newInstance(out.toString());
            Object ok = wx.getMethod("writeXML", String.class, Vector.class, int.class, Map.class).invoke(w, "image.tif", types, 1, new HashMap<String, String>());
            res = J.o("ok", ok, "xml", Files.exists(out) ? new String(Files.readAllBytes(out), "UTF-8").replace("\r\n", "\n") : null);
        } catch (Throwable t) { res = J.o("error", String.valueOf(t) + (t.getCause() != null ? " / " + t.getCause() : "")); }
        // panel layout (components of the window in order) was captured by DialogCapture into fiji-dialogs.json
        new Fx("fiji/cellcounter", "markers_xml", "cellCounter")
            .call("sc.fiji.cellCounter.WriteXML(path).writeXML(imageFilePath, Vector<CellCntrMarkerVector> of 8 types (3,1,0,2,0,0,0,1 markers), currentType=1, options map = empty): the Fiji-written CellCounter_Marker_File XML")
            .put("markers", J.o("Type1", Arrays.asList(new int[]{10, 12, 1}, new int[]{20, 30, 1}, new int[]{33, 8, 1}), "Type2", Arrays.asList(new int[]{40, 40, 1}),
                "Type4", Arrays.asList(new int[]{5, 50, 1}, new int[]{15, 55, 1}), "Type8", Arrays.asList(new int[]{60, 10, 1})))
            .put("lineEnding", "xml normalised to LF (Fiji writes System.lineSeparator(): CRLF on the Windows capture machine)")
            .put("result", res).write();
    }

    // ------------------------------------------------------------------ RoiSet.zip written by the ImageJ 1.54p RoiManager inside Fiji
    static void roiSet() throws Exception {
        Path tmp = Files.createTempDirectory("w3rs");
        ImagePlus imp = new ImagePlus("rs", FijiRefs.blobs8(64, 48, 3));
        imp.show();
        ij.plugin.frame.RoiManager rm = new ij.plugin.frame.RoiManager(false);
        Roi[] rois = {new Roi(5, 4, 20, 14), new OvalRoi(10, 8, 22, 16), new PolygonRoi(new int[]{4, 40, 50, 20}, new int[]{30, 28, 44, 46}, 4, Roi.POLYGON),
            new Line(3, 3, 55, 40), new PointRoi(new int[]{10, 30, 46}, new int[]{10, 8, 20}, 3)};
        for (int i = 0; i < rois.length; i++) { imp.setRoi(rois[i]); rm.addRoi(rois[i]); }
        Path zip = tmp.resolve("RoiSet.zip");
        boolean ok = rm.runCommand("Save", zip.toString());
        List<Object> entries = new ArrayList<>();
        if (Files.exists(zip)) try (java.util.zip.ZipFile zf = new java.util.zip.ZipFile(zip.toFile())) {
            for (java.util.Enumeration<? extends java.util.zip.ZipEntry> e = zf.entries(); e.hasMoreElements(); ) {
                java.util.zip.ZipEntry ze = e.nextElement();
                entries.add(J.o("name", ze.getName(), "method", ze.getMethod() == java.util.zip.ZipEntry.DEFLATED ? "DEFLATED" : "STORED", "size", ze.getSize(), "compressedSize", ze.getCompressedSize(), "crc", ze.getCrc()));
            }
        }
        new Fx("fiji/roiset", "roiset_zip", "roiSet")
            .call("RoiManager(false).addRoi x5; runCommand(\"Save\", path.zip): the zip the Fiji distribution writes (DEFLATED entries named <label>.roi)")
            .put("kind", "roi-file").put("saved", ok).put("entries", entries)
            .put("zipB64", Files.exists(zip) ? Base64.getEncoder().encodeToString(Files.readAllBytes(zip)) : null).write();
        imp.changes = false;
        imp.close();
    }
}
