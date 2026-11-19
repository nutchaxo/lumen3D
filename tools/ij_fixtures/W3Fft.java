import ij.*;
import ij.gui.*;
import ij.plugin.FFT;
import ij.plugin.filter.FFTFilter;
import ij.process.*;
import java.lang.reflect.Method;
import java.util.*;

/** fft: FHT forward (pad, power spectrum, raw PS), inverse with pass / filter masks, Bandpass, Swap Quadrants. */
final class W3Fft {
    static void run() throws Exception {
        forward();
        inverse();
        swap();
        bandpass();
        bandpassFilterArrays();
    }

    static ImageProcessor img(int bits, int w, int h, long seed) {
        ImageProcessor ip = Gen.tex(bits, w, h, seed);
        return ip;
    }

    static Object fhtImage(FHT f) {
        return J.image(f);   // FHT extends FloatProcessor
    }

    static void forward() throws Exception {
        int[][] sizes = {{16, 16}, {20, 12}, {30, 30}};
        for (int bits : new int[]{8, 16, 32}) {
            List<Object> cases = new ArrayList<>();
            for (int[] sz : sizes) {
                ImageProcessor ip = img(bits, sz[0], sz[1], 31 + sz[0]);
                ImagePlus imp = Gen.imp("src", ip.duplicate());
                ImagePlus ps = FFT.forward(imp);
                FHT fht = (FHT) ps.getProperty("FHT");
                FloatProcessor raw = fht.getRawPowerSpectrum();
                FloatProcessor rawSwapped = (FloatProcessor) raw.duplicate();
                new FHT().swapQuadrants(rawSwapped);
                cases.add(J.o("size", new int[]{sz[0], sz[1]}, "padded", fht.getWidth(),
                    "originalWidth", fht.originalWidth, "originalHeight", fht.originalHeight, "originalBitDepth", fht.originalBitDepth,
                    "input", J.image(ip), "fht", fhtImage(fht), "powerSpectrum8", J.image(ps.getProcessor()),
                    "rawPowerSpectrum", J.image(raw), "rawPowerSpectrumSwapped", J.image(rawSwapped),
                    "powerSpectrumMean", fht.powerSpectrumMean));
            }
            new Fx("fft", "forward_" + Gen.bits(bits), "fft")
                .call("FFT.forward(imp) [pad() to the next power of 2 filled with the mean, newFHT, fht.transform(), getPowerSpectrum()]; raw PS = fht.getRawPowerSpectrum() (unswapped; Swapped = FHT.swapQuadrants)")
                .put("cases", cases).write();
        }
        // selection: FFT of a selection crops to its bounding box first (FFT.run: ip = ip.crop())
        ImageProcessor ip = img(8, 40, 30, 8);
        ImagePlus imp = Gen.imp("src", ip.duplicate());
        imp.setRoi(new Roi(5, 4, 20, 14));
        ImagePlus ps = FFT.forward(imp);
        FHT fht = (FHT) ps.getProperty("FHT");
        new Fx("fft", "forward_roi_crop", "fft")
            .call("imp.setRoi(rect 5,4,20,14); FFT.forward(imp): ip.crop() then pad")
            .input(ip).put("roi", J.roi(new Roi(5, 4, 20, 14))).put("padded", fht.getWidth())
            .put("originalWidth", fht.originalWidth).put("originalHeight", fht.originalHeight)
            .put("fht", fhtImage(fht)).put("powerSpectrum8", J.image(ps.getProcessor())).write();
    }

