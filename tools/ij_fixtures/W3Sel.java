import ij.*;
import ij.gui.*;
import ij.macro.*;
import ij.plugin.*;
import ij.process.*;
import java.awt.Polygon;
import java.awt.Rectangle;
import java.util.*;

/** sel: Fit Spline / Circle / Rectangle, Interpolate, Scale, Rotate, Translate, Make Band, Line to Area, Area to Line, Straighten. */
final class W3Sel {
    static void run() throws Exception {
        fitSpline();
        fitCircle();
        fitRectangle();
        interpolate();
        scale();
        rotate();
        translate();
        makeBand();
        lineToArea();
        areaToLine();
        straighten();
        ellipse();
        interpolateOnePart();
    }

    // ------------------------------------------------------------------ helpers
    /** Full description of a selection: type, float polygon, bounds, mask, width, spline flag, name. */
    static Map<String, Object> roiFull(Roi r) {
        if (r == null) return J.o("none", true);
        LinkedHashMap<String, Object> m = new LinkedHashMap<>();
        m.put("class", r.getClass().getSimpleName());
        m.put("type", r.getType());
        m.put("typeName", r.getTypeAsString());
        java.awt.geom.Rectangle2D.Double fb = r.getFloatBounds();
        m.put("floatBounds", new double[]{fb.x, fb.y, fb.width, fb.height});
        Rectangle b = r.getBounds();
        m.put("bounds", new int[]{b.x, b.y, b.width, b.height});
        m.put("subPixel", r.subPixelResolution());
        m.put("strokeWidth", r.getStrokeWidth());
        m.put("name", r.getName());
        if (r instanceof PolygonRoi) m.put("splineFit", ((PolygonRoi) r).isSplineFit());
        if (!(r instanceof ShapeRoi)) {
            FloatPolygon fp = r.getFloatPolygon();
            if (fp != null) m.put("floatPolygon", J.floatPts(fp.xpoints, fp.ypoints, fp.npoints));
        }
        if (r.isArea()) {
            Map<String, Object> mk = J.mask(r);
            if (mk != null) m.put("mask", mk);
            ImageProcessor ip = new ByteProcessor(Math.max(1, b.x + b.width + 2), Math.max(1, b.y + b.height + 2));
            m.put("area", r.getStatistics().pixelCount);
        }
        return m;
    }

    static ImagePlus img(int w, int h, long seed) { return Gen.imp("t", Gen.tex(8, w, h, seed)); }

    static void runSel(String arg, ImagePlus imp, String options) {
        WindowManager.setTempCurrentImage(imp);
        Macro.setOptions(options);
        try { new Selection().run(arg); }
        finally { Macro.setOptions(null); WindowManager.setTempCurrentImage(null); }
    }

    static PolygonRoi poly(int type, float... xy) {
        float[] x = new float[xy.length / 2], y = new float[xy.length / 2];
        for (int i = 0; i < x.length; i++) { x[i] = xy[2 * i]; y[i] = xy[2 * i + 1]; }
        return new PolygonRoi(x, y, x.length, type);
    }

    static PolygonRoi intPoly(int type, int... xy) {
        int[] x = new int[xy.length / 2], y = new int[xy.length / 2];
        for (int i = 0; i < x.length; i++) { x[i] = xy[2 * i]; y[i] = xy[2 * i + 1]; }
        return new PolygonRoi(x, y, x.length, type);
    }

    /** Freehand outline: noisy blob boundary, integer coordinates. */
    static PolygonRoi freehand() {
        int n = 70;
        Random r = new Random(12);
        int[] x = new int[n], y = new int[n];
        for (int i = 0; i < n; i++) {
            double a = 2 * Math.PI * i / n, rad = 14 + 3 * Math.sin(3 * a) + r.nextInt(3);
            x[i] = (int) Math.round(32 + rad * Math.cos(a)); y[i] = (int) Math.round(24 + rad * Math.sin(a));
        }
        return new PolygonRoi(x, y, n, Roi.FREEROI);
    }

    /** Traced outline of a mask with a notch (what the Wand produces). */
    static Roi traced() {
        ByteProcessor m = new ByteProcessor(64, 48);
        Gen.disk(m, 30, 22, 11, 255); Gen.disk(m, 41, 26, 7, 255);
        for (int y = 14; y < 22; y++) for (int x = 33; x < 37; x++) m.set(x, y, 0);
        ImagePlus imp = Gen.imp("m", m);
        IJ.doWand(imp, 30, 22, 0, null);
        return imp.getRoi();
    }

