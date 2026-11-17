import ij.*;
import ij.gui.*;
import ij.plugin.filter.*;
import ij.process.*;

/** P2: 3x3 filters, unsharp mask, convolve, rank extras, top hat, remove NaNs, math, NaN background. */
final class P2 {
    static final int[] BD = {8, 16, 32};
    static final String[] TN = {"u8", "u16", "f32"};

    static void run() throws Exception {
        filter3x3();
        unsharp();
        convolve();
        rankExtra();
        math2();
        nanBackground();
    }

    static Fx fx(String name, String op, String call) { return new Fx("flt", name, op).call(call); }

    // ------------------------------------------------------------ smooth / sharpen / find edges
    static void filter3x3() throws Exception {
        String[] types = {"smooth", "sharpen", "edges"};
        for (int t = 0; t < 3; t++) for (int k = 0; k < 3; k++) {
            ImageProcessor ip = Gen.noise(BD[t], 17, 13, 300 + 10 * t + k);
            ImageProcessor in = ip.duplicate();
            final int kk = k;
            Gen.runFilter(ip, null, false, false, true, p -> three(p, kk));
            fx(types[k] + "_" + TN[t], "filter3x3", "Filters.run(ip): ip.setSnapshotCopyMode(true); ip." + new String[]{"smooth()", "sharpen()", "findEdges()"}[k] + "; ip.setSnapshotCopyMode(false)")
                .params("type", types[k]).input(in).output(ip).write();
        }
        // smooth tex 8/16/32 non-square with rect and oval selection
        for (int t = 0; t < 3; t++) for (int k = 0; k < 3; k++) {
            for (int r = 0; r < 2; r++) {
                ImageProcessor ip = Gen.tex(BD[t], 33, 25, 320 + t);
                ImageProcessor in = ip.duplicate();
                Roi roi = r == 0 ? new Roi(5, 4, 17, 13) : new OvalRoi(6, 3, 19, 15);
                final int kk = k;
                Gen.runFilter(ip, roi, false, false, true, p -> three(p, kk));
                fx(types[k] + "_roi_" + (r == 0 ? "rect" : "oval") + "_" + TN[t], "filter3x3",
                    "PlugInFilterRunner: ip.setRoi(roi); snapshot if mask; Filters.run(ip) [smooth|sharpen|findEdges]; ip.reset(mask)")
                    .params("type", types[k]).input(in).roi(roi).output(ip).write();
            }
        }
    }

    static void three(ImageProcessor p, int k) {
        p.setSnapshotCopyMode(true);
        if (k == 0) p.smooth(); else if (k == 1) p.sharpen(); else p.findEdges();
        p.setSnapshotCopyMode(false);
    }

    // ------------------------------------------------------------ unsharp mask
    static void unsharp() throws Exception {
        for (int t = 0; t < 3; t++) {
            ImageProcessor ip = Gen.tex(BD[t], 45, 33, 330 + t);
            ImageProcessor in = ip.duplicate();
            UnsharpMask us = new UnsharpMask();
            Gen.runFilter(ip, null, true, true, true, p -> us.sharpenFloat((FloatProcessor) p, 2.0, 0.6f));
            fx("unsharp_s2_w06_" + TN[t], "unsharpMask", "flags CONVERT_TO_FLOAT|SNAPSHOT|SUPPORTS_MASKING; new UnsharpMask().sharpenFloat(fp, sigma, (float)weight) = run(fp); ip.setPixels(0, fp)")
                .params("sigma", 2.0, "weight", 0.6).input(in).output(ip).write();
        }
        for (int t = 0; t < 3; t++) {
            ImageProcessor ip = Gen.tex(BD[t], 45, 33, 340 + t);
            ImageProcessor in = ip.duplicate();
            Roi roi = t == 1 ? new OvalRoi(8, 5, 26, 20) : new Roi(8, 5, 26, 20);
            UnsharpMask us = new UnsharpMask();
            Gen.runFilter(ip, roi, true, true, true, p -> us.sharpenFloat((FloatProcessor) p, 1.2, 0.4f));
            fx("unsharp_s12_w04_roi_" + TN[t], "unsharpMask", "as unsharp_s2_w06 with ip.setRoi(roi); mask applied by snapshot + ip.reset(mask)")
                .params("sigma", 1.2, "weight", 0.4).input(in).roi(roi).output(ip).write();
        }
    }

