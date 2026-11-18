import ij.*;
import ij.gui.*;
import ij.process.*;
import java.lang.reflect.Field;
import java.util.*;

/** Seeded synthetic images and the PlugInFilterRunner stand-in. */
final class Gen {
    interface Op { void run(ImageProcessor ip) throws Exception; }

    // ---------------------------------------------------------------- images
    /** Float image in ~[0,1]: gaussian blobs on a sloped background plus seeded gaussian noise. */
    static float[] blobs(int w, int h, long seed, int n, double sMin, double sMax, double slopeX, double slopeY, double base, double noise) {
        Random r = new Random(seed);
        double[] cx = new double[n], cy = new double[n], sg = new double[n], am = new double[n];
        for (int i = 0; i < n; i++) {
            cx[i] = r.nextDouble() * w; cy[i] = r.nextDouble() * h;
            sg[i] = sMin + r.nextDouble() * (sMax - sMin); am[i] = 0.3 + 0.5 * r.nextDouble();
        }
        float[] v = new float[w * h];
        for (int y = 0; y < h; y++)
            for (int x = 0; x < w; x++) {
                double s = base + slopeX * x / w + slopeY * y / h;
                for (int i = 0; i < n; i++) {
                    double dx = x - cx[i], dy = y - cy[i];
                    s += am[i] * Math.exp(-(dx * dx + dy * dy) / (2 * sg[i] * sg[i]));
                }
                s += noise * r.nextGaussian();
                v[y * w + x] = (float) Math.max(0, Math.min(1, s));
            }
        return v;
    }

    static float[] invert01(float[] v) { float[] o = new float[v.length]; for (int i = 0; i < v.length; i++) o[i] = 1f - v[i]; return o; }

    /** Converts [0,1] values to a processor: 8-bit 0..255, 16-bit 0..60000, float -100..400. */
    static ImageProcessor make(int bits, float[] v, int w, int h) {
        if (bits == 8) {
            byte[] p = new byte[w * h];
            for (int i = 0; i < p.length; i++) p[i] = (byte) Math.round(v[i] * 255f);
            return new ByteProcessor(w, h, p, null);
        } else if (bits == 16) {
            short[] p = new short[w * h];
            for (int i = 0; i < p.length; i++) p[i] = (short) Math.round(v[i] * 60000f);
            return new ShortProcessor(w, h, p, null);
        } else {
            float[] p = new float[w * h];
            for (int i = 0; i < p.length; i++) p[i] = v[i] * 500f - 100f;
            return new FloatProcessor(w, h, p, null);
        }
    }

    /** Integer-quantised levels 0..255 (ties, plateaus) scaled to the type: 8-bit u, 16-bit u*200, float u*0.01+1. */
    static ImageProcessor levels(int bits, int[] u, int w, int h) {
        if (bits == 8) { byte[] p = new byte[w * h]; for (int i = 0; i < p.length; i++) p[i] = (byte) u[i]; return new ByteProcessor(w, h, p, null); }
        if (bits == 16) { short[] p = new short[w * h]; for (int i = 0; i < p.length; i++) p[i] = (short) (u[i] * 200); return new ShortProcessor(w, h, p, null); }
        float[] p = new float[w * h]; for (int i = 0; i < p.length; i++) p[i] = u[i] * 0.01f + 1f; return new FloatProcessor(w, h, p, null);
    }

    /** Full-range seeded noise (edge/rounding rules of the 3x3 filters). */
    static ImageProcessor noise(int bits, int w, int h, long seed) {
        Random r = new Random(seed);
        if (bits == 8) { byte[] p = new byte[w * h]; for (int i = 0; i < p.length; i++) p[i] = (byte) r.nextInt(256); return new ByteProcessor(w, h, p, null); }
        if (bits == 16) { short[] p = new short[w * h]; for (int i = 0; i < p.length; i++) p[i] = (short) r.nextInt(65536); return new ShortProcessor(w, h, p, null); }
        float[] p = new float[w * h]; for (int i = 0; i < p.length; i++) p[i] = (float) (r.nextGaussian() * 100.0 + 50.0); return new FloatProcessor(w, h, p, null);
    }

    /** Blobs scaled to a type, then returned as a processor (default texture of most fixtures). */
    static ImageProcessor tex(int bits, int w, int h, long seed) {
        return make(bits, blobs(w, h, seed, 5, 2.5, 6, 0.15, 0.1, 0.12, 0.03), w, h);
    }