    /** Holed composite from a mask (ShapeRoi). */
    static Roi holed() {
        ByteProcessor m = new ByteProcessor(64, 48);
        Gen.disk(m, 32, 24, 15, 255); Gen.disk(m, 32, 24, 6, 0);
        m.setThreshold(255, 255, ImageProcessor.NO_LUT_UPDATE);
        return new ij.plugin.filter.ThresholdToSelection().convert(m);
    }

    static Roi[] areaRois() {
        return new Roi[]{
            new Roi(10, 8, 30, 20), new OvalRoi(12, 6, 28, 22),
            intPoly(Roi.POLYGON, 8, 6, 40, 10, 52, 30, 30, 22, 36, 40, 14, 34),
            freehand(), traced(), holed()
        };
    }

    static String[] areaNames() { return new String[]{"rect", "oval", "polygon", "freehand", "traced", "holed"}; }

    static Roi[] lineRois() {
        return new Roi[]{
            intPoly(Roi.POLYLINE, 6, 38, 18, 12, 33, 30, 46, 10, 58, 28),
            intPoly(Roi.POLYLINE, 6, 6, 56, 40),
            new Line(6, 40, 58, 8),
            freelineRoi()
        };
    }

    static Roi freelineRoi() {
        int n = 50;
        int[] x = new int[n], y = new int[n];
        Random r = new Random(3);
        for (int i = 0; i < n; i++) { x[i] = 4 + i + r.nextInt(2); y[i] = (int) Math.round(24 + 10 * Math.sin(i / 6.0)) + r.nextInt(2); }
        return new PolygonRoi(x, y, n, Roi.FREELINE);
    }

    static String[] lineNames() { return new String[]{"polyline5", "polyline2", "line", "freeline"}; }

    /** Runs `arg` of the Selection plugin on a copy of `roi` and records the resulting selection. */
    static Object viaSelection(String arg, Roi roi, String options) {
        ImagePlus imp = img(64, 48, 5);
        imp.setRoi((Roi) roi.clone());
        try { runSel(arg, imp, options); }
        catch (Throwable t) { return J.o("error", String.valueOf(t)); }
        return roiFull(imp.getRoi());
    }

    // ------------------------------------------------------------------ cases
    static void fitSpline() {
        List<Object> cases = new ArrayList<>();
        Roi[] rs = {intPoly(Roi.POLYGON, 8, 6, 40, 10, 52, 30, 30, 22, 36, 40, 14, 34), intPoly(Roi.POLYLINE, 6, 38, 18, 12, 33, 30, 46, 10, 58, 28), freehand(), traced(), freelineRoi(), poly(Roi.POLYGON, 8.5f, 6.25f, 40.5f, 10f, 52f, 30.5f, 20f, 40f)};
        String[] nm = {"polygon", "polyline", "freehand", "traced", "freeline", "polygonSubpixel"};
        for (int i = 0; i < rs.length; i++)
            cases.add(J.o("name", nm[i], "input", roiFull(rs[i]), "output", viaSelection("spline", rs[i], null)));
        new Fx("sel", "fit_spline", "selFitSpline")
            .call("Selection.run(\"spline\") on imp with the roi: freehand/traced trimmed first (trimPolygon/trimFloatPolygon), then PolygonRoi.fitSpline(); evaluationPoints = (int)(length/2.0), min 100")
            .put("cases", cases).write();
    }

    static void fitCircle() {
        List<Object> cases = new ArrayList<>();
        Roi[] ar = areaRois();
        String[] an = areaNames();
        for (int i = 0; i < ar.length; i++) cases.add(J.o("name", an[i], "input", roiFull(ar[i]), "output", viaSelection("circle", ar[i], null)));
        Roi[] extra = {intPoly(Roi.POLYLINE, 6, 38, 18, 12, 33, 30, 46, 10, 58, 28), intPoly(Roi.POINT, 10, 10, 30, 8, 46, 20, 40, 38, 14, 36, 8, 24), freelineRoi()};
        String[] en = {"polyline5", "multipoint6", "freeline"};
        for (int i = 0; i < extra.length; i++) cases.add(J.o("name", en[i], "input", roiFull(extra[i]), "output", viaSelection("circle", extra[i], null)));
        new Fx("sel", "fit_circle", "selFitCircle")
            .call("Selection.run(\"circle\"): area -> OvalRoi of equal pixelCount at the centroid (round); lines/points -> Pratt fit (Newton, 20 iterations, epsilon 1e-12) -> IJ.makeOval(round(cx-r), round(cy-r), round(2r), round(2r))")
            .put("cases", cases).write();
    }

