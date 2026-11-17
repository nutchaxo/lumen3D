import ij.*;
import ij.gui.*;
import ij.plugin.filter.*;
import ij.process.*;
import java.awt.Polygon;
import java.util.*;

/** P3: EDM family, skeletonize/outline, Find Maxima. */
final class P3 {
    static final int[] BD = {8, 16, 32};
    static final String[] TN = {"u8", "u16", "f32"};

    static void run() throws Exception {
        edmFamily();
        binaryOps();
        findMaxima();
    }

    // ------------------------------------------------------------ binary inputs
    static ByteProcessor blobMask(int w, int h, long seed, int level) {
        ByteProcessor ip = (ByteProcessor) Gen.make(8, Gen.blobs(w, h, seed, 9, 3.0, 6.0, 0.05, 0.03, 0.05, 0.02), w, h);
        ip.threshold(level);   // <= level -> 0, else 255
        return ip;
    }

    static ByteProcessor[] masks() {
        return new ByteProcessor[]{Gen.touchingDisks(48, 40), blobMask(64, 47, 501, 95), Gen.thinLines(45, 33)};
    }
    static final String[] MN = {"disks", "blobs", "thin"};

    // ------------------------------------------------------------ EDM, UEP, watershed, voronoi
    static void edmCase(String name, String op, String arg, int outType, ByteProcessor in) throws Exception {
        ByteProcessor ip = (ByteProcessor) in.duplicate();
        ImagePlus imp = Gen.imp("m", ip);
        EDM.setOutputType(outType);
        EDM e = new EDM();
        e.setup(arg, imp);
        e.run(ip);
        ImageProcessor out = ip;
        if (outType != EDM.BYTE_OVERWRITE && !arg.equals("watershed")) {
            ImagePlus o = (ImagePlus) Gen.get(e, "outImp");
            out = o.getProcessor();
        }
        EDM.setOutputType(EDM.BYTE_OVERWRITE);
        String[] ot = {"overwrite", "byte", "short", "float"};
        new Fx("seg", name, op)
            .call("Prefs.blackBackground=true; EDM.setOutputType(" + ot[outType] + "); EDM e=new EDM(); e.setup(\"" + arg + "\", imp); e.run(ip)" + (outType != 0 && !arg.equals("watershed") ? "; output = e.outImp (private, reflection)" : ""))
            .params("output", ot[outType]).input(in).output(out).write();
    }

    static void edmFamily() throws Exception {
        ByteProcessor[] m = masks();
        for (int i = 0; i < 3; i++) {
            edmCase("edm_overwrite_" + MN[i], "edm", "", EDM.BYTE_OVERWRITE, m[i]);
            edmCase("edm_float_" + MN[i], "edm", "", EDM.FLOAT, m[i]);
            edmCase("ultimate_overwrite_" + MN[i], "ultimatePoints", "points", EDM.BYTE_OVERWRITE, m[i]);
            edmCase("ultimate_float_" + MN[i], "ultimatePoints", "points", EDM.FLOAT, m[i]);
            edmCase("watershed_" + MN[i], "watershed", "watershed", EDM.BYTE_OVERWRITE, m[i]);
            edmCase("voronoi_overwrite_" + MN[i], "voronoi", "voronoi", EDM.BYTE_OVERWRITE, m[i]);
            edmCase("voronoi_float_" + MN[i], "voronoi", "voronoi", EDM.FLOAT, m[i]);
        }
        // sparse particles for a readable Voronoi; non-square odd size
        ByteProcessor sp = Gen.binary(37, 29);
        Gen.disk(sp, 7, 7, 3, 255); Gen.disk(sp, 28, 9, 4.2, 255); Gen.disk(sp, 12, 22, 2.5, 255);
        Gen.disk(sp, 30, 24, 3.4, 255); sp.set(19, 14, 255);
        edmCase("voronoi_overwrite_sparse", "voronoi", "voronoi", EDM.BYTE_OVERWRITE, sp);
        edmCase("voronoi_float_sparse", "voronoi", "voronoi", EDM.FLOAT, sp);
        edmCase("edm_float_sparse", "edm", "", EDM.FLOAT, sp);
        // a big mask so the EDM exceeds 255 is impractical here; a filled rectangle touching all borders
        ByteProcessor full = Gen.binary(33, 21);
        for (int y = 0; y < 21; y++) for (int x = 0; x < 33; x++) full.set(x, y, 255);
        edmCase("edm_float_full", "edm", "", EDM.FLOAT, full);
        edmCase("watershed_full", "watershed", "watershed", EDM.BYTE_OVERWRITE, full);
    }