    // ------------------------------------------------------------ convolve
    static void conv(String name, int bits, float[] k, int kw, int kh, boolean normalize, Roi roi) throws Exception {
        ImageProcessor ip = Gen.tex(bits, 37, 29, 350 + bits);
        ImageProcessor in = ip.duplicate();
        Convolver c = new Convolver();
        c.setNormalize(normalize);
        Gen.runFilter(ip, roi, true, true, true, p -> c.convolve(p, k, kw, kh));
        Fx f = fx(name, "convolve", "flags CONVERT_TO_FLOAT|SUPPORTS_MASKING|SNAPSHOT; Convolver.setNormalize(normalize); Convolver.convolve(fp, kernel, kw, kh) [kw==1||kh==1 -> convolveFloat1D]; ip.setPixels(0, fp)")
            .params("kernel", k, "kw", kw, "kh", kh, "normalize", normalize).input(in);
        if (roi != null) f.roi(roi);
        f.output(ip).write();
    }

    static void convolve() throws Exception {
        float[] asym = {1, 2, 0, 3, 4, -1, 0, 1, 2};                                  // sum 12, non-symmetric
        float[] k5 = {0, 1, 2, 1, 0, 1, 3, 5, 3, 1, 2, 5, 9, 5, 2, 1, 3, 5, 3, 1, 0, 1, 2, 1, 0};
        float[] zero = {-1, 0, 1, -2, 0, 2, -1, 0, 1};                                // sum 0
        float[] row = {1, 2, 3, 2, 1};
        float[] col = {-1, 0, 1};
        for (int t = 0; t < 3; t++) {
            int b = BD[t]; String s = TN[t];
            conv("conv_3x3_asym_norm_" + s, b, asym, 3, 3, true, null);
            conv("conv_5x5_nonorm_" + s, b, k5, 5, 5, false, null);
            conv("conv_5x5_norm_" + s, b, k5, 5, 5, true, null);
            conv("conv_3x3_zerosum_norm_" + s, b, zero, 3, 3, true, null);
            conv("conv_5x1_norm_" + s, b, row, 5, 1, true, null);
            conv("conv_1x3_nonorm_" + s, b, col, 1, 3, false, null);
        }
        conv("conv_3x3_asym_norm_roi_rect_u16", 16, asym, 3, 3, true, new Roi(6, 5, 20, 15));
        conv("conv_5x5_norm_roi_oval_u8", 8, k5, 5, 5, true, new OvalRoi(5, 4, 24, 18));
    }

    // ------------------------------------------------------------ variance, outliers, despeckle, top hat, remove NaNs
    static ImageProcessor spiky(int bits, int w, int h, long seed) {
        ImageProcessor ip = Gen.tex(bits, w, h, seed);
        double mx = bits == 8 ? 255 : bits == 16 ? 65535 : 400;
        double mn = bits == 32 ? -100 : 0;
        int[][] hot = {{5, 5}, {12, 9}, {20, 14}, {w - 1, 0}, {0, h - 1}};
        for (int i = 0; i < hot.length; i++) ip.setf(hot[i][0], hot[i][1], (float) (i % 2 == 0 ? mx : mn));
        return ip;
    }

