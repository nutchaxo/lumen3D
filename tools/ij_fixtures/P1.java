import ij.*;
import ij.gui.*;
import ij.plugin.ContrastEnhancer;
import ij.plugin.filter.BackgroundSubtracter;
import ij.process.*;
import java.lang.reflect.Method;

/** P1: Subtract Background + Enhance Contrast. */
final class P1 {
    static void run() throws Exception {
        subtractBackground();
        enhance();
    }

    // ------------------------------------------------------------ Subtract Background
    static void bg(String name, int bits, int w, int h, long seed, boolean light, double radius, boolean create,
                   boolean sliding, boolean noSmooth, boolean correctCorners) throws Exception {
        float[] v = Gen.blobs(w, h, seed, 6, 2.0, 5.0, 0.35, 0.2, 0.08, 0.025);
        if (light) v = Gen.invert01(v);
        ImageProcessor ip = Gen.make(bits, v, w, h);
        ImageProcessor in = ip.duplicate();
        BackgroundSubtracter bs = new BackgroundSubtracter();
        // run(ip) of the menu command: rollingBallBackground(ip, radius, createBackground, lightBackground,
        // useParaboloid, doPresmooth, true) -- the menu always passes correctCorners=true.
        bs.rollingBallBackground(ip, radius, create, light, sliding, !noSmooth, correctCorners);
        new Fx("bg", name, "subtractBackground")
            .call("new BackgroundSubtracter().rollingBallBackground(ip, radius, createBackground, lightBackground, useParaboloid, doPresmooth=!disableSmoothing, correctCorners)"
                + (correctCorners ? " [= BackgroundSubtracter.run(ip)]" : " [correctCorners=false is only reachable through this public method, the menu always passes true]"))
            .params("radius", radius, "light", light, "createBackground", create, "sliding", sliding,
                    "disableSmoothing", noSmooth, "correctCorners", correctCorners)
            .input(in).output(ip).write();
    }

    static void bgRoi(String name, int bits, Roi roi) throws Exception {
        float[] v = Gen.blobs(64, 48, 151 + bits, 6, 2.0, 5.0, 0.35, 0.2, 0.08, 0.025);
        ImageProcessor ip = Gen.make(bits, v, 64, 48);
        ImageProcessor in = ip.duplicate();
        // PlugInFilterRunner: ip.setRoi(roi); no SUPPORTS_MASKING, so no mask restore; the plugin never reads the roi
        Gen.runFilter(ip, roi, false, false, false, p -> new BackgroundSubtracter().rollingBallBackground(p, 12, false, false, false, true, true));
        new Fx("bg", name, "subtractBackground")
            .call("PlugInFilterRunner (flags without SUPPORTS_MASKING): ip.setRoi(roi); BackgroundSubtracter.rollingBallBackground(ip, 12, false, false, false, true, true) -> the whole image is processed, the selection is ignored")
            .params("radius", 12.0, "light", false, "createBackground", false, "sliding", false,
                    "disableSmoothing", false, "correctCorners", true)
            .input(in).roi(roi).output(ip).write();
    }

    static void subtractBackground() throws Exception {
        String[] tn = {"u8", "u16", "f32"};
        int[] bd = {8, 16, 32};
        for (int t = 0; t < 3; t++) {
            String s = tn[t]; int b = bd[t];
            bg("rb_r5_dark_" + s, b, 41, 33, 11 + t, false, 5, false, false, false, true);
            bg("rb_r12_dark_" + s, b, 64, 48, 21 + t, false, 12, false, false, false, true);
            bg("rb_r50_dark_" + s, b, 80, 64, 31 + t, false, 50, false, false, false, true);
            bg("rb_r12_light_" + s, b, 64, 48, 41 + t, true, 12, false, false, false, true);
            bg("rb_r12_dark_create_" + s, b, 64, 48, 51 + t, false, 12, true, false, false, true);
            bg("rb_r12_light_create_" + s, b, 64, 48, 52 + t, true, 12, true, false, false, true);
            bg("rb_r12_dark_nosmooth_" + s, b, 64, 48, 61 + t, false, 12, false, false, true, true);
            bg("rb_r5_light_nosmooth_create_" + s, b, 41, 33, 62 + t, true, 5, true, false, true, true);
            bg("para_r12_dark_" + s, b, 64, 48, 71 + t, false, 12, false, true, false, true);
            bg("para_r12_dark_nocorners_" + s, b, 64, 48, 71 + t, false, 12, false, true, false, false);
            bg("para_r12_light_create_" + s, b, 64, 48, 81 + t, true, 12, true, true, false, true);
            bg("para_r5_dark_nosmooth_" + s, b, 41, 33, 91 + t, false, 5, false, true, true, true);
            bg("para_r50_dark_" + s, b, 80, 64, 101 + t, false, 50, false, true, false, true);
            bg("rb_r50_light_" + s, b, 80, 64, 111 + t, true, 50, false, false, false, true);
            bg("rb_r5_light_" + s, b, 41, 33, 121 + t, true, 5, false, false, false, true);
            bg("rb_r5_dark_create_" + s, b, 41, 33, 131 + t, false, 5, true, false, false, true);
            bg("para_r5_light_" + s, b, 41, 33, 141 + t, true, 5, false, true, false, true);
            // a selection is ignored by the command (flags carry no SUPPORTS_MASKING; the filter converts the whole image)
            bgRoi("rb_r12_dark_roi_rect_" + s, b, new Roi(10, 8, 30, 22));
            bgRoi("rb_r12_dark_roi_oval_" + s, b, new OvalRoi(9, 7, 32, 24));
        }
    }

