import ij.*;
import ij.gui.*;
import ij.measure.*;
import ij.plugin.RoiEnlarger;
import ij.plugin.filter.Analyzer;
import ij.plugin.filter.EDM;
import ij.plugin.filter.ThresholdToSelection;
import ij.process.*;
import java.awt.Polygon;
import java.util.*;

/** P6: measurements, Wand, Enlarge, Create Mask / Selection, hull, fit ellipse, profile, angle. */
final class P6 {
    static void run() throws Exception {
        measure();
        wand();
        enlarge();
        selections();
        hullAndEllipse();
        profile();
        angle();
    }

    // ------------------------------------------------------------ shared
    static final int ALL = Measurements.AREA | Measurements.MEAN | Measurements.STD_DEV | Measurements.MODE | Measurements.MIN_MAX
        | Measurements.CENTROID | Measurements.CENTER_OF_MASS | Measurements.PERIMETER | Measurements.RECT | Measurements.ELLIPSE
        | Measurements.SHAPE_DESCRIPTORS | Measurements.FERET | Measurements.INTEGRATED_DENSITY | Measurements.MEDIAN
        | Measurements.SKEWNESS | Measurements.KURTOSIS | Measurements.AREA_FRACTION;

    static Roi polygon() {
        return new PolygonRoi(new int[]{12, 40, 52, 44, 24, 10, 18}, new int[]{10, 14, 30, 52, 48, 34, 22}, 7, Roi.POLYGON);
    }

    /** A traced (wand) outline of a thresholded blob, as a TRACED_ROI. */
    static Roi traced(ImageProcessor ip, int x, int y, double lo, double hi) {
        Wand w = new Wand(ip);
        w.autoOutline(x, y, lo, hi, Wand.EIGHT_CONNECTED);
        return new PolygonRoi(Arrays.copyOf(w.xpoints, w.npoints), Arrays.copyOf(w.ypoints, w.npoints), w.npoints, Roi.TRACED_ROI);
    }

    static ByteProcessor blobs8(int w, int h, long seed, int level) {
        ByteProcessor ip = (ByteProcessor) Gen.make(8, Gen.blobs(w, h, seed, 8, 4.0, 8.0, 0.0, 0.0, 0.03, 0.0), w, h);
        ip.threshold(level);
        return ip;
    }

    static Map<String, Object> roiOut(Roi r) {
        LinkedHashMap<String, Object> m = new LinkedHashMap<>();
        if (r == null) return null;
        java.awt.Rectangle b = r.getBounds();
        m.put("class", r.getClass().getSimpleName());
        m.put("bounds", J.o("x", b.x, "y", b.y, "w", b.width, "h", b.height));
        if (r.getType() == Roi.RECTANGLE) m.put("type", "rect");
        else if (r.getType() == Roi.OVAL) m.put("type", "oval");
        else m.put("type", "polygon");
        Map<String, Object> mk = J.mask(r);
        if (mk != null) m.put("mask", mk);
        List<Object> polys = new ArrayList<>();
        if (r instanceof ShapeRoi) {
            for (Roi s : ((ShapeRoi) r).getRois()) polys.add(fp(s.getFloatPolygon()));
        } else polys.add(fp(r.getFloatPolygon()));
        m.put("polygons", polys);
        return m;
    }

    static float[] fp(FloatPolygon p) { return J.floatPts(p.xpoints, p.ypoints, p.npoints); }

