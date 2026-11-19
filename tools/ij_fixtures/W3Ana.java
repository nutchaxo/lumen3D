import ij.*;
import ij.gui.*;
import ij.measure.*;
import ij.plugin.filter.*;
import ij.process.*;
import java.util.*;

/** ana: ParticleAnalyzer Show outputs / filters / options, invert-Y rows, Histogram 16/32-bit, ProfilePlot (rectangle, vertical). */
final class W3Ana {
    static final int M = Measurements.AREA + Measurements.MEAN + Measurements.STD_DEV + Measurements.MODE + Measurements.MIN_MAX
        + Measurements.CENTROID + Measurements.CENTER_OF_MASS + Measurements.PERIMETER + Measurements.RECT + Measurements.ELLIPSE
        + Measurements.SHAPE_DESCRIPTORS + Measurements.FERET + Measurements.INTEGRATED_DENSITY + Measurements.MEDIAN
        + Measurements.SKEWNESS + Measurements.KURTOSIS + Measurements.AREA_FRACTION;

    static void run() throws Exception {
        particles();
        particleCalibrated();
        invertY();
        histogram();
        profile();
    }

    /** Result table -> {headings, rows} (row-number column dropped; Label column as strings). */
    static Map<String, Object> table(ResultsTable rt) {
        String[] hs = rt.getHeadings();
        List<Object> heads = new ArrayList<>();
        List<Object> rows = new ArrayList<>();
        List<Integer> idx = new ArrayList<>();
        for (String h : hs) { if (h == null || h.trim().isEmpty() || h.equals(" ")) continue; heads.add(h); idx.add(rt.getColumnIndex(h)); }
        for (int r = 0; r < rt.size(); r++) {
            List<Object> row = new ArrayList<>();
            for (int k = 0; k < heads.size(); k++) {
                int c = idx.get(k);
                if (c == ResultsTable.COLUMN_NOT_FOUND) row.add(rt.getStringValue((String) heads.get(k), r));
                else row.add(rt.getValueAsDouble(c, r));
            }
            rows.add(row);
        }
        return J.o("headings", heads, "rows", rows);
    }

    static ByteProcessor particleImage() {
        int w = 72, h = 56;
        ByteProcessor ip = new ByteProcessor(w, h);
        Gen.disk(ip, 15, 15, 8.5, 255); Gen.disk(ip, 26, 17, 7.5, 255);   // touching pair
        Gen.disk(ip, 15, 15, 2.2, 0);                                      // hole in the first
        Gen.disk(ip, 3, 32, 6.5, 255);                                     // touches the left edge
        Gen.disk(ip, 50, 38, 9, 255); Gen.disk(ip, 50, 38, 4.5, 0); Gen.disk(ip, 50, 38, 1.6, 255);   // ring with an island
        ip.set(40, 5, 255);                                                // 1 px speck
        for (int y = 44; y < 47; y++) for (int x = 8; x < 14; x++) ip.set(x, y, 255);                 // 6x3 block
        Gen.line(ip, 20, 46, 34, 52, 1);                                   // diagonal line
        for (int y = 0; y < 5; y++) for (int x = w - 6; x < w; x++) ip.set(x, y, 255);                 // corner block
        return ip;
    }

    static ImagePlus thresholded(ImageProcessor ip) {
        ImagePlus imp = Gen.imp("p", ip);
        ip.setThreshold(bitsHi(ip) ? 255 : 255, 255, ImageProcessor.NO_LUT_UPDATE);
        return imp;
    }

    static boolean bitsHi(ImageProcessor ip) { return true; }

    static final String[] SHOW = {"Nothing", "Outlines", "Bare Outlines", "Ellipses", "Masks", "Count Masks", "Overlay", "Overlay Masks"};

