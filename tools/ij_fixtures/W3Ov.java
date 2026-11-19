import ij.*;
import ij.gui.*;
import ij.measure.Calibration;
import ij.plugin.*;
import ij.process.*;
import java.awt.Color;
import java.awt.Font;
import java.awt.Shape;
import java.awt.geom.PathIterator;
import java.lang.reflect.*;
import java.util.*;

/** ov: Grid shapes (each type, centred, seeded random offset), Scale Bar bar / text rectangles per location. */
final class W3Ov {
    static void run() throws Exception {
        grid();
        scaleBar();
        scaleBarAuto();
    }

    static ImagePlus calibrated(int w, int h, double pw, String unit) {
        ImagePlus imp = Gen.imp("t", Gen.tex(8, w, h, 17));
        if (pw != 1.0) { Calibration c = imp.getCalibration(); c.pixelWidth = pw; c.pixelHeight = pw; c.setUnit(unit); }
        return imp;
    }

    static String colorName(Color c) { return c == null ? null : String.format("#%02x%02x%02x", c.getRed(), c.getGreen(), c.getBlue()); }

    // ------------------------------------------------------------------ Grid
    static List<Object> segments(Shape s) {
        List<Object> out = new ArrayList<>();
        PathIterator it = s.getPathIterator(null);
        double[] c = new double[6];
        while (!it.isDone()) {
            int t = it.currentSegment(c);
            String nm = t == PathIterator.SEG_MOVETO ? "M" : t == PathIterator.SEG_LINETO ? "L" : t == PathIterator.SEG_CUBICTO ? "C" : t == PathIterator.SEG_QUADTO ? "Q" : "Z";
            int n = t == PathIterator.SEG_CUBICTO ? 6 : t == PathIterator.SEG_QUADTO ? 4 : t == PathIterator.SEG_CLOSE ? 0 : 2;
            double[] v = new double[n];
            for (int i = 0; i < n; i++) v[i] = c[i];
            out.add(J.o("s", nm, "v", v));
            it.next();
        }
        return out;
    }

    static void grid() throws Exception {
        List<Object> cases = new ArrayList<>();
        String[] types = {"Lines", "Horizontal Lines", "Crosses", "Points", "Circles", "None"};
        Object[][] imgs = {{64, 48, 1.0, "pixel"}, {100, 80, 0.5, "um"}};
        for (Object[] im : imgs) for (String type : types) for (int variant = 0; variant < 5; variant++) {
            int w = (Integer) im[0], h = (Integer) im[1];
            ImagePlus imp = calibrated(w, h, (Double) im[2], (String) im[3]);
            double pw = (Double) im[2];
            double defArea = (w * pw * h * pw) / 81.0;
            double area = Math.max(variant == 4 ? defArea * 2.2 : defArea, 60 * pw * pw);   // below the minimum area ImageJ raises a modal IJ.error
            String opts = "grid=[" + type + "] area=" + area + " color=Cyan"
                + (variant == 1 ? " center" : "") + (variant == 2 || variant == 3 ? " random" : "") + (variant == 3 ? " bold" : "");
            long seed = variant == 2 ? 1 : 42;
            Grid g = new Grid();
            Gen.set(g, "random", new Random(seed));
            Object result;
            try {
                WindowManager.setTempCurrentImage(imp);
                Macro.setOptions(opts);
                g.run("");
                Overlay ov = imp.getOverlay();
                int idx = ov == null ? -1 : ov.getIndex("|GRID|");
                if (idx < 0) result = J.o("overlay", null);
                else {
                    Roi r = ov.get(idx);
                    result = J.o("strokeColor", colorName(r.getStrokeColor()), "strokeWidth", r.getStrokeWidth(), "segments", segments(((ShapeRoi) r).getShape()));
                }
            } catch (Throwable t) { result = J.o("error", String.valueOf(t)); }
            finally { Macro.setOptions(null); WindowManager.setTempCurrentImage(null); }
            cases.add(J.o("params", J.o("type", type, "area", area, "centered", variant == 1, "randomOffset", variant == 2 || variant == 3, "bold", variant == 3, "seed", seed, "color", "Cyan"),
                "image", J.o("width", w, "height", h, "pixelWidth", pw, "unit", im[3]), "result", result));
        }
        new Fx("ov", "grid", "toolsGrid")
            .call("new Grid().run(\"\") with macro options grid= area= color= [center] [random] [bold]; the private Random is replaced by Random(seed) through reflection; result = the |GRID| overlay ShapeRoi path (M/L/C segments, image pixels)")
            .put("cases", cases).write();
    }

