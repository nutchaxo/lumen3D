import ij.*;
import ij.plugin.ZProjector;
import ij.process.*;
import java.util.*;

/** lib: ZProjector every method on 8/16/32-bit stacks (float accumulation traps: 16-bit sums above 2^24, averages ending at x.5, NaN stacks). */
final class W3Lib {
    static final String[] M = {"avg", "max", "min", "sum", "sd", "median"};

    static void run() throws Exception {
        regular();
        sums16();
        halfAverages();
        nanStacks();
    }

    static ImageStack stack(int bits, int w, int h, int n, long seed) {
        ImageStack st = new ImageStack(w, h);
        for (int i = 0; i < n; i++) st.addSlice(Gen.noise(bits, w, h, seed + i));
        return st;
    }

    static Object stackJson(ImageStack st) {
        List<Object> l = new ArrayList<>();
        for (int i = 1; i <= st.getSize(); i++) l.add(J.image(st.getProcessor(i)));
        return l;
    }

    static Map<String, Object> project(ImageStack st, int method, int start, int stop) {
        ImagePlus imp = new ImagePlus("s", st);
        ZProjector zp = new ZProjector(imp);
        zp.setMethod(method);
        zp.setStartSlice(start);
        zp.setStopSlice(stop);
        zp.doProjection();
        ImagePlus p = zp.getProjection();
        return J.o("params", J.o("method", M[method], "start", start, "stop", stop), "bitDepth", p.getBitDepth(), "output", J.image(p.getProcessor()),
            "displayMin", p.getProcessor().getMin(), "displayMax", p.getProcessor().getMax());
    }

    /** Output type and values of each method on 8/16/32-bit random stacks, full and partial ranges. */
    static void regular() {
        for (int bits : new int[]{8, 16, 32}) {
            ImageStack st = stack(bits, 12, 9, 11, 40 + bits);
            List<Object> cases = new ArrayList<>();
            for (int m = 0; m < 6; m++) { cases.add(project(st, m, 1, 11)); cases.add(project(st, m, 3, 8)); cases.add(project(st, m, 5, 5)); }
            new Fx("lib", "zproject_" + Gen.bits(bits), "zProject")
                .call("new ZProjector(imp); setMethod; setStartSlice; setStopSlice; doProjection(); getProjection() on an 11-slice stack: AVG/SUM/SD -> 32-bit, MAX/MIN/MEDIAN keep the stack type (see bitDepth of each case)")
                .put("stack", stackJson(st)).put("cases", cases).write();
        }
    }

    /** 16-bit sums above 2^24 = 16 777 216: a float accumulator rounds them; ImageJ accumulates in a FloatProcessor. */
    static void sums16() {
        int n = 300, w = 4, h = 3;
        ImageStack st = new ImageStack(w, h);
        Random r = new Random(7);
        for (int i = 0; i < n; i++) {
            ImageProcessor ip = new ShortProcessor(w, h);
            for (int k = 0; k < w * h; k++) ip.set(k, 65000 + r.nextInt(535) - (k % 3 == 0 ? 20000 : 0));
            st.addSlice(ip);
        }
        List<Object> cases = new ArrayList<>();
        for (int m : new int[]{0, 3, 4}) cases.add(project(st, m, 1, n));
        cases.add(project(st, 3, 1, 250));
        new Fx("lib", "zproject_u16_sums_over_2p24", "zProject")
            .call("300 slices of 4x3 16-bit values near 65000: the SUM exceeds 2^24 (float32 integer limit), AVG and SD accumulate in float")
            .put("stack", stackJson(st)).put("cases", cases).write();
    }

    /** Averages of 2 or 4 slices that end in .5 or .25 (rounding of the float result when converted back). */
    static void halfAverages() {
        List<Object> all = new ArrayList<>();
        for (int bits : new int[]{8, 16}) {
            ImageStack st = new ImageStack(8, 2);
            for (int i = 0; i < 4; i++) {
                ImageProcessor ip = bits == 8 ? new ByteProcessor(8, 2) : new ShortProcessor(8, 2);
                for (int k = 0; k < 16; k++) ip.set(k, (k * 3 + i * (k % 3 + 1)) % (bits == 8 ? 256 : 4096) + (k % 2));
                st.addSlice(ip);
            }
            List<Object> cases = new ArrayList<>();
            for (int m : new int[]{0, 3, 4, 5}) { cases.add(project(st, m, 1, 4)); cases.add(project(st, m, 1, 2)); cases.add(project(st, m, 2, 4)); }
            all.add(J.o("bitDepth", bits, "stack", stackJson(st), "cases", cases));
        }
        new Fx("lib", "zproject_half_averages", "zProject")
            .call("2- and 4-slice stacks whose average ends in .5 / .25 / .75 and whose median is the mean of two values (float result, then the type of the output image)")
            .put("groups", all).write();
    }

    /** 32-bit stacks with NaN: Average ignores NaN (doAverageFloatProjection), Max/Min/Sum/SD/Median as ImageJ does. */
    static void nanStacks() {
        int n = 7;
        ImageStack st = stack(32, 10, 6, n, 90);
        Random r = new Random(5);
        for (int i = 1; i <= n; i++) {
            float[] p = (float[]) st.getProcessor(i).getPixels();
            for (int k = 0; k < 6; k++) p[r.nextInt(p.length)] = Float.NaN;
        }
        for (int i = 1; i <= n; i++) ((float[]) st.getProcessor(i).getPixels())[3] = Float.NaN;   // NaN in every slice at one pixel
        ((float[]) st.getProcessor(1).getPixels())[7] = Float.NaN;
        ((float[]) st.getProcessor(2).getPixels())[7] = Float.POSITIVE_INFINITY;
        List<Object> cases = new ArrayList<>();
        for (int m = 0; m < 6; m++) { cases.add(project(st, m, 1, n)); cases.add(project(st, m, 2, 5)); }
        new Fx("lib", "zproject_f32_nan", "zProject")
            .call("32-bit stack with NaN pixels (one pixel NaN in every slice) and an Infinity: AVG uses doAverageFloatProjection (sum/count ignoring NaN, 0/0 = NaN); the other methods run their RayFunction on the raw floats")
            .put("stack", stackJson(st)).put("cases", cases).write();
    }
}