    // ------------------------------------------------------------ measure
    static void meas(String name, int bits, Roi roi, double pw, double ph, ImageProcessor given) throws Exception {
        ImageProcessor ip = given != null ? given : Gen.make(bits, Gen.blobs(64, 64, 1000 + bits, 7, 4, 9, 0.2, 0.1, 0.08, 0.04), 64, 64);
        ImageProcessor in = ip.duplicate();
        ImagePlus imp = Gen.imp("m", ip);
        boolean cal = pw != 1 || ph != 1;
        if (cal) { Calibration c = imp.getCalibration(); c.pixelWidth = pw; c.pixelHeight = ph; c.setUnit("micron"); }
        if (roi != null) imp.setRoi(roi);
        ResultsTable rt = new ResultsTable();
        Analyzer an = new Analyzer(imp, ALL, rt);
        an.measure();
        LinkedHashMap<String, Object> cols = new LinkedHashMap<>();
        for (String h : rt.getHeadings()) {
            if (h == null) continue;
            int idx = rt.getColumnIndex(h);
            if (idx == ResultsTable.COLUMN_NOT_FOUND || !rt.columnExists(idx)) continue;
            cols.put(h, rt.getValueAsDouble(idx, 0));
        }
        Fx f = new Fx("roi", name, "measure")
            .call("imp.setRoi(roi); new Analyzer(imp, measurements, rt).measure() -> saveResults(imp.getStatistics(measurements), roi); perimeter=roi.getLength(), Feret=roi.getFeretValues(), Solidity=pixelCount/area(roi.getConvexHull())")
            .params("measurements", "area,mean,std,mode,minmax,centroid,center_of_mass,perimeter,rect,ellipse,shape,feret,intden,median,skew,kurt,area_fraction",
                    "calibration", cal ? J.o("pixelWidth", pw, "pixelHeight", ph, "unit", "micron") : null)
            .input(in);
        if (roi != null) f.roi(roi);
        f.result(J.o("columns", cols)).write();
    }

    static void measure() throws Exception {
        ByteProcessor bm = blobs8(64, 64, 1100, 70);
        Roi[] rois = {new Roi(10, 12, 23, 17), new OvalRoi(8, 10, 30, 22), polygon(), traced(bm, 0, 0, 255, 255)};
        String[] rn = {"rect", "oval", "polygon", "traced"};
        // traced: seed from the first foreground pixel of the thresholded blobs
        int sx = -1, sy = -1;
        for (int y = 0; y < 64 && sx < 0; y++) for (int x = 0; x < 64; x++) if (bm.get(x, y) == 255) { sx = x; sy = y; break; }
        rois[3] = traced(bm, sx, sy, 255, 255);
        for (int i = 0; i < 4; i++) meas("measure_" + rn[i] + "_u16", 16, rois[i], 1, 1, null);
        for (int i = 0; i < 4; i++) meas("measure_" + rn[i] + "_u8", 8, rois[i], 1, 1, null);
        meas("measure_oval_f32", 32, rois[1], 1, 1, null);
        meas("measure_polygon_f32", 32, rois[2], 1, 1, null);
        meas("measure_none_u16", 16, null, 1, 1, null);
        meas("measure_polygon_u16_cal0p35", 16, rois[2], 0.35, 0.35, null);
        meas("measure_oval_u16_cal0p5x0p3", 16, rois[1], 0.5, 0.3, null);
        meas("measure_rect_u16_cal0p5x0p3", 16, rois[0], 0.5, 0.3, null);
        meas("measure_traced_u16_cal0p5x0p3", 16, rois[3], 0.5, 0.3, null);
        // thin / degenerate shapes for the shape descriptors and Feret
        meas("measure_rect_thin_u16", 16, new Roi(5, 5, 40, 3), 1, 1, null);
        meas("measure_polygon_triangle_u16", 16, new PolygonRoi(new int[]{5, 50, 20}, new int[]{8, 20, 55}, 3, Roi.POLYGON), 1, 1, null);
        meas("measure_polygon_concave_u16", 16, new PolygonRoi(new int[]{5, 30, 30, 18, 18, 5}, new int[]{5, 5, 40, 40, 20, 20}, 6, Roi.POLYGON), 1, 1, null);
        meas("measure_oval_small_u8", 8, new OvalRoi(20, 20, 7, 5), 1, 1, null);
        // threshold-aware rows: %Area counts the thresholded pixels; Limit to threshold restricts every statistic to them
        measThreshold("measure_threshold_polygon_u16", 16, rois[2], 12000, 30000, false);
        measThreshold("measure_threshold_limit_polygon_u16", 16, rois[2], 12000, 30000, true);
        measThreshold("measure_threshold_limit_oval_u8", 8, rois[1], 40, 140, true);
        measThreshold("measure_threshold_limit_none_f32", 32, null, 20, 150, true);
        // multi-point selection: one row per point
        measPoints("measure_points_u16", 16, new float[]{5, 20.4f, 33, 60}, new float[]{7, 11.6f, 40, 3}, 1, 1);
        measPoints("measure_points_cal0p5x0p3_f32", 32, new float[]{5, 20, 33}, new float[]{7, 12, 40}, 0.5, 0.3);
        // line measurements (Length / Angle) and straight / segmented profile values
        lineMeasure("measure_line_u16", new Line(5.5, 6.25, 50.25, 30.75), 1, 1);
        lineMeasure("measure_line_cal0p5x0p3", new Line(5.5, 6.25, 50.25, 30.75), 0.5, 0.3);
        lineMeasure("measure_polyline_u16", new PolygonRoi(new float[]{5, 20, 33, 12}, new float[]{5, 12, 40, 50}, 4, Roi.POLYLINE), 1, 1);
        lineMeasure("measure_polyline_cal0p5x0p3", new PolygonRoi(new float[]{5, 20, 33, 12}, new float[]{5, 12, 40, 50}, 4, Roi.POLYLINE), 0.5, 0.3);
    }