    static void rank(String name, String op, int bits, ImageProcessor ip, Roi roi, double radius, int type, int which, float thr,
                     boolean light, boolean dontSub, String callTail, Object... extra) throws Exception {
        ImageProcessor in = ip.duplicate();
        RankFilters rf = new RankFilters();
        boolean multi = type >= RankFilters.OPEN;
        Gen.runFilter(ip, roi, false, multi && roi != null, true, p -> rf.rank(p, radius, type, which, thr, light, dontSub));
        Object[] kv = new Object[extra.length];
        System.arraycopy(extra, 0, kv, 0, extra.length);
        Fx f = fx(name, op, "RankFilters.rank(ip, radius, filterType, whichOutliers, threshold, lightBackground, dontSubtract) " + callTail)
            .params(kv).input(in);
        if (roi != null) f.roi(roi);
        f.output(ip).write();
    }

    static void rankExtra() throws Exception {
        for (int t = 0; t < 3; t++) {
            int b = BD[t]; String s = TN[t];
            double th = b == 8 ? 20 : b == 16 ? 4000 : 40;
            rank("variance_r2_" + s, "rankExtra", b, spiky(b, 33, 25, 360 + t), null, 2, RankFilters.VARIANCE, 0, 0f, false, false, "[VARIANCE]", "type", "variance", "radius", 2.0);
            rank("variance_r35_" + s, "rankExtra", b, Gen.tex(b, 33, 25, 365 + t), null, 3.5, RankFilters.VARIANCE, 0, 0f, false, false, "[VARIANCE]", "type", "variance", "radius", 3.5);
            rank("outliers_bright_r2_" + s, "rankExtra", b, spiky(b, 33, 25, 370 + t), null, 2, RankFilters.OUTLIERS, RankFilters.BRIGHT_OUTLIERS, (float) th, false, false,
                "[OUTLIERS, BRIGHT_OUTLIERS]", "type", "outliersBright", "radius", 2.0, "threshold", th);
            rank("outliers_dark_r2_" + s, "rankExtra", b, spiky(b, 33, 25, 375 + t), null, 2, RankFilters.OUTLIERS, RankFilters.DARK_OUTLIERS, (float) th, false, false,
                "[OUTLIERS, DARK_OUTLIERS]", "type", "outliersDark", "radius", 2.0, "threshold", th);
            rank("despeckle_" + s, "rank", b, spiky(b, 33, 25, 380 + t), null, 1, RankFilters.MEDIAN, 0, 0f, false, false,
                "[Despeckle = MEDIAN radius 1; existing v1 op 'rank']", "type", "median", "radius", 1.0);
            rank("tophat_r5_dark_" + s, "topHat", b, Gen.tex(b, 49, 37, 385 + t), null, 5, RankFilters.TOP_HAT, 0, 0f, false, false,
                "[TOP_HAT, lightBackground=false, dontSubtract=false]", "radius", 5.0, "light", false, "dontSubtract", false);
            rank("tophat_r5_light_" + s, "topHat", b, Gen.make(b, Gen.invert01(Gen.blobs(49, 37, 390 + t, 5, 2.5, 6, 0.15, 0.1, 0.12, 0.03)), 49, 37), null, 5, RankFilters.TOP_HAT, 0, 0f, true, false,
                "[TOP_HAT, lightBackground=true, dontSubtract=false]", "radius", 5.0, "light", true, "dontSubtract", false);
            rank("tophat_r4_dark_nosub_" + s, "topHat", b, Gen.tex(b, 49, 37, 395 + t), null, 4, RankFilters.TOP_HAT, 0, 0f, false, true,
                "[TOP_HAT, dontSubtract=true = grey opening]", "radius", 4.0, "light", false, "dontSubtract", true);
            rank("tophat_r4_light_nosub_" + s, "topHat", b, Gen.make(b, Gen.invert01(Gen.blobs(49, 37, 398 + t, 5, 2.5, 6, 0.15, 0.1, 0.12, 0.03)), 49, 37), null, 4, RankFilters.TOP_HAT, 0, 0f, true, true,
                "[TOP_HAT, lightBackground=true, dontSubtract=true = grey closing]", "radius", 4.0, "light", true, "dontSubtract", true);
        }
        rank("variance_r2_roi_rect_u8", "rankExtra", 8, spiky(8, 33, 25, 400), new Roi(6, 5, 18, 12), 2, RankFilters.VARIANCE, 0, 0f, false, false, "[VARIANCE] with ip.setRoi(rect)", "type", "variance", "radius", 2.0);
        rank("outliers_bright_roi_oval_u16", "rankExtra", 16, spiky(16, 33, 25, 401), new OvalRoi(4, 3, 24, 18), 2, RankFilters.OUTLIERS, RankFilters.BRIGHT_OUTLIERS, 4000f, false, false,
            "[OUTLIERS] with oval mask, snapshot + reset(mask)", "type", "outliersBright", "radius", 2.0, "threshold", 4000.0);
        rank("tophat_r4_roi_rect_u16", "topHat", 16, Gen.tex(16, 49, 37, 402), new Roi(8, 7, 30, 20), 4, RankFilters.TOP_HAT, 0, 0f, false, false,
            "[TOP_HAT] with rectangle: first step on the grown rectangle, resetRoiBoundary", "radius", 4.0, "light", false, "dontSubtract", false);
        rank("tophat_r4_roi_oval_f32", "topHat", 32, Gen.tex(32, 49, 37, 403), new OvalRoi(8, 7, 30, 22), 4, RankFilters.TOP_HAT, 0, 0f, false, false,
            "[TOP_HAT] with oval mask", "radius", 4.0, "light", false, "dontSubtract", false);
        // Remove NaNs (32-bit only)
        for (double r : new double[]{1, 2, 3.5}) {
            rank("removenans_r" + (r == 3.5 ? "35" : "" + (int) r) + "_f32", "removeNaNs", 32, Gen.withNaNs(24, 19, 410), null, r, RankFilters.REMOVE_NAN, 0, 0f, false, false,
                "[REMOVE_NAN]", "radius", r);
        }
        rank("removenans_r2_roi_rect_f32", "removeNaNs", 32, Gen.withNaNs(24, 19, 411), new Roi(2, 2, 14, 12), 2, RankFilters.REMOVE_NAN, 0, 0f, false, false,
            "[REMOVE_NAN] with rectangle", "radius", 2.0);
    }