    // ------------------------------------------------------------------ Scale Bar
    static Object newConfig() throws Exception {
        Class<?> c = Class.forName("ij.plugin.ScaleBar$ScaleBarConfiguration");
        Constructor<?> k = c.getDeclaredConstructor();
        k.setAccessible(true);
        return k.newInstance();
    }

    static void setF(Object o, String f, Object v) throws Exception {
        Field fl = o.getClass().getDeclaredField(f);
        fl.setAccessible(true);
        fl.set(o, v);
    }

    static Object getF(Object o, String f) throws Exception {
        Field fl = o.getClass().getDeclaredField(f);
        fl.setAccessible(true);
        return fl.get(o);
    }

    static Object call(Object o, String m, Class<?>[] sig, Object... a) throws Exception {
        Method mm = o.getClass().getDeclaredMethod(m, sig);
        mm.setAccessible(true);
        try { return mm.invoke(o, a); } catch (InvocationTargetException e) { throw new Exception(e.getCause()); }
    }

    /** Builds a ScaleBar around `imp` with the configuration overrides and returns {config, items}. */
    static Map<String, Object> bar(ImagePlus imp, Map<String, Object> over, Roi userRoi, boolean computeDefaults) throws Exception {
        ScaleBar sb = new ScaleBar();
        Object cfg = newConfig();
        for (Map.Entry<String, Object> e : over.entrySet()) setF(cfg, e.getKey(), e.getValue());
        Gen.set(sb, "imp", imp);
        Gen.set(sb, "config", cfg);
        if (userRoi != null) {
            imp.setRoi(userRoi);
            java.awt.Rectangle r = userRoi.getBounds();
            Gen.set(sb, "userRoiExists", true);
            Gen.set(sb, "roiX", r.x); Gen.set(sb, "roiY", r.y); Gen.set(sb, "roiWidth", r.width); Gen.set(sb, "roiHeight", r.height);
            setF(cfg, "location", "At Selection");
        }
        Calibration cal = imp.getCalibration();
        boolean sh = (Boolean) getF(cfg, "showHorizontal"), sv = (Boolean) getF(cfg, "showVertical");
        double hw = (Double) getF(cfg, "hBarWidth"), vh = (Double) getF(cfg, "vBarHeight");
        if (computeDefaults && ((sh && (hw <= 5 * cal.pixelWidth || hw > cal.pixelWidth * imp.getWidth())) || (sv && (vh <= 5 * cal.pixelHeight || vh > cal.pixelHeight * imp.getHeight())) || userRoi != null))
            call(sb, "computeDefaultBarWidth", new Class<?>[]{boolean.class}, userRoi != null);
        Overlay ov = (Overlay) call(sb, "createScaleBarOverlay", new Class<?>[0]);
        List<Object> items = new ArrayList<>();
        for (Roi r : ov.toArray()) {
            java.awt.Rectangle b = r.getBounds();
            LinkedHashMap<String, Object> m = new LinkedHashMap<>();
            m.put("kind", r instanceof TextRoi ? "text" : "rect");
            m.put("bounds", new int[]{b.x, b.y, b.width, b.height});
            m.put("fill", colorName(r.getFillColor()));
            m.put("stroke", colorName(r.getStrokeColor()));
            if (r instanceof TextRoi) {
                TextRoi t = (TextRoi) r;
                Font f = t.getCurrentFont();
                m.put("text", t.getText().trim());
                m.put("font", J.o("name", f.getName(), "size", f.getSize(), "style", f.getStyle()));
                m.put("angle", t.getAngle());
            }
            items.add(m);
        }
        ImageProcessor ip = imp.getProcessor();
        String hl = (String) call(sb, "getHLabel", new Class<?>[0]);
        String vl = (String) call(sb, "getVLabel", new Class<?>[0]);
        int fs = (Integer) getF(cfg, "fontSize");
        Font f = new Font((Boolean) getF(cfg, "serifFont") ? "Serif" : "SanSerif", (Boolean) getF(cfg, "boldText") ? Font.BOLD : Font.PLAIN, fs);
        ip.setFont(f);
        return J.o("hBarWidth", getF(cfg, "hBarWidth"), "vBarHeight", getF(cfg, "vBarHeight"), "hDigits", getF(cfg, "hDigits"), "vDigits", getF(cfg, "vDigits"),
            "hLabel", hl, "vLabel", vl, "hLabelWidthPx", ip.getStringWidth(hl), "vLabelWidthPx", ip.getStringWidth(vl),
            "hBarWidthInPixels", getF(sb, "hBarWidthInPixels"), "vBarHeightInPixels", getF(sb, "vBarHeightInPixels"), "items", items);
    }