    static Map<String, Object> row(ResultsTable rt, int r) {
        LinkedHashMap<String, Object> cols = new LinkedHashMap<>();
        for (String h : rt.getHeadings()) {
            if (h == null) continue;
            int idx = rt.getColumnIndex(h);
            if (idx == ResultsTable.COLUMN_NOT_FOUND || !rt.columnExists(idx)) continue;
            cols.put(h, rt.getValueAsDouble(idx, r));
        }
        return cols;
    }

    static void measThreshold(String name, int bits, Roi roi, double lo, double hi, boolean limit) throws Exception {
        ImageProcessor ip = Gen.make(bits, Gen.blobs(64, 64, 1000 + bits, 7, 4, 9, 0.2, 0.1, 0.08, 0.04), 64, 64);
        ImageProcessor in = ip.duplicate();
        ImagePlus imp = Gen.imp("m", ip);
        if (roi != null) imp.setRoi(roi);
        ip.setThreshold(lo, hi, ImageProcessor.NO_LUT_UPDATE);
        ResultsTable rt = new ResultsTable();
        new Analyzer(imp, ALL | (limit ? Measurements.LIMIT : 0), rt).measure();
        Fx f = new Fx("roi", name, "measure")
            .call("ip.setThreshold(lower, upper, NO_LUT_UPDATE); imp.setRoi(roi); new Analyzer(imp, measurements" + (limit ? " | LIMIT" : "") + ", rt).measure()")
            .params("measurements", "area,mean,std,mode,minmax,centroid,center_of_mass,perimeter,rect,ellipse,shape,feret,intden,median,skew,kurt,area_fraction" + (limit ? ",limit" : ""),
                    "threshold", J.o("lower", lo, "upper", hi), "limit", limit, "calibration", null)
            .input(in);
        if (roi != null) f.roi(roi);
        f.result(J.o("columns", row(rt, 0))).write();
    }

    static void measPoints(String name, int bits, float[] xs, float[] ys, double pw, double ph) throws Exception {
        ImageProcessor ip = Gen.make(bits, Gen.blobs(64, 64, 1000 + bits, 7, 4, 9, 0.2, 0.1, 0.08, 0.04), 64, 64);
        ImageProcessor in = ip.duplicate();
        ImagePlus imp = Gen.imp("m", ip);
        boolean cal = pw != 1 || ph != 1;
        if (cal) { Calibration c = imp.getCalibration(); c.pixelWidth = pw; c.pixelHeight = ph; c.setUnit("micron"); }
        imp.setRoi(new PointRoi(xs, ys, xs.length));
        ResultsTable rt = new ResultsTable();
        new Analyzer(imp, Measurements.AREA | Measurements.MEAN | Measurements.MIN_MAX | Measurements.CENTROID, rt).measure();
        List<Object> rows = new ArrayList<>();
        for (int r = 0; r < rt.size(); r++) rows.add(row(rt, r));
        new Fx("roi", name, "measurePoints")
            .call("imp.setRoi(new PointRoi(xs, ys, n)); new Analyzer(imp, AREA|MEAN|MIN_MAX|CENTROID, rt).measure() -> measurePoint: one row per point (value read at the integer pixel containing the point)")
            .params("pts", J.floatPts(xs, ys, xs.length), "calibration", cal ? J.o("pixelWidth", pw, "pixelHeight", ph, "unit", "micron") : null)
            .input(in).result(J.o("rows", rows)).write();
    }