    static Map<String, Object> analyze(ImageProcessor src, int options, int showChoice, double minSize, double maxSize, double minCirc, double maxCirc, int measurements, Calibration cal) throws Exception {
        ImageProcessor ip = src.duplicate();
        ImagePlus imp = Gen.imp("p", ip);
        if (cal != null) imp.setCalibration(cal);
        ip.setThreshold(255, 255, ImageProcessor.NO_LUT_UPDATE);
        ResultsTable rt = new ResultsTable();
        Overlay ov0 = null;
        ParticleAnalyzer pa = new ParticleAnalyzer(options | ParticleAnalyzer.CLEAR_WORKSHEET, measurements, rt, minSize, maxSize, minCirc, maxCirc);
        if (showChoice > 0) Gen.set(pa, "showChoice", showChoice);
        // IN_SITU etc. are not used; ADD_TO_MANAGER is not used (no manager in a fixture run)
        boolean ok = pa.analyze(imp, ip);
        LinkedHashMap<String, Object> out = new LinkedHashMap<>();
        out.put("ok", ok);
        out.put("count", rt.size());
        out.put("table", table(rt));
        ImagePlus o = pa.getOutputImage();
        if (o != null) {
            out.put("outputTitle", o.getTitle());
            out.put("outputInvertedLut", o.getProcessor().isInvertedLut());
            out.put("output", J.image(o.getProcessor()));
        }
        if (imp.getOverlay() != null) out.put("overlayCount", imp.getOverlay().size());
        return out;
    }

    static void particles() throws Exception {
        ByteProcessor img = particleImage();
        List<Object> cases = new ArrayList<>();
        Object[][] defs = {
            // name, options, show, min, max, minC, maxC
            {"default", 0, 0, 0.0, Double.POSITIVE_INFINITY, 0.0, 1.0},
            {"size_20_300", 0, 0, 20.0, 300.0, 0.0, 1.0},
            {"circ_0p6_1", 0, 0, 0.0, Double.POSITIVE_INFINITY, 0.6, 1.0},
            {"exclude_edges", ParticleAnalyzer.EXCLUDE_EDGE_PARTICLES, 0, 0.0, Double.POSITIVE_INFINITY, 0.0, 1.0},
            {"include_holes", ParticleAnalyzer.INCLUDE_HOLES, 0, 0.0, Double.POSITIVE_INFINITY, 0.0, 1.0},
            {"record_starts", ParticleAnalyzer.RECORD_STARTS, 0, 0.0, Double.POSITIVE_INFINITY, 0.0, 1.0},
            {"four_connected", ParticleAnalyzer.FOUR_CONNECTED, 0, 0.0, Double.POSITIVE_INFINITY, 0.0, 1.0},
            {"show_outlines", 0, 1, 0.0, Double.POSITIVE_INFINITY, 0.0, 1.0},
            {"show_bare_outlines", 0, 2, 0.0, Double.POSITIVE_INFINITY, 0.0, 1.0},
            {"show_ellipses", 0, 3, 0.0, Double.POSITIVE_INFINITY, 0.0, 1.0},
            {"show_masks", 0, 4, 0.0, Double.POSITIVE_INFINITY, 0.0, 1.0},
            {"show_count_masks", 0, 5, 0.0, Double.POSITIVE_INFINITY, 0.0, 1.0},
            {"show_masks_include_holes", ParticleAnalyzer.INCLUDE_HOLES, 4, 0.0, Double.POSITIVE_INFINITY, 0.0, 1.0},
            {"show_count_masks_exclude_edges", ParticleAnalyzer.EXCLUDE_EDGE_PARTICLES, 5, 0.0, Double.POSITIVE_INFINITY, 0.0, 1.0},
            {"show_overlay", 0, 6, 0.0, Double.POSITIVE_INFINITY, 0.0, 1.0},
            {"show_overlay_masks", 0, 7, 0.0, Double.POSITIVE_INFINITY, 0.0, 1.0}
        };
        for (Object[] d : defs) {
            Object res;
            try { res = analyze(img, (Integer) d[1], (Integer) d[2], (Double) d[3], (Double) d[4], (Double) d[5], (Double) d[6], M, null); }
            catch (Throwable t) { res = J.o("error", String.valueOf(t)); }
            cases.add(J.o("name", d[0], "params", J.o("options", d[1], "show", SHOW[(Integer) d[2]], "showChoice", d[2], "minSize", d[3], "maxSize", d[4], "minCirc", d[5], "maxCirc", d[6]), "result", res));
        }
        new Fx("ana", "particles", "particleImage")
            .call("new ParticleAnalyzer(options|CLEAR_WORKSHEET, measurements, rt, minSize, maxSize, minCirc, maxCirc); showChoice set by reflection (Outlines=1, Bare Outlines=2, Ellipses=3, Masks=4, Count Masks=5 = ROI_MASKS, Overlay=6, Overlay Masks=7); pa.analyze(imp, ip); pa.getOutputImage(). 'Outlines' draw labels (text pixels depend on the Java font: do not compare those pixels)")
            .input(img).put("measurements", M).put("cases", cases).write();
    }

