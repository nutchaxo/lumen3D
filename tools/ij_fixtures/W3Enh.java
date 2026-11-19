import ij.*;
import ij.gui.*;
import ij.plugin.filter.*;
import ij.process.*;
import java.util.*;

/** enh: noise (seeded, per type, ROI, multichannel stream), Salt and Pepper (reflection-seeded Random). */
final class W3Enh {
    static void run() throws Exception {
        noise();
        stream();
        saltPepper();
    }

    static ImageProcessor base(int bits, int w, int h) {
        // mid-range values with some extremes so the 8-bit redraw rule and 16-bit clipping both fire
        ImageProcessor ip = Gen.tex(bits, w, h, 21 + bits);
        if (bits == 8) { for (int i = 0; i < 12; i++) ip.set(i, 0); for (int i = 12; i < 24; i++) ip.set(i, 255); }
        if (bits == 16) { for (int i = 0; i < 12; i++) ip.set(i, 0); for (int i = 12; i < 24; i++) ip.set(i, 65535); }
        return ip;
    }

    static void noise() throws Exception {
        int[] bd = {8, 16, 32};
        for (int bits : bd) {
            ImageProcessor in = base(bits, 24, 18);
            List<Object> cases = new ArrayList<>();
            for (long seed : new long[]{0, 1, 42}) for (double sd : new double[]{25.0, 5.5}) {
                ImageProcessor ip = in.duplicate();
                ImageProcessor.setRandomSeed(seed);
                ip.noise(sd);
                cases.add(J.o("params", J.o("seed", seed, "sd", sd), "output", J.image(ip)));
            }
            // selection cases (Filters has SUPPORTS_MASKING: pixels outside the mask are restored)
            for (int k = 0; k < 2; k++) {
                final ImageProcessor ip = in.duplicate();
                Roi roi = k == 0 ? new Roi(4, 3, 12, 9) : new OvalRoi(3, 2, 14, 12);
                ImageProcessor.setRandomSeed(7);
                Gen.runFilter(ip, roi, false, true, true, p -> p.noise(25.0));
                cases.add(J.o("params", J.o("seed", 7L, "sd", 25.0), "roi", J.roi(roi), "output", J.image(ip)));
            }
            new Fx("enh", "noise_" + Gen.bits(bits), "addNoise")
                .call("ImageProcessor.setRandomSeed(seed); ip.noise(sd) [Filters add = noise(25.0), 'Add Specified Noise' = noise(sd); roi cases through the SUPPORTS_MASKING path]")
                .input(in).put("cases", cases).write();
        }
    }

    /** One seeded stream across channels in index order (ImageJ's rnd is static: seeded once, then it continues). */
    static void stream() {
        for (int bits : new int[]{8, 16}) {
            ImageProcessor[] chs = {base(bits, 16, 12), Gen.tex(bits, 16, 12, 5), Gen.tex(bits, 16, 12, 6)};
            List<Object> ins = new ArrayList<>(), outs = new ArrayList<>();
            ImageProcessor.setRandomSeed(42);
            for (ImageProcessor c : chs) { ins.add(J.image(c)); ImageProcessor d = c.duplicate(); d.noise(25.0); outs.add(J.image(d)); }
            new Fx("enh", "noise_stream_" + Gen.bits(bits), "addNoise")
                .call("setRandomSeed(42) once, then noise(25.0) on channel 0, 1, 2 in this order")
                .params("seed", 42L, "sd", 25.0).put("inputs", ins).put("outputs", outs).write();
        }
    }

    static void saltPepper() throws Exception {
        ByteProcessor in = (ByteProcessor) Gen.tex(8, 40, 30, 3);
        List<Object> cases = new ArrayList<>();
        for (long seed : new long[]{0, 1, 42}) {
            ByteProcessor ip = (ByteProcessor) in.duplicate();
            SaltAndPepper sp = new SaltAndPepper();
            Gen.set(sp, "r", new Random(seed));
            sp.add(ip, 0.05);
            cases.add(J.o("params", J.o("seed", seed, "percent", 0.05), "output", J.image(ip)));
        }
        ByteProcessor ip = (ByteProcessor) in.duplicate();
        SaltAndPepper sp = new SaltAndPepper();
        Gen.set(sp, "r", new Random(9));
        ip.setRoi(new java.awt.Rectangle(5, 4, 20, 14));
        sp.add(ip, 0.05);
        ip.resetRoi();
        cases.add(J.o("params", J.o("seed", 9L, "percent", 0.05), "roi", J.o("type", "rect", "x", 5, "y", 4, "w", 20, "h", 14), "output", J.image(ip)));
        new Fx("enh", "salt_and_pepper", "saltAndPepper")
            .call("SaltAndPepper sp=new SaltAndPepper(); sp.r = new Random(seed) (reflection); sp.add(ip, 0.05)  [n=(int)(percent*w*h); n/2 x (white then black); rand(min,max)=min+r.nextInt(max-min)]")
            .input(in).put("cases", cases).write();
    }
}