    static void lineMeasure(String name, Roi roi, double pw, double ph) throws Exception {
        ImageProcessor ip = Gen.make(16, Gen.blobs(64, 64, 1016, 7, 4, 9, 0.2, 0.1, 0.08, 0.04), 64, 64);
        ImageProcessor in = ip.duplicate();
        ImagePlus imp = Gen.imp("m", ip);
        boolean cal = pw != 1 || ph != 1;
        if (cal) { Calibration c = imp.getCalibration(); c.pixelWidth = pw; c.pixelHeight = ph; c.setUnit("micron"); }
        imp.setRoi(roi);
        ResultsTable rt = new ResultsTable();
        new Analyzer(imp, Measurements.AREA | Measurements.MEAN | Measurements.MIN_MAX, rt).measure();
        LinkedHashMap<String, Object> cols = new LinkedHashMap<>();
        for (String h : rt.getHeadings()) {
            if (h == null) continue;
            int idx = rt.getColumnIndex(h);
            if (idx == ResultsTable.COLUMN_NOT_FOUND || !rt.columnExists(idx)) continue;
            cols.put(h, rt.getValueAsDouble(idx, 0));
        }
        new Fx("roi", name, "measureLine")
            .call("imp.setRoi(line); new Analyzer(imp, AREA|MEAN|MIN_MAX, rt).measure() -> measureLength(roi): Length=roi.getLength() (calibrated), Angle=Line.getFloatAngle")
            .params("roi", lineJson(roi), "calibration", cal ? J.o("pixelWidth", pw, "pixelHeight", ph, "unit", "micron") : null)
            .input(in).result(J.o("columns", cols)).write();
    }

    static Map<String, Object> lineJson(Roi r) {
        if (r instanceof Line) {
            Line l = (Line) r;
            return J.o("type", "line", "x1", l.x1d, "y1", l.y1d, "x2", l.x2d, "y2", l.y2d, "width", r.getStrokeWidth());
        }
        return J.o("type", "polyline", "pts", fp(r.getFloatPolygon()), "width", r.getStrokeWidth());
    }

    // ------------------------------------------------------------ wand
    static ImageProcessor terraces(int bits, int w, int h, long seed, int step) {
        ImageProcessor ip = Gen.tex(bits, w, h, seed);
        for (int i = 0; i < w * h; i++) {
            float v = ip.getf(i % w, i / w);
            double unit = bits == 8 ? 1 : bits == 16 ? 200 : 0.01;
            float q = (float) (Math.floor(v / (step * unit)) * step * unit);
            ip.setf(i % w, i / w, q);
        }
        return ip;
    }

    static ByteProcessor diagonal(int w, int h) {
        ByteProcessor ip = new ByteProcessor(w, h);
        for (int y = 5; y < 10; y++) for (int x = 5; x < 10; x++) ip.set(x, y, 255);
        for (int y = 10; y < 15; y++) for (int x = 10; x < 15; x++) ip.set(x, y, 255);      // touches the first at a corner
        for (int y = 3; y < 18; y++) ip.set(20, y, 255);
        for (int x = 20; x < 30; x++) ip.set(x, 17, 255);
        for (int y = 5; y < 12; y++) for (int x = 24; x < 31; x++) ip.set(x, y, 255);
        ip.set(26, 8, 0); ip.set(27, 8, 0); ip.set(26, 9, 0);                                 // hole
        ip.set(31, 12, 255); ip.set(32, 13, 255);                                              // diagonal tail
        return ip;
    }

    static void wandCase(String name, ImageProcessor ip, int x, int y, double tol, int mode) {
        ImageProcessor in = ip.duplicate();
        Wand wd = new Wand(ip);
        wd.autoOutline(x, y, tol, mode);
        int[] px = Arrays.copyOf(wd.xpoints, wd.npoints), py = Arrays.copyOf(wd.ypoints, wd.npoints);
        int[] pts = new int[2 * wd.npoints];
        for (int i = 0; i < wd.npoints; i++) { pts[2 * i] = px[i]; pts[2 * i + 1] = py[i]; }
        Roi r = new PolygonRoi(px, py, wd.npoints, Roi.TRACED_ROI);
        new Fx("roi", name, "wand")
            .call("new Wand(ip).autoOutline(x, y, tolerance, " + (mode == 4 ? "Wand.FOUR_CONNECTED" : "Wand.EIGHT_CONNECTED") + "); xpoints/ypoints[0..npoints) = outline vertices in ImageJ order (traced, ccw/cw as ImageJ emits)")
            .params("x", x, "y", y, "tolerance", tol, "connectivity", mode)
            .input(in)
            .result(J.o("pts", pts, "mask", J.mask(r), "bounds", J.o("x", r.getBounds().x, "y", r.getBounds().y, "w", r.getBounds().width, "h", r.getBounds().height)))
            .write();
    }