    static void particleCalibrated() throws Exception {
        ByteProcessor img = particleImage();
        List<Object> cases = new ArrayList<>();
        for (double minSize : new double[]{0.0, 5.0, 12.5}) {
            Calibration cal = new Calibration();
            cal.pixelWidth = 0.5; cal.pixelHeight = 0.5; cal.setUnit("um");
            Object res;
            try { res = analyze(img, 0, 0, minSize, Double.POSITIVE_INFINITY, 0.0, 1.0, M, cal); } catch (Throwable t) { res = J.o("error", String.valueOf(t)); }
            cases.add(J.o("params", J.o("minSize", minSize, "pixelWidth", 0.5, "unit", "um"), "result", res));
        }
        new Fx("ana", "particles_calibrated", "analyzeParticles")
            .call("same constructor on a calibrated image (0.5 um/pixel): minSize is in calibrated units^2 (Pixel units off)")
            .input(img).put("cases", cases).write();
    }

    static void invertY() throws Exception {
        List<Object> cases = new ArrayList<>();
        Roi[] rois = {new Roi(10, 8, 30, 20), new OvalRoi(12, 6, 28, 22), W3Sel.intPoly(Roi.POLYGON, 8, 6, 40, 10, 52, 30, 30, 22, 36, 40, 14, 34)};
        String[] nm = {"rect", "oval", "polygon"};
        for (int i = 0; i < rois.length; i++) for (int cal = 0; cal < 2; cal++) for (int inv = 0; inv < 2; inv++) {
            ImagePlus imp = Gen.imp("t", Gen.tex(8, 64, 48, 5));
            if (cal == 1) { Calibration c = imp.getCalibration(); c.pixelWidth = 0.5; c.pixelHeight = 0.5; c.setUnit("um"); }
            imp.setRoi((Roi) rois[i].clone());
            int meas = M + (inv == 1 ? Measurements.INVERT_Y : 0);
            ResultsTable rt = new ResultsTable();
            Analyzer a = new Analyzer(imp, meas, rt);
            a.measure();
            cases.add(J.o("name", nm[i], "params", J.o("invertY", inv == 1, "pixelWidth", cal == 1 ? 0.5 : 1.0), "table", table(rt)));
        }
        new Fx("ana", "invert_y", "measure")
            .call("new Analyzer(imp, measurements [+INVERT_Y], rt).measure(): Y, YM, BY (and FeretY) become height*pixelHeight - value")
            .put("cases", cases).write();
    }