    // ------------------------------------------------------------ math
    static void math(String name, String arg, int bits, ImageProcessor ip, Roi roi, String binary, Double gamma, Double dmin, Double dmax) throws Exception {
        if (dmin != null) ip.setMinAndMax(dmin, dmax); else if (bits != 8) ip.resetMinAndMax();
        double pmin = ip.getMin(), pmax = ip.getMax();
        ImageProcessor in = ip.duplicate();
        in.setMinAndMax(pmin, pmax);
        ImagePlus imp = Gen.imp("m", ip);
        ImageMath im = new ImageMath();
        im.setup(arg, imp);
        if (binary != null) Gen.set(im, "andValue", binary);
        if (gamma != null) Gen.set(im, "gammaValue", gamma);
        Gen.runFilter(ip, roi, false, false, true, p -> im.run(p));
        String op = "math2";
        java.util.LinkedHashMap<String, Object> pm = new java.util.LinkedHashMap<>();
        pm.put("op", arg);
        if (gamma != null) pm.put("value", gamma);
        if (binary != null) pm.put("value", Integer.parseInt(binary, 2));
        pm.put("displayMin", pmin); pm.put("displayMax", pmax); pm.put("displayRangeExplicit", dmin != null);
        Fx f = fx(name, op, "ImageMath.setup(\"" + arg + "\", imp); ImageMath.run(ip) -> ip." + (arg.equals("sqr") || arg.equals("sqrt") || arg.equals("log") || arg.equals("exp") ? arg + "()" : arg.equals("gamma") ? "gamma(v)" : arg.equals("reciprocal") ? "per-pixel 1/v (0 -> NaN)" : arg + "(int)") + " (ByteProcessor/ShortProcessor/FloatProcessor.process)")
            .put("params", pm).input(in);
        if (roi != null) f.roi(roi);
        f.output(ip).write();
    }