    static void wand() {
        ByteProcessor d = diagonal(40, 24);
        for (int mode : new int[]{4, 8}) {
            String m = "c" + mode;
            wandCase("wand_diag_square_" + m + "_t0", d, 7, 7, 0, mode);
            wandCase("wand_diag_lshape_" + m + "_t0", d, 20, 10, 0, mode);
            wandCase("wand_diag_block_hole_" + m + "_t0", d, 28, 10, 0, mode);
            wandCase("wand_diag_background_" + m + "_t0", d, 1, 1, 0, mode);
            wandCase("wand_diag_tail_" + m + "_t0", d, 31, 12, 0, mode);
        }
        for (int bits : new int[]{8, 16, 32}) {
            String s = bits == 8 ? "u8" : bits == 16 ? "u16" : "f32";
            ImageProcessor t = terraces(bits, 48, 40, 1200 + bits, 6);
            double unit = bits == 8 ? 1 : bits == 16 ? 200 : 0.01;
            int[][] seeds = {{10, 10}, {30, 20}, {40, 33}};
            for (int mode : new int[]{4, 8}) for (double tol : new double[]{0, 10}) for (int k = 0; k < seeds.length; k++)
                wandCase("wand_terraces_" + s + "_c" + mode + "_t" + (int) tol + "_s" + k, t, seeds[k][0], seeds[k][1], tol * unit, mode);
        }
        // a tolerance-0 wand on gaussian blobs touching the image border
        wandCase("wand_blobs_u8_c8_t0_border", Gen.tex(8, 48, 40, 1300), 0, 0, 0, 8);
    }

    // ------------------------------------------------------------ enlarge
    static void enlarge() {
        Roi[] rs = {new Roi(10, 10, 14, 11), new OvalRoi(9, 8, 17, 13), new PolygonRoi(new int[]{10, 30, 38, 22, 8}, new int[]{8, 10, 26, 34, 24}, 5, Roi.POLYGON),
            traced(diagonal(40, 24), 7, 7, 255, 255), new PolygonRoi(new int[]{5, 40, 40, 20, 20, 5}, new int[]{5, 5, 40, 40, 20, 20}, 6, Roi.POLYGON)};
        String[] rn = {"rect", "oval", "polygon", "traced", "concave"};
        int[] ns = {3, -2, 1, -5};
        for (int i = 0; i < rs.length; i++) for (int n : ns) {
            Roi base = (Roi) rs[i].clone();
            Roi menu = RoiEnlarger.enlarge255((Roi) rs[i].clone(), n);
            Roi exact = RoiEnlarger.enlarge((Roi) rs[i].clone(), n);
            new Fx("roi", "enlarge_" + rn[i] + "_" + (n < 0 ? "m" : "p") + Math.abs(n), "enlargeRoi")
                .call("RoiEnlarger.enlarge255(roi, n) [= the Edit>Selection>Enlarge command for |n|<256] and RoiEnlarger.enlarge(roi, n) [EDM float path], n=" + n + "; rect/oval keep their type (bounds +-n)")
                .params("n", n)
                .roi(base)
                .result(J.o("menu", roiOut(menu), "exact", roiOut(exact)))
                .write();
        }
    }