    static LinkedHashMap<String, Object> o(Object... kv) { LinkedHashMap<String, Object> m = new LinkedHashMap<>(); for (int i = 0; i < kv.length; i += 2) m.put((String) kv[i], kv[i + 1]); return m; }

    static void scaleBar() throws Exception {
        List<Object> cases = new ArrayList<>();
        String[] locs = {"Upper Right", "Lower Right", "Lower Left", "Upper Left"};
        String[][] colors = {{"White", "None"}, {"Black", "White"}};
        for (String loc : locs) for (int mode = 0; mode < 4; mode++) for (String[] col : colors) {
            ImagePlus imp = calibrated(320, 240, 0.5, "um");
            Map<String, Object> over = o("hBarWidth", 50.0, "vBarHeight", 30.0, "hDigits", 0, "vDigits", 0, "location", loc, "color", col[0], "bcolor", col[1],
                "showHorizontal", mode != 1, "showVertical", mode >= 1 && mode != 3 || mode == 3, "hideText", mode == 3, "boldText", mode != 2, "fontSize", mode == 2 ? 20 : 14, "barThicknessInPixels", mode == 2 ? 6 : 4);
            if (mode == 3) over.put("showVertical", false);
            if (mode == 0) over.put("showVertical", false);
            Object res;
            try { res = bar(imp, over, null, false); } catch (Throwable t) { res = J.o("error", String.valueOf(t)); }
            cases.add(J.o("image", J.o("width", 320, "height", 240, "pixelWidth", 0.5, "unit", "um"), "config", over, "result", res));
        }
        // At Selection (the bar sits at the user's rectangle)
        for (int c = 0; c < 2; c++) {
            ImagePlus imp = calibrated(320, 240, 0.5, "um");
            Map<String, Object> over = o("hBarWidth", -1.0, "vBarHeight", -1.0, "showVertical", c == 1, "bcolor", "None");
            Object res;
            try { res = bar(imp, over, new Roi(40, 30, 90, 60), true); } catch (Throwable t) { res = J.o("error", String.valueOf(t)); }
            cases.add(J.o("image", J.o("width", 320, "height", 240, "pixelWidth", 0.5, "unit", "um"), "config", o("location", "At Selection", "selection", J.o("x", 40, "y", 30, "w", 90, "h", 60), "showVertical", c == 1), "result", res));
        }
        new Fx("ov", "scale_bar", "toolsScaleBar")
            .call("ScaleBar by reflection: config fields set, createScaleBarOverlay(): hBackground/hBar/hText/vBar/vText rectangles in image pixels (|SB| overlay Roi / TextRoi); label widths are Java font metrics (record = hLabelWidthPx / vLabelWidthPx; a JS port feeds its own measurement, so text pixels are NOT compared)")
            .put("cases", cases).write();
    }

    /** The auto width / height rule (computeDefaultBarWidth) over calibrations and image sizes. */
    static void scaleBarAuto() throws Exception {
        List<Object> cases = new ArrayList<>();
        Object[][] imgs = {{64, 48, 1.0, "pixel"}, {512, 512, 0.1625, "um"}, {1024, 768, 0.0625, "um"}, {320, 240, 0.5, "um"}, {200, 100, 25.0, "um"}, {2000, 1500, 0.3, "um"}, {40, 40, 1.0, "pixel"}};
        for (Object[] im : imgs) for (int both = 0; both < 2; both++) {
            ImagePlus imp = calibrated((Integer) im[0], (Integer) im[1], (Double) im[2], (String) im[3]);
            Map<String, Object> over = o("showVertical", both == 1);
            Object res;
            try { res = bar(imp, over, null, true); } catch (Throwable t) { res = J.o("error", String.valueOf(t)); }
            cases.add(J.o("image", J.o("width", im[0], "height", im[1], "pixelWidth", im[2], "unit", im[3]), "showVertical", both == 1, "result", res));
        }
        new Fx("ov", "scale_bar_auto", "toolsScaleBar")
            .call("ScaleBar.computeDefaultBarWidth(false) from a default configuration (hBarWidth=-1): 80 px rounded to 1-2-5 x 10^k, clamped to 2/3 or 4% of the image, digits from the rounded number")
            .put("cases", cases).write();
    }
}