    static void fitRectangle() {
        List<Object> cases = new ArrayList<>();
        Roi[] ar = areaRois();
        String[] an = areaNames();
        for (int i = 0; i < ar.length; i++) cases.add(J.o("name", an[i], "input", roiFull(ar[i]), "output", viaSelection("rect", ar[i], null)));
        Roi[] extra = {intPoly(Roi.POLYLINE, 6, 38, 18, 12, 33, 30, 46, 10, 58, 28), intPoly(Roi.POINT, 10, 10, 30, 8, 46, 20, 40, 38, 14, 36, 8, 24)};
        String[] en = {"polyline5", "multipoint6"};
        for (int i = 0; i < extra.length; i++) cases.add(J.o("name", en[i], "input", roiFull(extra[i]), "output", viaSelection("rect", extra[i], null)));
        new Fx("sel", "fit_rectangle", "selFitRectangle")
            .call("Selection.run(\"rect\"): minimum-area bounding rectangle among the convex-hull edges (Freeman & Shapira 1975), result = rotated rectangle polygon")
            .put("cases", cases).write();
    }

    static void interpolate() {
        List<Object> cases = new ArrayList<>();
        Roi[] rs = {intPoly(Roi.POLYGON, 8, 6, 40, 10, 52, 30, 30, 22, 36, 40, 14, 34), new Roi(10, 8, 30, 20), new OvalRoi(12, 6, 28, 22), intPoly(Roi.POLYLINE, 6, 38, 18, 12, 33, 30, 46, 10, 58, 28), new Line(6, 40, 58, 8), holed()};
        String[] nm = {"polygon", "rect", "oval", "polyline", "line", "holed"};
        String[] opts = {"interval=1", "interval=2.5 smooth", "interval=1 adjust", "interval=9", "interval=3.7 smooth adjust"};
        for (int i = 0; i < rs.length; i++) for (String o : opts)
            cases.add(J.o("name", nm[i], "options", o, "input", roiFull(rs[i]), "output", viaSelection("interpolate", rs[i], o)));
        new Fx("sel", "interpolate", "selInterpolate")
            .call("Selection.run(\"interpolate\") with macro options: Roi.getInterpolatedPolygon(sign*interval, smooth) (sign -1 when 'adjust'); type FREEROI/FREELINE, POLYGON for polygon with interval>1, POLYGON/POLYLINE for interval>=8")
            .put("cases", cases).write();
    }

    static void scale() {
        List<Object> cases = new ArrayList<>();
        Roi[] rs = {new Roi(10, 8, 30, 20), new OvalRoi(12, 6, 28, 22), intPoly(Roi.POLYGON, 8, 6, 40, 10, 52, 30, 30, 22, 36, 40, 14, 34), intPoly(Roi.POLYLINE, 6, 38, 18, 12, 33, 30), new Line(6, 40, 58, 8), traced(), holed()};
        String[] nm = {"rect", "oval", "polygon", "polyline", "line", "traced", "holed"};
        double[][] sc = {{1.5, 1.5, 0}, {0.5, 2.0, 1}, {1.0, 0.75, 0}, {2.0, 2.0, 1}};
        for (int i = 0; i < rs.length; i++) for (double[] s : sc) {
            Object out;
            try { out = roiFull(RoiScaler.scale((Roi) rs[i].clone(), s[0], s[1], s[2] == 1)); } catch (Throwable t) { out = J.o("error", String.valueOf(t)); }
            cases.add(J.o("name", nm[i], "params", J.o("xscale", s[0], "yscale", s[1], "centered", s[2] == 1), "input", roiFull(rs[i]), "output", out));
        }
        new Fx("sel", "scale", "selScale").call("RoiScaler.scale(roi, xscale, yscale, centered)").put("cases", cases).write();
    }