    // ------------------------------------------------------------ skeletonize / outline
    static void binaryOps() throws Exception {
        ByteProcessor[] m = masks();
        for (int i = 0; i < 3; i++) for (String arg : new String[]{"skeletonize", "outline"}) {
            ByteProcessor ip = (ByteProcessor) m[i].duplicate();
            ImagePlus imp = Gen.imp("m", ip);
            Binary b = new Binary();
            b.setup(arg, imp);
            b.run(ip);
            new Fx("seg", arg + "_" + MN[i], arg.equals("outline") ? "binary" : "skeletonize")
                .call("Prefs.blackBackground=true; Binary b=new Binary(); b.setup(\"" + arg + "\", imp); b.run(ip) [" + (arg.equals("outline") ? "outline(): invert; ByteProcessor.outline(); invert" : "ByteProcessor.skeletonize(255)") + "]")
                .params(arg.equals("outline") ? new Object[]{"op", "outline"} : new Object[0]).input(m[i]).output(ip).write();
        }
    }

    // ------------------------------------------------------------ Find Maxima
    /** Peaks with plateaus, equal-height ties, edge and corner maxima, a ridge saddle. Levels 0..255. */
    static int[] peaksLevels(int w, int h, long seed) {
        float[] v = Gen.blobs(w, h, seed, 6, 2.0, 4.0, 0.08, 0.05, 0.1, 0.0);
        int[] u = new int[w * h];
        for (int i = 0; i < u.length; i++) u[i] = Math.min(180, Math.round(v[i] * 255f));
        for (int y = 8; y < 11; y++) for (int x = 10; x < 13; x++) u[y * w + x] = 230;          // 3x3 plateau
        u[20 * w + 30] = 210; u[20 * w + 22] = 210;                                              // equal height ties
        for (int y = 19; y < 22; y++) for (int x = 21; x < 24; x++) if (u[y * w + x] < 190) u[y * w + x] = 190;
        for (int y = 19; y < 22; y++) for (int x = 29; x < 32; x++) if (u[y * w + x] < 190) u[y * w + x] = 190;
        u[12 * w + 0] = 220; u[11 * w + 0] = 150; u[13 * w + 0] = 150;                            // edge maximum
        u[(h - 1) * w + (w - 1)] = 215;                                                            // corner maximum
        for (int x = 2; x < 8; x++) u[2 * w + x] = 60 + (x % 2) * 25;                              // ridge of small teeth
        for (int y = 15; y < 17; y++) for (int x = 3; x < 7; x++) u[y * w + x] = 120;             // low 2x4 plateau
        return u;
    }

    static int[] lowContrast(int w, int h) {
        int[] u = new int[w * h];
        Random r = new Random(77);
        for (int i = 0; i < u.length; i++) u[i] = 100 + r.nextInt(8);
        u[10 * w + 10] = 125; u[4 * w + 20] = 118;
        return u;
    }

    static ImageProcessor scaled(int bits, int[] u, int w, int h) { return Gen.levels(bits, u, w, h); }

    /** prominence in 8-bit units -> type units. */
    static double prom(int bits, double p8) { return bits == 8 ? p8 : bits == 16 ? p8 * 200 : p8 * 0.01; }