    static void math2() throws Exception {
        String[] simple = {"log", "exp", "sqr", "sqrt"};
        for (int t = 0; t < 3; t++) {
            int b = BD[t]; String s = TN[t];
            for (String a : simple) {
                math(a + "_" + s, a, b, Gen.tex(b, 29, 21, 420 + t), null, null, null, null, null);
                if (b != 32) math(a + "_displayrange_" + s, a, b, Gen.tex(b, 29, 21, 421 + t), null, null, null, b == 8 ? 20.0 : 3000.0, b == 8 ? 200.0 : 50000.0);
            }
            math("gamma05_" + s, "gamma", b, Gen.tex(b, 29, 21, 430 + t), null, null, 0.5, null, null);
            math("gamma22_" + s, "gamma", b, Gen.tex(b, 29, 21, 431 + t), null, null, 2.2, null, null);
            if (b != 32) math("gamma05_displayrange_" + s, "gamma", b, Gen.tex(b, 29, 21, 432 + t), null, null, 0.5, b == 8 ? 20.0 : 3000.0, b == 8 ? 200.0 : 50000.0);
            if (b != 32) {
                math("and_" + s, "and", b, Gen.noise(b, 17, 13, 440 + t), null, b == 8 ? "11110000" : "1111000011110000", null, null, null);
                math("or_" + s, "or", b, Gen.noise(b, 17, 13, 441 + t), null, b == 8 ? "00001111" : "0000111100001111", null, null, null);
                math("xor_" + s, "xor", b, Gen.noise(b, 17, 13, 442 + t), null, b == 8 ? "10101010" : "1010101010101010", null, null, null);
            }
        }
        math("reciprocal_f32", "reciprocal", 32, zeroRich(), null, null, null, null, null);
        math("log_f32_roi_oval", "log", 32, Gen.tex(32, 29, 21, 450), new OvalRoi(4, 3, 20, 14), null, null, null, null);
        math("sqrt_u16_roi_rect", "sqrt", 16, Gen.tex(16, 29, 21, 451), new Roi(3, 3, 15, 11), null, null, null, null);
        math("and_u8_roi_oval", "and", 8, Gen.noise(8, 17, 13, 452), new OvalRoi(2, 2, 12, 9), "11110000", null, null, null);
    }

    /** Float image with zeros, negatives, tiny and large values. */
    static ImageProcessor zeroRich() {
        ImageProcessor ip = Gen.tex(32, 17, 13, 460);
        float[] p = (float[]) ip.getPixels();
        for (int i = 0; i < p.length; i += 7) p[i] = 0f;
        for (int i = 3; i < p.length; i += 11) p[i] = -p[i];
        p[10] = 1e-9f; p[11] = 3e8f;
        return ip;
    }

    // ------------------------------------------------------------ NaN background (32-bit, thresholded)
    static void nanBackground() throws Exception {
        for (int r = 0; r < 3; r++) {
            ImageProcessor ip = Gen.tex(32, 29, 21, 470 + r);
            ImageProcessor in = ip.duplicate();
            double lo = r == 0 ? 50 : r == 1 ? 120 : -30, hi = r == 0 ? 250 : r == 1 ? 1e9 : 80;
            ip.setThreshold(lo, hi, ImageProcessor.NO_LUT_UPDATE);
            ImagePlus imp = Gen.imp("n", ip);
            ImageMath im = new ImageMath();
            im.setup("nan", imp);
            Roi roi = r == 2 ? new OvalRoi(3, 3, 20, 14) : null;
            Gen.runFilter(ip, roi, false, false, true, p -> im.run(p));
            Fx f = fx("nanbackground_" + r + "_f32", "nanBackground", "ip.setThreshold(lower, upper); ImageMath.setup(\"nan\", imp); ImageMath.run(ip) -> setBackgroundToNaN(ip): v<lower||v>upper -> NaN (whole image, roi ignored by the loop but masking restores outside the mask)")
                .params("lower", lo, "upper", hi).input(in);
            if (roi != null) f.roi(roi);
            f.output(ip).write();
        }
    }
}