    // ------------------------------------------------------------ Enhance Contrast
    /** Replicates ContrastEnhancer.showDialog's flag derivation, then drives the same methods run() calls. */
    static ContrastEnhancer ce(ImagePlus imp, double sat, boolean normalize, boolean equalize, boolean entireImage, boolean classic) throws Exception {
        ContrastEnhancer c = new ContrastEnhancer();
        Roi roi = imp.getRoi();
        boolean areaRoi = roi != null && roi.isArea();
        c.setSaturated(sat);
        c.setNormalize(normalize);
        c.setEqualize(equalize);
        boolean updateSelectionOnly = false;
        if (areaRoi) {
            updateSelectionOnly = !entireImage;
            if (!normalize && imp.getBitDepth() != 24) updateSelectionOnly = false;
        }
        Gen.set(c, "updateSelectionOnly", updateSelectionOnly);
        Gen.set(c, "entireImage", entireImage);
        Gen.set(c, "classicEqualization", classic);
        return c;
    }

    static void enhance() throws Exception {
        int[] bd = {8, 16, 32};
        String[] tn = {"u8", "u16", "f32"};
        for (int t = 0; t < 3; t++) {
            int b = bd[t]; String s = tn[t];
            // saturatedRange: resulting display range, image untouched
            for (double sat : new double[]{0.35, 0, 5}) {
                if (sat != 0.35 && t == 2) continue;
                ImageProcessor ip = Gen.tex(b, 48, 37, 200 + t);
                ImageProcessor in = ip.duplicate();
                ImagePlus imp = Gen.imp("t", ip);
                ContrastEnhancer c = ce(imp, sat, false, false, true, false);
                c.stretchHistogram(imp, sat);
                new Fx("bg", "sat_" + s + "_" + (sat == 0.35 ? "035" : sat == 0 ? "0" : "5"), "saturatedRange")
                    .call("ContrastEnhancer: setSaturated(sat); stretchHistogram(imp, sat) -> imp.getProcessor().getMin()/getMax() [= run() without Normalize]")
                    .params("saturated", sat, "normalize", false)
                    .input(in)
                    .result(J.o("displayMin", imp.getProcessor().getMin(), "displayMax", imp.getProcessor().getMax()))
                    .write();
            }
            // saturatedRange inside a rectangle selection
            {
                ImageProcessor ip = Gen.tex(b, 48, 37, 210 + t);
                ImageProcessor in = ip.duplicate();
                ImagePlus imp = Gen.imp("t", ip);
                Roi roi = new Roi(8, 5, 25, 20);
                imp.setRoi(roi);
                ContrastEnhancer c = ce(imp, 0.35, false, false, true, false);
                c.stretchHistogram(imp, 0.35);
                new Fx("bg", "sat_roi_rect_" + s, "saturatedRange")
                    .call("imp.setRoi(rect); ContrastEnhancer.stretchHistogram(imp, 0.35) [ip.setRoi(imp.getRoi()) -> histogram of the selection] -> getMin()/getMax()")
                    .params("saturated", 0.35, "normalize", false)
                    .input(in).roi(roi)
                    .result(J.o("displayMin", imp.getProcessor().getMin(), "displayMax", imp.getProcessor().getMax()))
                    .write();
            }
            // normalize
            for (double sat : new double[]{0.35, 2}) {
                ImageProcessor ip = Gen.tex(b, 48, 37, 220 + t);
                ImageProcessor in = ip.duplicate();
                ImagePlus imp = Gen.imp("t", ip);
                ContrastEnhancer c = ce(imp, sat, true, false, true, false);
                c.stretchHistogram(imp, sat);
                ImageProcessor p = imp.getProcessor();
                p.setMinAndMax(0, p.getBitDepth() == 32 ? 1.0 : p.maxValue());   // run(): after normalize
                new Fx("bg", "normalize_" + s + "_" + (sat == 0.35 ? "035" : "2"), "enhanceNormalize")
                    .call("ContrastEnhancer.setNormalize(true); stretchHistogram(imp, sat); then run()'s ip.setMinAndMax(0, 1.0 | maxValue())")
                    .params("saturated", sat, "normalize", true, "entireImage", true)
                    .input(in).output(ip)
                    .put("displayRange", J.o("min", p.getMin(), "max", p.getMax()))
                    .write();
            }
            // normalize with a rectangle selection, selection only / whole image
            for (boolean entire : new boolean[]{false, true}) {
                ImageProcessor ip = Gen.tex(b, 48, 37, 230 + t);
                ImageProcessor in = ip.duplicate();
                ImagePlus imp = Gen.imp("t", ip);
                Roi roi = new Roi(6, 7, 26, 19);
                imp.setRoi(roi);
                ContrastEnhancer c = ce(imp, 0.35, true, false, entire, false);
                c.stretchHistogram(imp, 0.35);
                ImageProcessor p = imp.getProcessor();
                p.setMinAndMax(0, p.getBitDepth() == 32 ? 1.0 : p.maxValue());
                new Fx("bg", "normalize_roi_rect_" + (entire ? "entire_" : "sel_") + s, "enhanceNormalize")
                    .call("imp.setRoi(rect); setNormalize(true); updateSelectionOnly=!entireImage (showDialog rule); stretchHistogram(imp, 0.35); ip.setMinAndMax(0, max)")
                    .params("saturated", 0.35, "normalize", true, "entireImage", entire)
                    .input(in).roi(roi).output(ip)
                    .put("displayRange", J.o("min", p.getMin(), "max", p.getMax()))
                    .write();
            }
            // normalize with an oval selection, selection only (mask applied through snapshot/reset(mask))
            {
                ImageProcessor ip = Gen.tex(b, 48, 37, 240 + t);
                ImageProcessor in = ip.duplicate();
                ImagePlus imp = Gen.imp("t", ip);
                Roi roi = new OvalRoi(5, 4, 30, 24);
                imp.setRoi(roi);
                ContrastEnhancer c = ce(imp, 0.35, true, false, false, false);
                c.stretchHistogram(imp, 0.35);
                ImageProcessor p = imp.getProcessor();
                p.setMinAndMax(0, p.getBitDepth() == 32 ? 1.0 : p.maxValue());
                new Fx("bg", "normalize_roi_oval_sel_" + s, "enhanceNormalize")
                    .call("imp.setRoi(oval); setNormalize(true); updateSelectionOnly=true; stretchHistogram(imp, 0.35); ip.setMinAndMax(0, max)")
                    .params("saturated", 0.35, "normalize", true, "entireImage", false)
                    .input(in).roi(roi).output(ip)
                    .put("displayRange", J.o("min", p.getMin(), "max", p.getMax()))
                    .write();
            }
            // equalize (32-bit is refused by ImageJ: "Equalization of 32-bit images not supported.")
            if (b != 32) {
                for (boolean classic : new boolean[]{false, true}) {
                    ImageProcessor ip = Gen.tex(b, 48, 37, 250 + t);
                    ImageProcessor in = ip.duplicate();
                    ImagePlus imp = Gen.imp("t", ip);
                    equalize(imp, ce(imp, 0.35, false, true, true, classic), classic);
                    new Fx("bg", "equalize_" + (classic ? "classic_" : "sqrt_") + s, "enhanceEqualize")
                        .call("ContrastEnhancer.equalize(imp) body: classicEqualization=" + classic + "; ip.getHistogram(); private equalize(ip, histogram); imp.getProcessor().resetMinAndMax()")
                        .params("classic", classic)
                        .input(in).output(imp.getProcessor()).write();
                }
                // equalize with a rectangle: histogram of the bounding rectangle, the whole image is remapped
                ImageProcessor ip = Gen.tex(b, 48, 37, 260 + t);
                ImageProcessor in = ip.duplicate();
                ImagePlus imp = Gen.imp("t", ip);
                Roi roi = new Roi(4, 6, 30, 20);
                imp.setRoi(roi);
                equalize(imp, ce(imp, 0.35, false, true, true, false), false);
                new Fx("bg", "equalize_roi_rect_" + s, "enhanceEqualize")
                    .call("imp.setRoi(rect); equalize: histogram = imp.getProcessor().getHistogram() (roi rectangle), LUT applied to the whole image (updateSelectionOnly=false)")
                    .params("classic", false)
                    .input(in).roi(roi).output(imp.getProcessor()).write();
            }
        }
    }

    static void equalize(ImagePlus imp, ContrastEnhancer c, boolean classic) throws Exception {
        Method m = ContrastEnhancer.class.getDeclaredMethod("equalize", ImageProcessor.class, int[].class);
        m.setAccessible(true);
        ImageProcessor ip = imp.getProcessor();
        int[] hist = ip.getHistogram();
        m.invoke(c, ip, hist);
        imp.getProcessor().resetMinAndMax();
    }
}
