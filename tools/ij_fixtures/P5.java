import ij.*;
import ij.gui.*;
import ij.plugin.*;
import ij.process.*;
import java.awt.Rectangle;
import java.awt.geom.Rectangle2D;

/** P5: Rotate, Scale, Resize, Canvas Size, Translate, Bin. */
final class P5 {
    static final int[] BD = {8, 16, 32};
    static final String[] TN = {"u8", "u16", "f32"};
    static final String[] IN = {"none", "bilinear", "bicubic"};     // ImageProcessor.NONE=0, BILINEAR=1, BICUBIC=2

    static void run() throws Exception {
        rotate();
        scale();
        resize();
        canvas();
        translate();
        bin();
    }

    static String a(double d) { return (d < 0 ? "m" : "") + String.valueOf(Math.abs(d)).replace(".0", "").replace(".", "p"); }

    // ------------------------------------------------------------ rotate
    static void rotate() throws Exception {
        for (int t = 0; t < 3; t++) for (double ang : new double[]{15, -30, 90.5}) for (int m = 0; m < 3; m++) {
            rot("rotate_" + a(ang) + "_" + IN[m] + "_" + TN[t], BD[t], ang, m, null, false);
        }
        for (int t = 0; t < 2; t++) for (int m = 1; m < 3; m++) {
            rot("rotate_roi_rect_15_" + IN[m] + "_" + TN[t], BD[t], 15, m, new Roi(5, 4, 20, 15), false);
            rot("rotate_roi_oval_m30_" + IN[m] + "_" + TN[t], BD[t], -30, m, new OvalRoi(4, 3, 22, 17), false);
        }
        rot("rotate_roi_rect_15_none_u8", 8, 15, 0, new Roi(5, 4, 20, 15), false);
        rot("rotate_roi_rect_odd_m30_bilinear_f32", 32, -30, 1, new Roi(6, 5, 17, 13), false);
        for (int t = 0; t < 3; t++) for (double ang : new double[]{15, -30}) {
            rot("rotate_enlarge_" + a(ang) + "_bilinear_" + TN[t], BD[t], ang, 1, null, true);
        }
        rot("rotate_enlarge_15_none_u8", 8, 15, 0, null, true);
        rot("rotate_enlarge_m30_bicubic_u8", 8, -30, 2, null, true);
        rot("rotate_enlarge_90p5_bilinear_u16", 16, 90.5, 1, null, true);
    }

    static void rot(String name, int bits, double angle, int method, Roi roi, boolean enlarge) throws Exception {
        ImageProcessor ip = Gen.tex(bits, 32, 25, 900 + bits);
        ImageProcessor in = ip.duplicate();
        String call;
        String op = enlarge ? "rotateEnlarge" : "rotate";
        if (enlarge) {
            Roi r = RoiRotator.rotate(new Roi(0, 0, ip.getWidth(), ip.getHeight()), angle);
            Rectangle2D.Double fb = r.getFloatBounds();
            Rectangle rc = new Rectangle((int) Math.round(fb.x), (int) Math.round(fb.y), (int) Math.round(fb.width), (int) Math.round(fb.height));
            if (rc.width < ip.getWidth()) rc.width = ip.getWidth();
            if (rc.height < ip.getHeight()) rc.height = ip.getHeight();
            CanvasResizer cr = new CanvasResizer();
            Gen.set(cr, "zeroFill", true);
            int xc = (rc.width - ip.getWidth()) / 2, yc = (rc.height - ip.getHeight()) / 2;
            ip = cr.expandImage(ip, rc.width, rc.height, xc, yc);
            ip.setInterpolationMethod(method);
            ip.setBackgroundValue(0);
            ip.rotate(angle);
            call = "Rotator.enlargeCanvas(): RoiRotator.rotate(new Roi(0,0,w,h), angle).getFloatBounds() rounded (min = image size) -> CanvasResizer.expandImage(zeroFill, Center offsets (new-old)/2); then ip.setInterpolationMethod; ip.setBackgroundValue(0); ip.rotate(angle)";
        } else {
            Gen.runFilter(ip, roi, false, false, true, p -> { p.setInterpolationMethod(method); p.setBackgroundValue(0); p.rotate(angle); });
            call = "Rotator.run(ip): ip.setInterpolationMethod(m); ip.setBackgroundValue(0); ip.rotate(angle) with ip.setRoi(roi) [SUPPORTS_MASKING: snapshot + reset(mask)]";
        }
        Fx f = new Fx("geom", name, op).call(call)
            .params("angle", angle, "interpolation", IN[method], "enlarge", enlarge).input(in);
        if (roi != null) f.roi(roi);
        f.output(ip).write();
    }