    /** Inverse: no mask, pass mask (255 disc), filter mask (0 disc); result 32-bit as FFT.inverse and converted to the source depth. */
    static void inverse() throws Exception {
        int[][] sizes = {{32, 32}, {20, 12}};
        for (int bits : new int[]{8, 16, 32}) {
            List<Object> cases = new ArrayList<>();
            for (int[] sz : sizes) for (int mode = 0; mode < 3; mode++) {
                ImageProcessor ip = img(bits, sz[0], sz[1], 52 + sz[0]);
                ImagePlus ps = FFT.forward(Gen.imp("src", ip.duplicate()));
                FHT fht = (FHT) ps.getProperty("FHT");
                int n = fht.getWidth();
                ByteProcessor p = (ByteProcessor) ps.getProcessor();
                if (mode == 1) {                 // pass: everything 0 except a disc of 255 around the centre
                    for (int i = 0; i < n * n; i++) p.set(i, 0);
                    for (int y = 0; y < n; y++) for (int x = 0; x < n; x++) if ((x - n / 2) * (x - n / 2) + (y - n / 2) * (y - n / 2) <= (n / 5) * (n / 5)) p.set(x, y, 255);
                } else if (mode == 2) {          // filter: a band of 0 pixels off-centre (symmetrised by changeValuesAndSymmetrize)
                    for (int y = n / 2 + 2; y < n / 2 + 5; y++) for (int x = n / 2 + 1; x < n / 2 + 8 && x < n; x++) p.set(x, y, 0);
                }
                ByteProcessor maskCopy = (ByteProcessor) p.duplicate();
                ImagePlus inv = FFT.inverse(ps);
                ImageProcessor out32 = inv.getProcessor();
                ImageProcessor outTyped = bits == 8 ? out32.convertToByte(false) : bits == 16 ? out32.convertToShort(false) : out32;
                cases.add(J.o("size", new int[]{sz[0], sz[1]}, "mask", mode == 0 ? "none" : mode == 1 ? "pass" : "filter",
                    "input", J.image(ip), "psEdited", J.image(maskCopy), "output32", J.image(out32), "outputSourceDepth", J.image(outTyped)));
            }
            new Fx("fft", "inverse_" + Gen.bits(bits), "inverseFft")
                .call("FFT.inverse(psImp): doMasking (any 255 -> pass mode, else any 0 -> filter mode; changeValuesAndSymmetrize, 3x smooth, swapQuadrants, fht*mask/255), inverseTransform, crop; showOutput=false returns 32-bit; the GUI converts with convertToByte(false)/convertToShort(false) to the source depth")
                .put("cases", cases).write();
        }
    }

    static void swap() {
        List<Object> cases = new ArrayList<>();
        for (int bits : new int[]{8, 16, 32}) for (int n : new int[]{8, 16}) {
            ImageProcessor ip = img(bits, n, n, 70 + n);
            ImageProcessor o = ip.duplicate();
            new FHT().swapQuadrants(o);
            cases.add(J.o("bitDepth", bits, "size", n, "input", J.image(ip), "output", J.image(o)));
        }
        new Fx("fft", "swap_quadrants", "swapQuadrants").call("new FHT().swapQuadrants(ip) (square images only)").put("cases", cases).write();
    }

    static final String[] STRIPES = {"None", "Horizontal", "Vertical"};

