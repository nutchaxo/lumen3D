import ij.*;
import ij.plugin.*;
import ij.process.*;
import java.util.*;

/** P4: Image Calculator (Blitters), Split / Merge channels. */
final class P4 {
    static final int[] BD = {8, 16, 32};
    static final String[] TN = {"u8", "u16", "f32"};
    static final String[] OPS = {"add", "subtract", "multiply", "divide", "and", "or", "xor", "min", "max", "average", "difference", "copy", "transparent-zero"};

    static void run() throws Exception {
        calculator();
        splitMerge();
    }

    /** Pair of images with extremes: dst has 0 / max, src has zeros (divide traps), ties, negatives for 32-bit. */
    static ImageProcessor[] pair(int bits, int w, int h) {
        ImageProcessor a = Gen.noise(bits, w, h, 600 + bits), b = Gen.noise(bits, w, h, 700 + bits);
        int n = w * h;
        for (int i = 0; i < n; i += 5) b.setf(i % w, i / w, 0f);                 // zeros in the source
        for (int i = 2; i < n; i += 13) a.setf(i % w, i / w, 0f);                // zeros in the destination (0/0 where both)
        for (int i = 0; i < n; i += 10) a.setf(i % w, i / w, 0f);
        float mx = bits == 8 ? 255 : bits == 16 ? 65535 : 1000f;
        for (int i = 3; i < n; i += 17) a.setf(i % w, i / w, mx);
        for (int i = 4; i < n; i += 19) b.setf(i % w, i / w, mx);
        for (int i = 6; i < n; i += 23) b.setf(i % w, i / w, a.getf(i % w, i / w));   // equal pixels
        if (bits == 32) { a.setf(1, 1, -250f); b.setf(2, 1, -3f); a.setf(3, 1, 0.001f); b.setf(3, 1, 1e-30f); }
        return new ImageProcessor[]{a, b};
    }

    static Object fieldValue(String cls, String field) {
        try { java.lang.reflect.Field f = Class.forName(cls).getDeclaredField(field); f.setAccessible(true); return f.get(null); }
        catch (Throwable t) { return null; }
    }

    static void calc(String name, String op, ImageProcessor a, ImageProcessor b, boolean float32) {
        ImageCalculator ic = new ImageCalculator();
        String opts = op + " create" + (float32 ? " 32-bit" : "");
        Fx f = new Fx("multi", name, "imageCalculator")
            .call("new ImageCalculator().run(\"" + opts + "\", imp1, imp2) -> doOperation: createNewImage(ip1, ip2) [+ convertToFloat when 32-bit]; ip1.copyBits(ip2 [float], 0, 0, Blitter mode); resetMinAndMax unless 8-bit")
            .params("op", op, "create", true, "float32", float32)
            .put("input", J.image(a)).put("input2", J.image(b));
        try {
            ImagePlus r = ic.run(opts, new ImagePlus("a", a.duplicate()), new ImagePlus("b", b.duplicate()));
            f.output(r.getProcessor());
        } catch (Throwable t) {
            f.result(J.o("error", t.getClass().getSimpleName() + ": " + t.getMessage()));
        }
        f.put("divideByZeroValueFloat", fieldValue("ij.process.FloatBlitter", "divideByZeroValue"));
        f.write();
    }

    static void calculator() throws Exception {
        for (int t = 0; t < 3; t++) {
            ImageProcessor[] p = pair(BD[t], 16, 12);
            for (String op : OPS) {
                calc("calc_" + op.replace("-", "") + "_" + TN[t], op, p[0], p[1], false);
                if (t < 2 && (op.equals("add") || op.equals("subtract") || op.equals("multiply") || op.equals("divide") || op.equals("average") || op.equals("difference")))
                    calc("calc_" + op + "_f32result_" + TN[t], op, p[0], p[1], true);
            }
        }
        // mixed bit depths (ImageJ converts the source to the destination type)
        ImageProcessor[] p8 = pair(8, 16, 12), p16 = pair(16, 16, 12);
        for (String op : new String[]{"add", "subtract", "divide", "max"}) {
            calc("calc_" + op + "_u16_by_u8", op, p16[0], p8[1], false);
            calc("calc_" + op + "_u8_by_u16", op, p8[0], p16[1], false);
        }
        // different sizes: ImageJ keeps the smaller rectangle (Image Calculator in our port refuses: IJ_SIZE_MISMATCH)
        calc("calc_add_u8_sizes_16x12_and_10x8", "add", pair(8, 16, 12)[0], pair(8, 10, 8)[1], false);
    }

    static ImagePlus hyper(String title, int bits, int w, int h, int channels) {
        ImageStack st = new ImageStack(w, h);
        for (int c = 0; c < channels; c++) st.addSlice("c" + (c + 1), Gen.tex(bits, w, h, 800 + c));
        ImagePlus imp = new ImagePlus(title, st);
        imp.setDimensions(channels, 1, 1);
        imp.setOpenAsHyperStack(true);
        return imp;
    }

    static void splitMerge() throws Exception {
        for (int bits : new int[]{8, 16}) for (int ch : new int[]{2, 3, 4}) {
            ImagePlus imp = hyper("emb 1.tif", bits, 12, 9, ch);
            ImagePlus[] parts = ChannelSplitter.split(imp);
            List<Object> names = new ArrayList<>();
            List<Object> imgs = new ArrayList<>();
            for (ImagePlus q : parts) { names.add(q.getTitle()); imgs.add(J.image(q.getProcessor())); }
            Map<String, Object> inCh = new LinkedHashMap<>();
            List<Object> chans = new ArrayList<>();
            for (int c = 1; c <= ch; c++) chans.add(J.image(imp.getStack().getProcessor(c)));
            new Fx("multi", "split_" + ch + "ch_u" + bits, "splitChannels")
                .call("ChannelSplitter.split(imp): titles \"C\"+c+\"-\"+imp.getTitle()")
                .params("title", "emb 1.tif", "channels", ch)
                .put("input", J.o("width", 12, "height", 9, "bitDepth", bits, "channels", chans))
                .result(J.o("names", names, "channels", imgs)).write();
            // merge those back (keepSourceImages=false)
            ImagePlus[] again = ChannelSplitter.split(hyper("emb 1.tif", bits, 12, 9, ch));
            ImagePlus merged = RGBStackMerge.mergeChannels(again, false);
            List<Object> luts = new ArrayList<>();
            if (merged instanceof CompositeImage) {
                CompositeImage ci = (CompositeImage) merged;
                for (int c = 1; c <= ch; c++) {
                    LUT l = ci.getChannelLut(c);
                    luts.add(new int[]{l.getRed(255), l.getGreen(255), l.getBlue(255)});
                }
            }
            List<Object> mch = new ArrayList<>();
            for (int c = 1; c <= merged.getStackSize(); c++) mch.add(J.image(merged.getStack().getProcessor(c)));
            new Fx("multi", "merge_" + ch + "ch_u" + bits, "mergeChannels")
                .call("RGBStackMerge.mergeChannels(images, false) -> CompositeImage; colours = getChannelLut(c).get{Red,Green,Blue}(255); title " + J.q(merged.getTitle()))
                .params("channels", ch)
                .put("input", J.o("width", 12, "height", 9, "bitDepth", bits, "channels", chans))
                .result(J.o("title", merged.getTitle(), "nChannels", merged.getNChannels(), "bitDepth", merged.getBitDepth(), "lutMaxRGB", luts, "channels", mch)).write();
        }
    }
}