    // ------------------------------------------------------------ create mask / selection
    static void selections() {
        // Create Mask
        Roi[] rs = {new Roi(6, 5, 17, 11), new OvalRoi(5, 4, 21, 14), new PolygonRoi(new int[]{4, 30, 36, 20, 6}, new int[]{4, 6, 22, 32, 20}, 5, Roi.POLYGON), traced(diagonal(40, 24), 28, 10, 255, 255)};
        String[] rn = {"rect", "oval", "polygon", "traced"};
        for (int i = 0; i < rs.length; i++) {
            ImagePlus imp = Gen.imp("c", new ByteProcessor(48, 36));
            imp.setRoi(rs[i]);
            ByteProcessor mask = imp.createRoiMask();
            new Fx("roi", "createmask_" + rn[i], "createMask")
                .call("imp.setRoi(roi); imp.createRoiMask() [Selection.createMask: ip.setColor(255); ip.fill(roi)]; output 255 inside")
                .params("width", 48, "height", 36).roi(rs[i]).output(mask).write();
        }
        // Create Selection from a threshold (ThresholdToSelection.convert)
        ImageProcessor[] ins = {blobs8(48, 40, 1400, 70), blobs8(41, 33, 1401, 90), diagonal(40, 24), Gen.tex(16, 48, 40, 1402), Gen.tex(32, 48, 40, 1403), Gen.tex(8, 37, 29, 1404)};
        double[][] th = {{255, 255}, {255, 255}, {255, 255}, {20000, 40000}, {100, 250}, {60, 140}};
        String[] nn = {"blobs_a_u8", "blobs_b_u8", "diag_u8", "tex_u16", "tex_f32", "tex_u8_band"};
        for (int i = 0; i < ins.length; i++) {
            ImageProcessor ip = ins[i].duplicate();
            ip.setThreshold(th[i][0], th[i][1], ImageProcessor.NO_LUT_UPDATE);
            Roi r = new ThresholdToSelection().convert(ip);
            Fx f = new Fx("roi", "threshold2sel_" + nn[i], "createSelection")
                .call("ip.setThreshold(lower, upper, NO_LUT_UPDATE); new ThresholdToSelection().convert(ip) (pixels with lower <= v <= upper); polygons = ShapeRoi.getRois() float polygons, holes are separate sub-polygons")
                .params("lower", th[i][0], "upper", th[i][1])
                .input(ins[i]);
            f.result(r == null ? null : roiOut(r)).write();
        }
    }

    // ------------------------------------------------------------ convex hull and fit ellipse
    static void hullAndEllipse() {
        Roi[] rs = {new Roi(6, 5, 17, 11), new OvalRoi(5, 4, 21, 14), new PolygonRoi(new int[]{4, 30, 36, 20, 6}, new int[]{4, 6, 22, 32, 20}, 5, Roi.POLYGON),
            new PolygonRoi(new int[]{5, 30, 30, 18, 18, 5}, new int[]{5, 5, 40, 40, 20, 20}, 6, Roi.POLYGON), traced(diagonal(40, 24), 28, 10, 255, 255), traced(diagonal(40, 24), 20, 10, 255, 255)};
        String[] rn = {"rect", "oval", "polygon", "concave", "traced_block", "traced_lshape"};
        for (int i = 0; i < rs.length; i++) {
            FloatPolygon h = rs[i].getFloatConvexHull();
            new Fx("roi", "convexhull_" + rn[i], "convexHull")
                .call("Selection.convexHull: roi.getFloatConvexHull() -> new PolygonRoi(p, Roi.POLYGON)")
                .roi(rs[i]).result(J.o("pts", fp(h), "perimeter", new PolygonRoi(h, Roi.POLYGON).getLength())).write();
        }
        ImageProcessor ip = Gen.make(16, Gen.blobs(64, 64, 1500, 7, 4, 9, 0.2, 0.1, 0.08, 0.04), 64, 64);
        for (int i = 0; i < rs.length; i++) {
            ip.setRoi(rs[i]);
            ImageStatistics stats = ImageStatistics.getStatistics(ip, Measurements.CENTROID + Measurements.ELLIPSE, null);
            ip.resetRoi();
            double dx = stats.major * Math.cos(stats.angle / 180.0 * Math.PI) / 2.0;
            double dy = -stats.major * Math.sin(stats.angle / 180.0 * Math.PI) / 2.0;
            double x1 = stats.xCentroid - dx, x2 = stats.xCentroid + dx, y1 = stats.yCentroid - dy, y2 = stats.yCentroid + dy;
            double aspect = stats.minor / stats.major;
            Roi e = new EllipseRoi(x1, y1, x2, y2, aspect);
            new Fx("roi", "fitellipse_" + rn[i], "fitEllipse")
                .call("Selection.createEllipse: ImageStatistics(CENTROID+ELLIPSE) of the selection (stats.major/minor/angle, angle CCW y-up); EllipseRoi(x1,y1,x2,y2,aspectRatio=minor/major); polygon = getFloatPolygon()")
                .roi(rs[i])
                .result(J.o("major", stats.major, "minor", stats.minor, "angle", stats.angle, "xCentroid", stats.xCentroid, "yCentroid", stats.yCentroid,
                            "ellipse", J.o("x1", x1, "y1", y1, "x2", x2, "y2", y2, "aspectRatio", aspect), "polygon", fp(e.getFloatPolygon()), "mask", J.mask(e)))
                .write();
        }
    }