    static void bandpass() throws Exception {
        Method f = FFTFilter.class.getDeclaredMethod("filter", ImageProcessor.class);
        f.setAccessible(true);
        int[][] sizes = {{37, 29}, {32, 32}};
        for (int bits : new int[]{8, 16, 32}) {
            List<Object> cases = new ArrayList<>();
            double[][] opts = {   // large, small, stripes, tolerance, autoscale, saturate
                {40, 3, 0, 5, 1, 1}, {40, 3, 0, 5, 0, 0}, {10, 2, 1, 5, 1, 1}, {10, 2, 2, 25, 1, 0}, {0, 5, 0, 5, 1, 1}, {30, 0, 0, 5, 1, 1}
            };
            for (int[] sz : sizes) for (double[] o : opts) {
                ImageProcessor ip = img(bits, sz[0], sz[1], 90 + sz[0] + bits);
                ImageProcessor out = ip.duplicate();
                FFTFilter p = new FFTFilter();
                Gen.set(p, "imp", Gen.imp("src", out));
                Gen.set(p, "filterLargeDia", o[0]); Gen.set(p, "filterSmallDia", o[1]);
                Gen.set(p, "choiceIndex", (int) o[2]); Gen.set(p, "toleranceDia", o[3]);
                Gen.set(p, "doScalingDia", o[4] == 1); Gen.set(p, "saturateDia", o[5] == 1);
                Gen.set(p, "displayFilter", false);
                f.invoke(p, out);
                cases.add(J.o("params", J.o("large", o[0], "small", o[1], "stripes", STRIPES[(int) o[2]], "tolerance", o[3], "autoscale", o[4] == 1, "saturate", o[5] == 1),
                    "size", new int[]{sz[0], sz[1]}, "input", J.image(ip), "output", J.image(out)));
            }
            // a selection: the roi rectangle only is filtered (roiRect = ip.getRoi())
            ImageProcessor ip = img(bits, 40, 32, 7);
            ImageProcessor out = ip.duplicate();
            out.setRoi(new java.awt.Rectangle(6, 5, 22, 17));
            FFTFilter p = new FFTFilter();
            Gen.set(p, "imp", Gen.imp("src", out));
            Gen.set(p, "filterLargeDia", 40.0); Gen.set(p, "filterSmallDia", 3.0); Gen.set(p, "choiceIndex", 0); Gen.set(p, "toleranceDia", 5.0);
            Gen.set(p, "doScalingDia", true); Gen.set(p, "saturateDia", true);
            f.invoke(p, out);
            out.resetRoi();
            cases.add(J.o("params", J.o("large", 40.0, "small", 3.0, "stripes", "None", "tolerance", 5.0, "autoscale", true, "saturate", true),
                "roi", J.o("type", "rect", "x", 6, "y", 5, "w", 22, "h", 17), "size", new int[]{40, 32}, "input", J.image(ip), "output", J.image(out)));
            new Fx("fft", "bandpass_" + Gen.bits(bits), "bandpass")
                .call("FFTFilter.filter(ip) by reflection with the dialog's static fields set: pad to the smallest power of 2 >= 1.5*max side with tileMirror, filterLargeSmall, inverse, crop, ContrastEnhancer.stretchHistogram(saturate?1:0), convertToByte/Short(doScaling)")
                .put("cases", cases).write();
        }
    }

    /** The filter itself: filterLargeSmall applied to an all-ones FHT array = the multiplier per (row, col). */
    static void bandpassFilterArrays() throws Exception {
        Method m = FFTFilter.class.getDeclaredMethod("filterLargeSmall", ImageProcessor.class, double.class, double.class, int.class, double.class);
        m.setAccessible(true);
        List<Object> cases = new ArrayList<>();
        for (int n : new int[]{32, 64}) {
            double[][] opts = {{40, 3, 0, 0.95}, {10, 2, 1, 0.95}, {10, 2, 2, 0.75}, {0, 5, 0, 0.95}};
            for (double[] o : opts) {
                float[] ones = new float[n * n];
                Arrays.fill(ones, 1f);
                FHT fht = new FHT(new FloatProcessor(n, n, ones, null));
                m.invoke(new FFTFilter(), fht, 2.0 * o[0] / n, 2.0 * o[1] / n, (int) o[2], o[3]);
                cases.add(J.o("n", n, "params", J.o("large", o[0], "small", o[1], "stripes", STRIPES[(int) o[2]], "sharpness", o[3]), "filter", J.image(fht)));
            }
        }
        new Fx("fft", "bandpass_filter_arrays", "bandpass")
            .call("FFTFilter.filterLargeSmall(ip, 2*large/n, 2*small/n, stripes, sharpness) applied to an all-ones n x n float array (no transform): the result IS the frequency-domain multiplier")
            .put("cases", cases).write();
    }
}