    // ------------------------------------------------------------ scale
    static void scale() throws Exception {
        double[] sc = {0.5, 1.7, 0.33};
        for (int t = 0; t < 3; t++) for (double s : sc) for (int m = 0; m < 3; m++) {
            scaleIn("scale_in_" + a(s) + "_" + IN[m] + "_" + TN[t], BD[t], s, s, m, null);
            scaleNew("scale_new_" + a(s) + "_" + IN[m] + "_" + TN[t], BD[t], s, s, m, true, null);
            if (s < 1 && m > 0) scaleNew("scale_new_noavg_" + a(s) + "_" + IN[m] + "_" + TN[t], BD[t], s, s, m, false, null);
        }
        for (int t = 0; t < 3; t++) {
            scaleIn("scale_in_aniso_1p3x0p7_bilinear_" + TN[t], BD[t], 1.3, 0.7, 1, null);
            scaleNew("scale_new_aniso_1p3x0p7_bilinear_" + TN[t], BD[t], 1.3, 0.7, 1, true, null);
        }
        for (int t = 0; t < 2; t++) for (double s : new double[]{0.6, 1.5}) {
            scaleIn("scale_in_roi_rect_" + a(s) + "_bilinear_" + TN[t], BD[t], s, s, 1, new Roi(6, 5, 18, 14));
            scaleNew("scale_new_roi_rect_" + a(s) + "_bilinear_" + TN[t], BD[t], s, s, 1, true, new Roi(6, 5, 18, 14));
        }
    }

    static void scaleIn(String name, int bits, double xs, double ys, int method, Roi roi) throws Exception {
        ImageProcessor ip = Gen.tex(bits, 32, 25, 910 + bits);
        ImageProcessor in = ip.duplicate();
        if (roi != null) ip.setRoi(roi);
        ip.setInterpolationMethod(method);
        ip.setBackgroundValue(0);
        ip.snapshot();
        ip.setSnapshotCopyMode(true);
        ip.scale(xs, ys);
        ip.setSnapshotCopyMode(false);
        ip.resetRoi();
        Fx f = new Fx("geom", name, "scaleInPlace")
            .call("Scaler.scale(imp) in place: ip.setInterpolationMethod(m); ip.setBackgroundValue(0); ip.snapshot(); ip.setSnapshotCopyMode(true); ip.scale(xscale, yscale); ip.setSnapshotCopyMode(false)")
            .params("xscale", xs, "yscale", ys, "interpolation", IN[method]).input(in);
        if (roi != null) f.roi(roi);
        f.output(ip).write();
    }

    static void scaleNew(String name, int bits, double xs, double ys, int method, boolean avg, Roi roi) throws Exception {
        ImageProcessor ip = Gen.tex(bits, 32, 25, 910 + bits);
        ImageProcessor in = ip.duplicate();
        Rectangle r = new Rectangle(0, 0, ip.getWidth(), ip.getHeight());
        if (roi != null) { ip.setRoi(roi); r = roi.getBounds(); }
        int nw = (int) Math.round(r.width * xs), nh = (int) Math.round(r.height * ys);   // Scaler.showDialog
        ip.setInterpolationMethod(method);
        ip.setBackgroundValue(0);
        ImageProcessor out = ip.resize(nw, nh, avg);
        Fx f = new Fx("geom", name, "scaleNew")
            .call("Scaler.scale(imp) new window: ip.setInterpolationMethod(m); ip.resize(round(roiW*xscale), round(roiH*yscale), averageWhenDownsizing); calibration pixelWidth *= 1/xscale")
            .params("xscale", xs, "yscale", ys, "interpolation", IN[method], "averageWhenDownsizing", avg, "width", nw, "height", nh).input(in);
        if (roi != null) f.roi(roi);
        f.output(out).write();
    }

    // ------------------------------------------------------------ resize (Image > Adjust > Size)
    static void resize() throws Exception {
        int[][] sizes = {{60, 20}, {20, 45}, {13, 9}, {80, 62}};
        for (int t = 0; t < 3; t++) for (int[] s : sizes) for (int m = 0; m < 3; m++) {
            if (t > 0 && m == 0) continue;
            for (boolean avg : new boolean[]{true, false}) {
                if (!avg && !(s[0] < 40 || s[1] < 31)) continue;
                ImageProcessor ip = Gen.tex(BD[t], 32, 25, 920 + t);
                ImageProcessor in = ip.duplicate();
                ip.setInterpolationMethod(m);
                ImageProcessor out = ip.resize(s[0], s[1], avg);
                new Fx("geom", "resize_" + s[0] + "x" + s[1] + "_" + IN[m] + (avg ? "" : "_noavg") + "_" + TN[t], "resize")
                    .call("Resizer: ip.setInterpolationMethod(m); StackProcessor.resize(w, h, averageWhenDownsizing) -> ip.resize(w, h, averageWhenDownsizing)")
                    .params("width", s[0], "height", s[1], "interpolation", IN[m], "averageWhenDownsizing", avg).input(in).output(out).write();
            }
        }
        ImageProcessor ip = Gen.tex(16, 32, 25, 925);
        ImageProcessor in = ip.duplicate();
        Roi roi = new Roi(4, 3, 22, 16);
        ip.setRoi(roi);
        ip.setInterpolationMethod(1);
        ImageProcessor out = ip.resize(14, 30, true);
        new Fx("geom", "resize_roi_rect_14x30_bilinear_u16", "resize")
            .call("as resize, ip.setRoi(rect): ip.resize crops the selection first")
            .params("width", 14, "height", 30, "interpolation", "bilinear", "averageWhenDownsizing", true).input(in).roi(roi).output(out).write();
    }