    static void fm(String name, ImageProcessor ip, Roi roi, double prominence, boolean strict, boolean excl, boolean light,
                   Double aboveLower, boolean images) throws Exception {
        ImageProcessor in = ip.duplicate();
        if (aboveLower != null) {
            ip.setThreshold(aboveLower, ip.getBitDepth() == 8 ? 255 : ip.getBitDepth() == 16 ? 65535 : 1e9, ImageProcessor.NO_LUT_UPDATE);
            in.setThreshold(aboveLower, ip.getMaxThreshold(), ImageProcessor.NO_LUT_UPDATE);
        }
        Map<String, Object> res = new LinkedHashMap<>();
        Map<String, Object> outs = new LinkedHashMap<>();
        int[] types = images ? new int[]{3, 0, 1, 2} : new int[]{3};
        String[] keys = {"single", "tolerance", "segmented"};
        for (int ot : types) {
            Roi r = roi;
            if (ot == MaximumFinder.SEGMENTED) r = null;                 // run(): imp.deleteRoi() when outputType==SEGMENTED
            ImageProcessor p = ip;
            double threshold = aboveLower != null ? ip.getMinThreshold() : ImageProcessor.NO_THRESHOLD;
            if (light) {                                                  // MaximumFinder.run(): find minima by inverting a copy
                threshold = ImageProcessor.NO_THRESHOLD;
                p = ip.duplicate();
                p.invert();
            }
            p.setRoi(r);
            MaximumFinder mf = new MaximumFinder();
            ByteProcessor out = mf.findMaxima(p, prominence, strict, threshold, ot, excl, false);
            if (ot == MaximumFinder.POINT_SELECTION) {
                Polygon poly = (Polygon) Gen.get(mf, "xyCoordinates");
                int n = poly == null ? 0 : poly.npoints;
                int[] pts = new int[2 * n];
                for (int i = 0; i < n; i++) { pts[2 * i] = poly.xpoints[i]; pts[2 * i + 1] = poly.ypoints[i]; }
                res.put("count", n);
                res.put("points", pts);
            } else outs.put(keys[ot], J.image(out));
            ip.resetRoi();
        }
        Fx f = new Fx("seg", name, "findMaxima")
            .call("MaximumFinder.run(ip) body: light -> ip.duplicate().invert(); threshold = ip.getMinThreshold() if Above lower threshold; ip.setRoi(roi) (segmented: no roi); new MaximumFinder().findMaxima(ip, prominence, strict, threshold, outputType, excludeOnEdges, false); points = private xyCoordinates (reflection), sorted as ImageJ emits them")
            .params("prominence", prominence, "strict", strict, "excludeEdges", excl, "light", light,
                    "aboveLower", aboveLower == null ? null : J.o("lower", aboveLower))
            .input(in);
        if (roi != null) f.roi(roi);
        f.result(res);
        if (images) { f.put("outputsOp", "findMaximaImage"); f.put("outputs", outs); }
        f.write();
    }

    static void findMaxima() throws Exception {
        int w = 40, h = 30;
        int[] u = peaksLevels(w, h, 520);
        for (int t = 0; t < 3; t++) {
            int b = BD[t]; String s = TN[t];
            for (double p8 : new double[]{10, 40}) {
                String ps = "p" + (int) p8;
                if (t == 0) {
                    for (boolean strict : new boolean[]{false, true}) for (boolean excl : new boolean[]{false, true})
                        fm("fm_" + ps + (strict ? "_strict" : "_loose") + (excl ? "_excl" : "_incl") + "_" + s, scaled(b, u, w, h), null, prom(b, p8), strict, excl, false, null, true);
                } else {
                    fm("fm_" + ps + "_loose_incl_" + s, scaled(b, u, w, h), null, prom(b, p8), false, false, false, null, true);
                    fm("fm_" + ps + "_strict_excl_" + s, scaled(b, u, w, h), null, prom(b, p8), true, true, false, null, true);
                }
            }
            fm("fm_p10_light_" + s, scaled(b, invertLevels(u), w, h), null, prom(b, 10), false, false, true, null, true);
            fm("fm_p40_light_excl_" + s, scaled(b, invertLevels(u), w, h), null, prom(b, 40), true, true, true, null, true);
            double lower = b == 8 ? 100 : b == 16 ? 100 * 200 : 100 * 0.01 + 1;
            fm("fm_p10_above_lower_" + s, scaled(b, u, w, h), null, prom(b, 10), false, false, false, lower, true);
            fm("fm_p10_roi_rect_" + s, scaled(b, u, w, h), new Roi(5, 4, 28, 20), prom(b, 10), false, false, false, null, true);
            fm("fm_p10_roi_oval_" + s, scaled(b, u, w, h), new OvalRoi(4, 3, 30, 22), prom(b, 10), false, false, false, null, true);
            int[] lc = lowContrast(w, h);
            fm("fm_lowcontrast_strict_" + s, scaled(b, lc, w, h), null, prom(b, 40), true, false, false, null, true);
            fm("fm_lowcontrast_loose_" + s, scaled(b, lc, w, h), null, prom(b, 40), false, false, false, null, true);
            // smooth gaussian-blob image, floating-point style values (sort-key quantisation on 32-bit)
            fm("fm_blobs_p20_" + s, Gen.tex(b, 57, 43, 530 + t), null, b == 8 ? 20 : b == 16 ? 4000 : 40, false, false, false, null, true);
            fm("fm_blobs_p20_excl_strict_" + s, Gen.tex(b, 57, 43, 530 + t), null, b == 8 ? 20 : b == 16 ? 4000 : 40, true, true, false, null, true);
        }
    }

    static int[] invertLevels(int[] u) { int[] o = new int[u.length]; for (int i = 0; i < u.length; i++) o[i] = 255 - u[i]; return o; }
}