    static void rotate() {
        List<Object> cases = new ArrayList<>();
        Roi[] rs = {new Roi(10, 8, 30, 20), new OvalRoi(12, 6, 28, 22), intPoly(Roi.POLYGON, 8, 6, 40, 10, 52, 30, 30, 22, 36, 40, 14, 34), intPoly(Roi.POLYLINE, 6, 38, 18, 12, 33, 30), new Line(6, 40, 58, 8), traced(), holed()};
        String[] nm = {"rect", "oval", "polygon", "polyline", "line", "traced", "holed"};
        double[] angles = {15, -30, 90};
        for (int i = 0; i < rs.length; i++) for (double a : angles) for (int c = 0; c < 2; c++) {
            Object out;
            try {
                Roi r = (Roi) rs[i].clone();
                out = roiFull(c == 0 ? RoiRotator.rotate(r, a) : RoiRotator.rotate(r, a, 32.0, 24.0));
            } catch (Throwable t) { out = J.o("error", String.valueOf(t)); }
            cases.add(J.o("name", nm[i], "params", J.o("angle", a, "center", c == 0 ? "roi" : "image(32,24)"), "input", roiFull(rs[i]), "output", out));
        }
        new Fx("sel", "rotate", "selRotate")
            .call("RoiRotator.rotate(roi, angle) [centre = roi centre, 'Rotate around image center' off] / rotate(roi, angle, xcenter, ycenter) [image centre of the 64x48 image = 32,24]")
            .put("cases", cases).write();
    }

    static void translate() {
        List<Object> cases = new ArrayList<>();
        Roi[] rs = {new Roi(10, 8, 30, 20), new OvalRoi(12, 6, 28, 22), intPoly(Roi.POLYGON, 8, 6, 40, 10, 52, 30, 30, 22, 36, 40, 14, 34), new Line(6, 40, 58, 8), traced()};
        String[] nm = {"rect", "oval", "polygon", "line", "traced"};
        int[][] d = {{5, -3}, {-12, 7}, {0, 0}};
        for (int i = 0; i < rs.length; i++) for (int[] o : d)
            cases.add(J.o("name", nm[i], "params", J.o("dx", o[0], "dy", o[1]), "input", roiFull(rs[i]), "output", viaSelection("translate", rs[i], "x=" + o[0] + " y=" + o[1])));
        new Fx("sel", "translate", "selTranslate").call("Selection.run(\"translate\") with options x= y=: roi.setLocation(bounds.x+dx, bounds.y+dy)").put("cases", cases).write();
    }

    static void makeBand() {
        List<Object> cases = new ArrayList<>();
        Roi[] rs = {new Roi(14, 10, 30, 20), new OvalRoi(12, 6, 28, 22), intPoly(Roi.POLYGON, 8, 6, 40, 10, 52, 30, 30, 22, 36, 40, 14, 34), traced(), holed(), new Roi(0, 0, 20, 14)};
        String[] nm = {"rect", "oval", "polygon", "traced", "holed", "cornerRect"};
        int[] sizes = {5, 15, 40};
        for (int i = 0; i < rs.length; i++) for (int n : sizes)
            cases.add(J.o("name", nm[i], "params", J.o("size", n), "input", roiFull(rs[i]), "output", viaSelection("band", rs[i], "band=" + n)));
        new Fx("sel", "make_band", "makeBand")
            .call("Selection.run(\"band\") with options band=<n> on a 64x48 image: 8-bit EDM (BYTE_OVERWRITE, blackBackground=false) of the mask, threshold 0..n, Wand from the first pixel < n, ShapeRoi(edm roi) not roi")
            .put("cases", cases).write();
    }

    static void lineToArea() {
        List<Object> cases = new ArrayList<>();
        Roi[] rs = lineRois();
        String[] nm = lineNames();
        int[] widths = {1, 5, 12};
        for (int i = 0; i < rs.length; i++) for (int w : widths) {
            Roi r = (Roi) rs[i].clone();
            r.setStrokeWidth(w);
            Object out;
            try { out = roiFull(Selection.lineToArea(r)); } catch (Throwable t) { out = J.o("error", String.valueOf(t)); }
            cases.add(J.o("name", nm[i], "params", J.o("width", w), "input", roiFull(r), "output", out));
        }
        new Fx("sel", "line_to_area", "selLineToArea").call("Selection.lineToArea(roi) = Roi.convertLineToArea(roi) with the stroke width set").put("cases", cases).write();
    }

    static void areaToLine() {
        List<Object> cases = new ArrayList<>();
        Roi[] rs = areaRois();
        String[] nm = areaNames();
        for (int i = 0; i < rs.length; i++) {
            if (rs[i].getType() == Roi.COMPOSITE) continue;   // refused with a modal IJ.error ("Composite selections cannot be converted to lines")
            cases.add(J.o("name", nm[i], "input", roiFull(rs[i]), "output", viaSelection("toline", rs[i], null)));
        }
        new Fx("sel", "area_to_line", "selAreaToLine").call("Selection.run(\"toline\"): polygon -> POLYLINE (FREELINE for oval/freehand/traced/spline), location shifted by -0.5").put("cases", cases).write();
    }