    static ImageProcessor withNaNs(int w, int h, long seed) {
        ImageProcessor ip = tex(32, w, h, seed);
        float[] p = (float[]) ip.getPixels();
        Random r = new Random(seed + 77);
        for (int k = 0; k < 9; k++) p[r.nextInt(p.length)] = Float.NaN;
        for (int y = 5; y < 8; y++) for (int x = 6; x < 9; x++) p[y * w + x] = Float.NaN; // 3x3 block of NaNs
        p[0] = Float.NaN; p[p.length - 1] = Float.NaN;
        return ip;
    }

    // ---------------------------------------------------------------- binary images (255 = object, black background)
    static ByteProcessor binary(int w, int h) { return new ByteProcessor(w, h); }

    static void disk(ByteProcessor ip, double cx, double cy, double r, int value) {
        int w = ip.getWidth(), h = ip.getHeight();
        for (int y = 0; y < h; y++) for (int x = 0; x < w; x++) {
            double dx = x - cx, dy = y - cy;
            if (dx * dx + dy * dy <= r * r) ip.set(x, y, value);
        }
    }

    static void line(ByteProcessor ip, int x0, int y0, int x1, int y1, int thick) {
        int n = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0));
        for (int i = 0; i <= n; i++) {
            int x = x0 + Math.round((float) (x1 - x0) * i / Math.max(n, 1));
            int y = y0 + Math.round((float) (y1 - y0) * i / Math.max(n, 1));
            for (int dy = 0; dy < thick; dy++) for (int dx = 0; dx < thick; dx++)
                if (x + dx < ip.getWidth() && y + dy < ip.getHeight()) ip.set(x + dx, y + dy, 255);
        }
    }

    /** Two overlapping disks, a separate disk touching the left border, a hole, a one-pixel speck. */
    static ByteProcessor touchingDisks(int w, int h) {
        ByteProcessor ip = binary(w, h);
        disk(ip, 15, 15, 8.5, 255); disk(ip, 26, 17, 7.5, 255);   // touching, neck between them
        disk(ip, 3, 32, 6.5, 255);                                   // touches the left edge
        disk(ip, w - 8, h - 8, 5.5, 255);
        disk(ip, 15, 15, 2.2, 0);                                    // hole
        ip.set(40, 5, 255);                                          // speck
        return ip;
    }

    static ByteProcessor thinLines(int w, int h) {
        ByteProcessor ip = binary(w, h);
        line(ip, 3, 3, w - 5, h - 8, 1);
        line(ip, 4, h - 6, w - 4, 6, 2);
        line(ip, 10, 4, 10, h - 4, 3);
        disk(ip, w * 0.7, h * 0.7, 8, 255); disk(ip, w * 0.7, h * 0.7, 4, 0);   // ring
        for (int y = 3; y < 13; y++) for (int x = w - 14; x < w - 4; x++) ip.set(x, y, 255); // thick block
        return ip;
    }

    // ---------------------------------------------------------------- misc
    /** Normal ImagePlus around a processor (no window). */
    static ImagePlus imp(String title, ImageProcessor ip) { return new ImagePlus(title, ip); }

    static ImageProcessor copy(ImageProcessor ip) { return ip.duplicate(); }

    /** Mimics PlugInFilterRunner.processOneImage for one slice. */
    static void runFilter(ImageProcessor ip, Roi roi, boolean convertToFloat, boolean snapshotFlag, boolean supportsMasking, Op op) throws Exception {
        if (roi != null && roi.isArea()) ip.setRoi(roi); else ip.setRoi((Roi) null);
        boolean cvt = convertToFloat && !(ip instanceof FloatProcessor);
        boolean doMasking = supportsMasking && ip.getMask() != null;
        Object snap = null;
        if (doMasking || (snapshotFlag && !cvt)) { ip.snapshot(); snap = ip.getSnapshotPixels(); }
        if (cvt) {
            FloatProcessor fp = ip.toFloat(0, null);
            if (snapshotFlag) fp.snapshot();
            op.run(fp);
            ip.setPixels(0, fp);
        } else op.run(ip);
        if (doMasking) {
            if (snap != null) ip.setSnapshotPixels(snap);
            ip.reset(ip.getMask());
        }
        ip.resetRoi();
    }

    static Object get(Object o, String field) throws Exception { Field f = o.getClass().getDeclaredField(field); f.setAccessible(true); return f.get(o); }
    static void set(Object o, String field, Object v) throws Exception { Field f = o.getClass().getDeclaredField(field); f.setAccessible(true); f.set(o, v); }

    static String bits(int b) { return b == 8 ? "u8" : b == 16 ? "u16" : "f32"; }
}