    static void histogram() throws Exception {
        List<Object> cases = new ArrayList<>();
        ImageProcessor ip16 = Gen.tex(16, 48, 40, 9);
        ImageProcessor ip32 = Gen.tex(32, 48, 40, 9);
        float[] f = (float[]) ip32.getPixels();
        f[3] = Float.NaN; f[100] = Float.NaN;
        ImageProcessor[] ims = {ip16, ip32};
        double[][] rng = {{0, 0}, {0, 0}, {0, 0}, {5000, 40000}, {-50, 300}, {100, 100}};
        int[] bins = {256, 64, 1000, 100, 100, 256};
        for (ImageProcessor ip : ims) for (int k = 0; k < rng.length; k++) {
            ImagePlus imp = Gen.imp("h", ip.duplicate());
            ImageStatistics st = imp.getStatistics(Measurements.AREA + Measurements.MEAN + Measurements.MODE + Measurements.MIN_MAX, bins[k], rng[k][0], rng[k][1]);
            cases.add(J.o("bitDepth", ip.getBitDepth(), "params", J.o("bins", bins[k], "xMin", rng[k][0], "xMax", rng[k][1]),
                "histogram", st.histogram, "histMin", st.histMin, "histMax", st.histMax, "binSize", st.binSize, "min", st.min, "max", st.max,
                "mean", st.mean, "mode", st.dmode, "pixelCount", st.pixelCount, "maxCount", st.maxCount));
        }
        // 16-bit full-range histogram of the 16-bit data (bins 65536 = histogram16)
        ImagePlus i16 = Gen.imp("h", ip16.duplicate());
        ImageStatistics s16 = i16.getStatistics(Measurements.AREA + Measurements.MEAN + Measurements.MODE + Measurements.MIN_MAX);
        new Fx("ana", "histogram", "histogram")
            .call("imp.getStatistics(AREA+MEAN+MODE+MIN_MAX, bins, histMin, histMax) as HistogramPlot.draw(imp, bins, xMin, xMax, yMax); (0,0) = pixel value range; 32-bit NaN pixels are ignored")
            .input(ip16).put("input32", J.image(ip32)).put("cases", cases)
            .put("histogram16Default", s16.histogram).put("histogram16Length", s16.getHistogram().length).write();
    }

    static void profile() throws Exception {
        List<Object> cases = new ArrayList<>();
        for (int bits : new int[]{8, 16, 32}) {
            ImageProcessor ip = Gen.tex(bits, 48, 36, 13);
            Roi[] rois = {new Roi(5, 4, 20, 14), new Roi(0, 0, 48, 36), new Line(4, 30, 40, 6), new Line(4, 30, 40, 6), W3Sel.intPoly(Roi.POLYLINE, 4, 30, 16, 8, 28, 28, 42, 10)};
            String[] nm = {"rect", "rect_whole", "line_w1", "line_w5", "polyline"};
            for (int i = 0; i < rois.length; i++) for (int vert = 0; vert < 2; vert++) for (int interp = 0; interp < 2; interp++) {
                if (i >= 2 && vert == 1) continue;
                ImagePlus imp = Gen.imp("t", ip.duplicate());
                Roi r = (Roi) rois[i].clone();
                if (nm[i].equals("line_w5")) r.setStrokeWidth(5);
                imp.setRoi(r);
                PlotWindow.interpolate = interp == 1;
                Object res;
                try {
                    ProfilePlot pp = new ProfilePlot(imp, vert == 1);
                    res = J.o("profile", pp.getProfile(), "min", pp.getMin(), "max", pp.getMax());
                } catch (Throwable t) { res = J.o("error", String.valueOf(t)); }
                cases.add(J.o("bitDepth", bits, "name", nm[i], "params", J.o("vertical", vert == 1, "interpolate", interp == 1), "roi", W3Sel.roiFull(r), "result", res));
            }
        }
        PlotWindow.interpolate = true;
        new Fx("ana", "profile", "profile")
            .call("new ProfilePlot(imp, verticalPlot).getProfile(): rectangle = ProfilePlot.getColumnAverageProfile (vertical: rows), lines = getLine/getIrregularProfile; PlotWindow.interpolate")
            .put("input8", J.image(Gen.tex(8, 48, 36, 13))).put("cases", cases).write();
    }
}