    static void straighten() {
        List<Object> cases = new ArrayList<>();
        ImageProcessor ip = Gen.tex(8, 64, 48, 5);
        ImageProcessor ip16 = Gen.tex(16, 64, 48, 5);
        Roi[] rs = lineRois();
        String[] nm = lineNames();
        int[] widths = {20, 7};
        for (int bits : new int[]{8, 16}) for (int i = 0; i < rs.length; i++) for (int w : widths) {
            ImagePlus imp = Gen.imp("t", bits == 8 ? ip.duplicate() : ip16.duplicate());
            Roi r = (Roi) rs[i].clone();
            r.setStrokeWidth(w);
            imp.setRoi(r);
            Object out;
            try {
                if (r.getType() == Roi.FREELINE) { runSel("spline", imp, null); r = imp.getRoi(); }
                ImageProcessor o = new Straightener().straighten(imp, r, w);
                out = J.o("output", J.image(o), "roiAfter", roiFull(r));
            } catch (Throwable t) { out = J.o("error", String.valueOf(t)); }
            cases.add(J.o("name", nm[i], "bitDepth", bits, "params", J.o("width", w), "roi", roiFull(rs[i]), "result", out));
        }
        new Fx("sel", "straighten", "straighten")
            .call("new Straightener().straighten(imp, roi, width): polyline -> straightenLine (spline fit for straightening, 1 px resampling, perpendicular interpolation); FREELINE first 'Fit Spline'; straight Line -> rotateLine")
            .input(ip).put("input16", J.image(ip16)).put("cases", cases).write();
    }

    /** EllipseRoi (Fit Ellipse) is a FREEROI polygon: smoothing in Interpolate, FREELINE in Area to Line, FREEROI after Rotate / Scale. */
    static void ellipse() {
        List<Object> cases = new ArrayList<>();
        Roi e = new EllipseRoi(10, 20, 50, 30, 0.5);
        for (String o : new String[]{"interval=1", "interval=2.5 smooth", "interval=2.5", "interval=9", "interval=3.7 smooth adjust"})
            cases.add(J.o("name", "interpolate", "options", o, "input", roiFull(e), "output", viaSelection("interpolate", e, o)));
        cases.add(J.o("name", "areaToLine", "input", roiFull(e), "output", viaSelection("toline", e, null)));
        for (double a : new double[]{15, 90}) {
            Object out;
            try { out = roiFull(RoiRotator.rotate((Roi) e.clone(), a)); } catch (Throwable t) { out = J.o("error", String.valueOf(t)); }
            cases.add(J.o("name", "rotate", "params", J.o("angle", a), "input", roiFull(e), "output", out));
        }
        Object sc;
        try { sc = roiFull(RoiScaler.scale((Roi) e.clone(), 1.5, 0.75, false)); } catch (Throwable t) { sc = J.o("error", String.valueOf(t)); }
        cases.add(J.o("name", "scale", "params", J.o("xscale", 1.5, "yscale", 0.75, "centered", false), "input", roiFull(e), "output", sc));
        new Fx("sel", "ellipse", "selEllipse")
            .call("EllipseRoi(10,20,50,30,0.5) through Selection.run(interpolate|toline), RoiRotator.rotate, RoiScaler.scale")
            .put("cases", cases).write();
    }

    /** A ShapeRoi of ONE part (Make Band at the image corner) is not the "composite" branch of Interpolate (Selection.java:288: getRois().length>1). */
    static void interpolateOnePart() {
        List<Object> cases = new ArrayList<>();
        ImagePlus imp = img(64, 48, 5);
        imp.setRoi(new Roi(0, 0, 20, 14));
        try { runSel("band", imp, "band=5"); } catch (Throwable t) { throw new RuntimeException(t); }
        Roi band = imp.getRoi();
        for (String o : new String[]{"interval=2.5", "interval=2.5 smooth", "interval=2.5 adjust", "interval=9"})
            cases.add(J.o("name", "oneLoopBand", "options", o, "input", roiFull(band), "output", viaSelection("interpolate", band, o)));
        new Fx("sel", "interpolate_onepart", "selInterpolate")
            .call("Make Band at the image corner (one-loop ShapeRoi) then Selection.run(\"interpolate\"): Roi.getInterpolatedPolygon(sign*interval, smooth), FREEROI, no smoothing for a COMPOSITE")
            .put("cases", cases).write();
    }
}