    // ------------------------------------------------------------ canvas size
    static void canvas() throws Exception {
        String[] pos = {"Top-Left", "Top-Center", "Top-Right", "Center-Left", "Center", "Center-Right", "Bottom-Left", "Bottom-Center", "Bottom-Right"};
        int[][] targets = {{23, 17}, {9, 6}, {23, 7}, {12, 15}};
        for (int[] tg : targets) for (int p = 0; p < 9; p++) {
            if (p != 4 && !(tg[0] == 23 && tg[1] == 17) && !(tg[0] == 9 && tg[1] == 6) && p != 0 && p != 8) continue;
            canvasCase("canvas_" + tg[0] + "x" + tg[1] + "_" + pos[p].toLowerCase().replace("-", "") + "_u8", 8, tg[0], tg[1], p, pos[p]);
        }
        for (int t = 1; t < 3; t++) for (int[] tg : new int[][]{{23, 17}, {9, 6}})
            canvasCase("canvas_" + tg[0] + "x" + tg[1] + "_center_" + TN[t], BD[t], tg[0], tg[1], 4, "Center");
        for (int p = 0; p < 9; p++) canvasCase("canvas_all_anchors_16bit_" + pos[p].toLowerCase().replace("-", ""), 16, 21, 15, p, pos[p]);
    }

    static void canvasCase(String name, int bits, int wn, int hn, int pos, String posName) throws Exception {
        ImageProcessor ip = Gen.tex(bits, 16, 12, 930 + bits);
        ImageProcessor in = ip.duplicate();
        int wo = 16, ho = 12;
        int xC = (wn - wo) / 2, xR = (wn - wo), yC = (hn - ho) / 2, yB = (hn - ho);
        int[][] off = {{0, 0}, {xC, 0}, {xR, 0}, {0, yC}, {xC, yC}, {xR, yC}, {0, yB}, {xC, yB}, {xR, yB}};
        CanvasResizer cr = new CanvasResizer();
        Gen.set(cr, "zeroFill", true);
        ImageProcessor out = cr.expandImage(ip, wn, hn, off[pos][0], off[pos][1]);
        new Fx("geom", name, "canvasSize")
            .call("CanvasResizer.run: offsets xC=(wNew-wOld)/2 (Java int division), xR=wNew-wOld, yC, yB per anchor; expandImage(ip, wNew, hNew, xOff, yOff) with zeroFill=true: createProcessor, fill(0), insert")
            .params("width", wn, "height", hn, "position", posName, "zeroFill", true, "xOffset", off[pos][0], "yOffset", off[pos][1]).input(in).output(out).write();
    }

    // ------------------------------------------------------------ translate
    static void translate() throws Exception {
        double[][] d = {{3, -2}, {-4, 5}, {2.5, -1.3}, {0.4, 0.4}, {-6.75, 3.2}};
        for (int t = 0; t < 3; t++) for (double[] v : d) for (int m = 0; m < 3; m++) {
            boolean integer = v[0] == Math.rint(v[0]) && v[1] == Math.rint(v[1]);
            if (integer && m > 0) continue;          // integer shifts are interpolation-independent: record None only
            ImageProcessor ip = Gen.tex(BD[t], 32, 25, 940 + t);
            ImageProcessor in = ip.duplicate();
            ip.setInterpolationMethod(m);
            ip.translate(v[0], v[1]);
            new Fx("geom", "translate_" + a(v[0]) + "_" + a(v[1]) + "_" + IN[m] + "_" + TN[t], "translate")
                .call("Translator.run(ip): ip.setInterpolationMethod(m); ip.translate(xOffset, yOffset)")
                .params("dx", v[0], "dy", v[1], "interpolation", IN[m]).input(in).output(ip).write();
        }
    }

    // ------------------------------------------------------------ bin
    static void bin() throws Exception {
        String[] mn = {"average", "median", "min", "max", "sum"};    // Binner.AVERAGE=0, MEDIAN=1, MIN=2, MAX=3, SUM=4
        for (int t = 0; t < 3; t++) for (int[] f : new int[][]{{2, 2}, {3, 2}}) for (int m = 0; m < 5; m++) {
            ImageProcessor ip = Gen.tex(BD[t], 25, 19, 950 + t);
            ImageProcessor in = ip.duplicate();
            ImagePlus out = new Binner().shrink(new ImagePlus("b", ip), f[0], f[1], 1, m);
            new Fx("geom", "bin_" + f[0] + "x" + f[1] + "_" + mn[m] + "_" + TN[t], "bin")
                .call("new Binner().shrink(imp, xshrink, yshrink, 1, method) [width=w/xshrink, height=h/yshrink integer division, remainder dropped; sum clamped to the type max for 8/16-bit]")
                .params("xshrink", f[0], "yshrink", f[1], "method", mn[m]).input(in).output(out.getProcessor()).write();
        }
    }
}