    // ------------------------------------------------------------ profile
    static void prof(String name, int bits, Roi roi, double pw) {
        ImageProcessor ip = Gen.make(bits, Gen.blobs(48, 40, 1600 + bits, 6, 3, 7, 0.2, 0.1, 0.08, 0.05), 48, 40);
        ImageProcessor in = ip.duplicate();
        ImagePlus imp = Gen.imp("p", ip);
        if (pw != 1) { Calibration c = imp.getCalibration(); c.pixelWidth = pw; c.pixelHeight = pw; c.setUnit("micron"); }
        imp.setRoi(roi);
        ProfilePlot pp = new ProfilePlot(imp);
        double[] v = pp.getProfile();
        new Fx("roi", name, "profile")
            .call("imp.setRoi(roi); new ProfilePlot(imp).getProfile() [straight: getStraightLineProfile (ip.getLine, interpolated); polyline: getIrregularProfile; width>1: getWideLineProfile]")
            .params("roi", lineJson(roi), "interpolate", PlotWindow.interpolate, "calibrationPixelWidth", pw)
            .input(in).result(J.o("profile", v, "xInc", pp.getPlot() == null ? pw : pw)).write();
    }

    static void profile() {
        for (int bits : new int[]{8, 16, 32}) {
            String s = bits == 8 ? "u8" : bits == 16 ? "u16" : "f32";
            prof("profile_line_frac_" + s, bits, new Line(3.2, 5.5, 40.7, 31.2), 1);
            prof("profile_line_horizontal_" + s, bits, new Line(4, 10, 40, 10), 1);
            prof("profile_polyline_int_" + s, bits, new PolygonRoi(new int[]{5, 20, 30, 12}, new int[]{5, 10, 28, 35}, 4, Roi.POLYLINE), 1);
            prof("profile_polyline_frac_" + s, bits, new PolygonRoi(new float[]{5.5f, 20.25f, 30.75f, 12.5f}, new float[]{5.25f, 10.5f, 28.5f, 35.75f}, 4, Roi.POLYLINE), 1);
        }
        Roi wide = new Line(6, 8, 38, 30);
        wide.setStrokeWidth(3);
        prof("profile_line_width3_u16", 16, wide, 1);
        Roi widePoly = new PolygonRoi(new int[]{5, 20, 30, 12}, new int[]{5, 10, 28, 35}, 4, Roi.POLYLINE);
        widePoly.setStrokeWidth(3);
        prof("profile_polyline_width3_u16", 16, widePoly, 1);
        prof("profile_line_cal0p35_u16", 16, new Line(3.2, 5.5, 40.7, 31.2), 0.35);
    }

    // ------------------------------------------------------------ angle tool
    static void angle() {
        float[][][] tri = {
            {{10, 20, 30}, {10, 30, 10}}, {{30, 20, 10}, {10, 30, 10}}, {{5, 20, 35}, {30, 10, 28}},
            {{20, 10, 30}, {10, 30, 30}}, {{10.5f, 22.25f, 34.75f}, {12.5f, 5.5f, 20.25f}}, {{10, 20, 40}, {10, 10, 10}}, {{10, 30, 10}, {10, 10, 25}}
        };
        for (int i = 0; i < tri.length; i++) {
            PolygonRoi r = new PolygonRoi(tri[i][0], tri[i][1], 3, Roi.ANGLE);
            ImageProcessor ip = new ByteProcessor(48, 40);
            ImagePlus imp = Gen.imp("a", ip);
            imp.setRoi(r);
            ResultsTable rt = new ResultsTable();
            new Analyzer(imp, Measurements.AREA, rt).measure();
            double fromRt = rt.getColumnIndex("Angle") >= 0 ? rt.getValueAsDouble(rt.getColumnIndex("Angle"), 0) : Double.NaN;
            new Fx("roi", "angle_" + i, "angle")
                .call("new PolygonRoi(xs, ys, 3, Roi.ANGLE).getAngle() [degrees between the arms at vertex 2, 0..180; Prefs.reflexAngle=false]; Analyzer.measureAngle -> rt \"Angle\"")
                .params("pts", J.floatPts(tri[i][0], tri[i][1], 3))
                .result(J.o("angle", r.getAngle(), "measureAngle", fromRt)).write();
        }
    }
}
