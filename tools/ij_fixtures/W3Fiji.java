import ij.*;
import ij.measure.*;
import ij.plugin.filter.FractalBoxCounter;
import ij.process.*;
import ij.util.Tools;
import java.util.*;

/** fiji (IJ1 part): Fractal Box Count, Curve Fitting with every built-in function (single-threaded, seeded Minimizer).
 *  The Fiji-plugin references (Skeleton, Local Thickness, Coloc 2, CLAHE, ...) are written by tools/ij_fixtures/fiji/FijiRefs.java. */
final class W3Fiji {
    static void run() throws Exception {
        fractal();
        curveFitting();
    }

    // ------------------------------------------------------------------ Fractal Box Count
    static ByteProcessor carpet(int n) {   // Sierpinski carpet of side 3^k (81 = 3^4): D = ln 8 / ln 3 = 1.8928
        ByteProcessor ip = new ByteProcessor(n, n);
        for (int y = 0; y < n; y++) for (int x = 0; x < n; x++) {
            boolean hole = false;
            for (int a = x, b = y; a > 0 || b > 0; a /= 3, b /= 3) if (a % 3 == 1 && b % 3 == 1) { hole = true; break; }
            ip.set(x, y, hole ? 0 : 255);
        }
        return ip;
    }

    static ByteProcessor dust(int n, long seed) {
        Random r = new Random(seed);
        ByteProcessor ip = new ByteProcessor(n, n);
        for (int i = 0; i < n * n / 7; i++) ip.set(r.nextInt(n), r.nextInt(n), 255);
        return ip;
    }

    static void fractal() throws Exception {
        ByteProcessor[] ims = {carpet(81), dust(64, 4), Gen.thinLines(64, 64), (ByteProcessor) Gen.touchingDisks(72, 56)};
        String[] nm = {"carpet81", "dust64", "thinLines64", "disks72x56"};
        List<Object> cases = new ArrayList<>();
        String[] sizes = {"2,3,4,6,8,12,16,32,64", "2,4,8,16", "3,5,7"};
        for (int k = 0; k < ims.length; k++) for (String sz : sizes) for (int variant = 0; variant < 3; variant++) {
            // variant 0: object = 255, 'Black Background' on; 1: the inverted image (object 0), off; 2: object 255 with an inverting LUT, on
            ByteProcessor ip = (ByteProcessor) ims[k].duplicate();
            if (variant == 1) ip.invert();
            if (variant == 2) ip.invertLut();
            ImagePlus imp = Gen.imp("f", ip);
            ResultsTable rt = ResultsTable.getResultsTable();
            rt.reset();
            Object res;
            try {
                FractalBoxCounter fb = new FractalBoxCounter();
                fb.setup("", imp);
                WindowManager.setTempCurrentImage(imp);
                Macro.setOptions("box=[" + sz + "]" + (variant == 1 ? "" : " black"));
                fb.run(ip);
                String[] hs = rt.getHeadings();
                List<Object> heads = new ArrayList<>(), vals = new ArrayList<>();
                for (String h : hs) { if (h == null || h.trim().isEmpty()) continue; heads.add(h); int c = rt.getColumnIndex(h); vals.add(c == ResultsTable.COLUMN_NOT_FOUND ? rt.getStringValue(h, 0) : rt.getValueAsDouble(c, 0)); }
                res = rt.size() == 0 ? J.o("empty", true) : J.o("headings", heads, "values", vals);
            } catch (Throwable t) { res = J.o("error", String.valueOf(t)); }
            finally { Macro.setOptions(null); WindowManager.setTempCurrentImage(null); rt.reset(); }
            cases.add(J.o("image", nm[k], "params", J.o("boxSizes", sz, "blackBackground", variant != 1, "invertedLut", variant == 2, "inverted", variant == 1), "result", res));
        }
        List<Object> inputs = new ArrayList<>();
        for (int k = 0; k < ims.length; k++) inputs.add(J.o("name", nm[k], "image", J.image(ims[k])));
        new Fx("fiji", "fractal_box_count", "toolsFractalBoxCount")
            .call("FractalBoxCounter.setup + run(ip) with macro options box=[sizes] [black]; counts C<size> and D (-slope of the straight-line CurveFitter fit of ln(count) on ln(size)) read from the Results table; inputs are 8-bit binary images (object = 255 unless 'inverted')")
            .put("inputs", inputs).put("cases", cases).write();
    }

    // ------------------------------------------------------------------ Curve fitting
    interface Fn { double f(double x); }

    static double[] xs(double a, double b, int n) { double[] x = new double[n]; for (int i = 0; i < n; i++) x[i] = a + (b - a) * i / (n - 1.0); return x; }

    static void curveFitting() throws Exception {
        int[] types = CurveFitter.sortedTypes;
        List<Object> cases = new ArrayList<>();
        for (int idx = 0; idx < types.length; idx++) {
            int type = types[idx];
            double[] x;
            Fn f;
            switch (type) {
                case CurveFitter.STRAIGHT_LINE: x = xs(0, 10, 24); f = v -> 2 + 0.5 * v; break;
                case CurveFitter.POLY2: x = xs(-3, 5, 24); f = v -> 1 - 0.7 * v + 0.3 * v * v; break;
                case CurveFitter.POLY3: x = xs(-3, 5, 24); f = v -> 1 - 0.7 * v + 0.3 * v * v - 0.05 * v * v * v; break;
                case CurveFitter.POLY4: x = xs(-3, 5, 24); f = v -> 1 - 0.7 * v + 0.3 * v * v - 0.05 * v * v * v + 0.01 * Math.pow(v, 4); break;
                case CurveFitter.POLY5: x = xs(-3, 5, 28); f = v -> 1 - 0.7 * v + 0.3 * v * v - 0.05 * v * v * v + 0.01 * Math.pow(v, 4) - 0.002 * Math.pow(v, 5); break;
                case CurveFitter.POLY6: x = xs(-3, 5, 28); f = v -> 1 - 0.7 * v + 0.3 * v * v - 0.05 * v * v * v + 0.01 * Math.pow(v, 4) - 0.002 * Math.pow(v, 5) + 0.0003 * Math.pow(v, 6); break;
                case CurveFitter.POLY7: x = xs(-3, 5, 32); f = v -> 1 - 0.7 * v + 0.3 * v * v - 0.05 * v * v * v + 0.01 * Math.pow(v, 4) - 0.002 * Math.pow(v, 5) + 0.0003 * Math.pow(v, 6) - 0.00004 * Math.pow(v, 7); break;
                case CurveFitter.POLY8: x = xs(-3, 5, 32); f = v -> 1 - 0.7 * v + 0.3 * v * v - 0.05 * v * v * v + 0.01 * Math.pow(v, 4) - 0.002 * Math.pow(v, 5) + 0.0003 * Math.pow(v, 6) - 0.00004 * Math.pow(v, 7) + 0.000005 * Math.pow(v, 8); break;
                case CurveFitter.POWER: case CurveFitter.POWER_REGRESSION: x = xs(1, 20, 24); f = v -> 3 * Math.pow(v, 0.7); break;
                case CurveFitter.EXPONENTIAL: case CurveFitter.EXP_REGRESSION: x = xs(0, 10, 24); f = v -> 2 * Math.exp(0.3 * v); break;
                case CurveFitter.EXP_WITH_OFFSET: x = xs(0, 10, 24); f = v -> 5 * Math.exp(-0.6 * v) + 1.5; break;
                case CurveFitter.EXP_RECOVERY: x = xs(0, 10, 24); f = v -> 4 * (1 - Math.exp(-0.5 * v)) + 1; break;
                case CurveFitter.EXP_RECOVERY_NOOFFSET: x = xs(0, 10, 24); f = v -> 4 * (1 - Math.exp(-0.5 * v)); break;
                case CurveFitter.LOG: x = xs(1, 20, 24); f = v -> 2 * Math.log(1.5 * v); break;
                case CurveFitter.LOG2: x = xs(1, 20, 24); f = v -> 1 + 2 * Math.log(v + 0.5); break;
                case CurveFitter.GAUSSIAN: x = xs(0, 20, 30); f = v -> 1 + 9 * Math.exp(-(v - 10) * (v - 10) / (2 * 2.5 * 2.5)); break;
                case CurveFitter.GAUSSIAN_NOOFFSET: x = xs(0, 20, 30); f = v -> 9 * Math.exp(-(v - 10) * (v - 10) / (2 * 2.5 * 2.5)); break;
                case CurveFitter.ERF: x = xs(0, 20, 30); f = v -> 4 + 3 * erf((v - 10) / 3.0); break;
                case CurveFitter.RODBARD: x = xs(1, 30, 30); f = v -> 100 + (1 - 100) / (1 + Math.pow(v / 8, 2.2)); break;
                case CurveFitter.RODBARD2: x = xs(1, 30, 30); f = v -> 100 + (1 - 100) / (1 + Math.pow(v / 8, 2.2)); break;
                case CurveFitter.INV_RODBARD: x = xs(1, 9, 24); f = v -> 4 * Math.pow((v - 0.2) / (10 - v), 1 / 1.8); break;
                case CurveFitter.GAMMA_VARIATE: x = xs(1.5, 30, 30); f = v -> 2 * Math.pow(v - 1, 2) * Math.exp(-(v - 1) / 3.0); break;
                case CurveFitter.CHAPMAN: x = xs(0.5, 12, 26); f = v -> 8 * Math.pow(1 - Math.exp(-0.4 * v), 2.5); break;
                default: continue;
            }
            Random r = new Random(1000 + type);
            double[] y = new double[x.length];
            double span = 0;
            for (int i = 0; i < y.length; i++) y[i] = f.f(x[i]);
            double mn = Double.MAX_VALUE, mx = -Double.MAX_VALUE;
            for (double v : y) { mn = Math.min(mn, v); mx = Math.max(mx, v); }
            span = mx - mn;
            for (int i = 0; i < y.length; i++) y[i] += 0.01 * span * r.nextGaussian();
            if (type == CurveFitter.POWER_REGRESSION || type == CurveFitter.EXP_REGRESSION) for (int i = 0; i < y.length; i++) y[i] = Math.abs(y[i]) + 1e-3;   // regression fits need y > 0
            Object res;
            try {
                CurveFitter cf = new CurveFitter(x.clone(), y.clone());
                cf.getMinimizer().setRandomSeed(1);
                cf.getMinimizer().setMaximumThreads(1);
                cf.doFit(type);
                res = J.o("params", cf.getParams(), "numParams", cf.getNumParams(), "rSquared", cf.getRSquared(), "sumResidualsSqr", cf.getSumResidualsSqr(), "sd", cf.getSD(),
                    "fitGoodness", cf.getFitGoodness(), "status", cf.getStatus(), "statusString", cf.getStatusString(), "iterations", cf.getIterations(), "restarts", cf.getRestarts(),
                    "residuals", cf.getResiduals(), "formula", cf.getFormula(), "name", cf.getName());
            } catch (Throwable t) { res = J.o("error", String.valueOf(t)); }
            cases.add(J.o("fitType", type, "fitName", CurveFitter.fitList[type], "equation", CurveFitter.fList[type], "x", x, "y", y, "result", res));
        }
        new Fx("fiji", "curve_fit", "curveFit")
            .call("new CurveFitter(x, y); getMinimizer().setRandomSeed(1); getMinimizer().setMaximumThreads(1); doFit(type) for every entry of CurveFitter.sortedTypes (list order = this file's case order); data = the function with known parameters + seeded gaussian noise of 1% of the range; params[] ends with the sum of squared residuals as ImageJ returns it")
            .put("sortedTypes", types).put("fitList", CurveFitter.fitList).put("fList", CurveFitter.fList).put("cases", cases).write();
    }

    /** Error function (Abramowitz-Stegun 7.1.26 is NOT used: data only needs a smooth erf, the fit itself uses ImageJ's own). */
    static double erf(double z) {
        double t = 1.0 / (1.0 + 0.5 * Math.abs(z));
        double ans = 1 - t * Math.exp(-z * z - 1.26551223 + t * (1.00002368 + t * (0.37409196 + t * (0.09678418 + t * (-0.18628806 + t * (0.27886807 + t * (-1.13520398 + t * (1.48851587 + t * (-0.82215223 + t * 0.17087277)))))))));
        return z >= 0 ? ans : -ans;
    }
}
