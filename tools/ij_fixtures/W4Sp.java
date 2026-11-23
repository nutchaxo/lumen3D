import ij.*;
import ij.gui.*;
import ij.measure.*;
import ij.process.*;
import java.awt.Frame;
import java.util.*;
import java.util.function.Supplier;

/**
 * stackproc: a filter run over all slices ("stack" macro key), Image Calculator on stacks, Analyze Particles on a binary stack, Histogram of all slices.
 */
final class W4Sp {
    static void run() {
        filters();
        calc();
        particles();
        histograms();
    }

    static void filters() {
        W4Stk.kase("stackproc", "gaussian_u16_all_slices", "stackFilter", f -> W4Stk.multi(f, () -> In.stack("s16", 16, 37, 23, 4, 3), "Gaussian Blur...", "sigma=1.5 stack", "sigma=1.5", "sigma=1.5 slice"));
        W4Stk.kase("stackproc", "gaussian_u8_all_slices", "stackFilter", f -> W4Stk.multi(f, () -> In.stack("s8", 8, 37, 23, 4, 3), "Gaussian Blur...", "sigma=2 stack"));
        W4Stk.kase("stackproc", "gaussian_f32_current_slice", "stackFilter", f -> W4Stk.multi(f, () -> { ImagePlus s = In.stack("s32", 32, 37, 23, 3, 3); s.setSlice(2); return s; }, "Gaussian Blur...", "sigma=1.5", "sigma=1.5 stack"));
        W4Stk.kase("stackproc", "median_u8_all_slices", "stackFilter", f -> W4Stk.multi(f, () -> In.stack("s8", 8, 37, 23, 3, 3), "Median...", "radius=2 stack"));
        W4Stk.kase("stackproc", "add_u8_all_slices", "stackFilter", f -> W4Stk.multi(f, () -> In.stack("s8", 8, 37, 23, 3, 3), "Add...", "value=25 stack", "value=25"));
        W4Stk.kase("stackproc", "invert_u16_all_slices", "stackFilter", f -> W4Stk.multi(f, () -> In.stack("s16", 16, 37, 23, 3, 3), "Invert", "stack", ""));
        W4Stk.kase("stackproc", "invert_u8_roi_all_slices", "stackFilter", f -> W4Stk.multi(f, () -> W4Ana.roi(In.stack("s8", 8, 37, 23, 3, 3), new OvalRoi(5, 3, 20, 12)), "Invert", "stack"));
        W4Stk.kase("stackproc", "subtract_background_all_slices", "stackFilter", f -> W4Stk.multi(f, () -> In.stack("s8", 8, 37, 23, 3, 3), "Subtract Background...", "rolling=10 stack"));
        W4Stk.kase("stackproc", "enhance_contrast_all_slices", "stackFilter", f -> W4Stk.multi(f, () -> In.stack("s8", 8, 37, 23, 3, 3), "Enhance Contrast...", "saturated=0.35 normalize process_all use", "saturated=0.35 normalize process_all", "saturated=0.35 normalize"));
        W4Stk.kase("stackproc", "gaussian_hyperstack_composite", "stackFilter", f -> W4Stk.multi(f, () -> In.hyper("hyp", 16, 32, 24, 2, 3, 2, 2, true), "Gaussian Blur...", "sigma=1.5 stack", "sigma=1.5 slice", "sigma=1.5"));
        W4Stk.kase("stackproc", "gaussian_hyperstack_color_mode", "stackFilter", f -> W4Stk.multi(f, () -> { ImagePlus h = In.hyper("hypc", 16, 32, 24, 2, 3, 1, 2, true); ((CompositeImage) h).setMode(IJ.COLOR); return h; },
            "Gaussian Blur...", "sigma=1.5 stack", "sigma=1.5"));
        W4Stk.kase("stackproc", "gaussian_hyperstack_1c", "stackFilter", f -> W4Stk.multi(f, () -> { ImagePlus h = In.hyper("hyp1", 16, 32, 24, 1, 3, 2, 2, false); h.setPosition(1, 2, 2); return h; }, "Gaussian Blur...", "sigma=1.5 stack", "sigma=1.5"));
        W4Stk.kase("stackproc", "size_stack_xy", "stackFilter", f -> W4Stk.multi(f, () -> In.stack("s16", 16, 37, 23, 4, 3), "Size...", "width=20 height=12 depth=4 constrain average interpolation=Bilinear", "width=20 height=12 depth=4 average interpolation=None"));
        W4Stk.kase("stackproc", "size_stack_depth", "stackFilter", f -> W4Stk.multi(f, () -> In.stack("s16", 16, 37, 23, 4, 3), "Size...", "width=37 height=23 depth=8 average interpolation=Bilinear", "width=37 height=23 depth=2 average interpolation=Bilinear",
            "width=37 height=23 depth=6 average interpolation=None", "width=18 height=12 depth=3 average interpolation=Bicubic"));
        W4Stk.kase("stackproc", "size_hyperstack", "stackFilter", f -> W4Stk.multi(f, () -> In.hyper("hyp", 16, 32, 24, 2, 3, 2, 2, true), "Size...", "width=16 height=12 depth=3 time=2 average interpolation=Bilinear", "width=32 height=24 depth=5 time=3 average interpolation=Bilinear"));
        W4Stk.kase("stackproc", "scale_stack", "stackFilter", f -> W4Stk.multi(f, () -> In.stack("s8", 8, 37, 23, 4, 3), "Scale...", "x=0.5 y=0.5 z=1.0 width=18 height=11 depth=4 interpolation=Bilinear average process create title=out",
            "x=0.5 y=0.5 z=1.0 width=18 height=11 depth=4 interpolation=Bilinear average create title=out", "x=2 y=2 z=1.0 width=74 height=46 depth=4 interpolation=None process create title=out",
            "x=1.0 y=1.0 z=2.0 width=37 height=23 depth=8 interpolation=Bilinear average process create title=out", "x=0.5 y=0.5 z=1.0 width=18 height=11 depth=4 interpolation=Bilinear average process title=out"));
        W4Stk.kase("stackproc", "bin_stack", "stackFilter", f -> W4Stk.multi(f, () -> In.stack("s8", 8, 36, 24, 4, 3), "Bin...", "x=2 y=2 z=1 bin=Average", "x=2 y=2 z=2 bin=Average", "x=2 y=2 z=2 bin=Median", "x=2 y=2 z=2 bin=Max", "x=3 y=2 z=3 bin=Sum"));
        W4Stk.kase("stackproc", "crop_stack", "stackFilter", f -> W4Stk.multi(f, () -> W4Ana.roi(In.stack("s16", 16, 37, 23, 3, 3), new Roi(4, 3, 16, 10)), "Crop", ""));
        W4Stk.kase("stackproc", "canvas_translate_rotate_stack", "stackFilter", f -> {
            List<Object> cases = new ArrayList<>();
            for (String[] c : new String[][]{{"Canvas Size...", "width=45 height=30 position=Center zero"}, {"Translate...", "x=3 y=2 interpolation=None stack"}, {"Rotate... ", "angle=15 grid=1 interpolation=Bilinear stack"},
                    {"Rotate 90 Degrees Right", ""}, {"Flip Horizontally", "stack"}, {"Flip Vertically", "stack"}}) {
                ImagePlus i = In.stack("s8", 8, 37, 23, 3, 3);
                i.show();
                Map<String, Object> r = W4Stk.run1(i, c[0], c[1]);
                r.put("command", c[0]); r.put("options", c[1]);
                cases.add(r);
                W4Stk.closeAll();
            }
            f.put("input", Stk.stack(In.stack("s8", 8, 37, 23, 3, 3)));
            f.put("cases", cases);
        });
    }

    static void calc() {
        String[] ops = {"Add", "Subtract", "Multiply", "Divide", "AND", "Max", "Average", "Difference", "Copy"};
        List<String> o = new ArrayList<>();
        for (String op : ops) o.add("image1=s1 operation=" + op + " image2=s2 create stack");
        o.add("image1=s1 operation=Add image2=s2 create 32-bit stack");
        o.add("image1=s1 operation=Difference image2=s2 create 32-bit stack");
        o.add("image1=s1 operation=Add image2=s2 stack");
        o.add("image1=s1 operation=Add image2=s2 create");
        o.add("image1=s1 operation=Divide image2=s2 create 32-bit stack");
        for (int bits : new int[]{8, 16, 32}) {
            final int bd = bits;
            W4Stk.kase("stackproc", "calc_stack_x_stack_" + Gen.bits(bits), "imageCalculator", f -> W4Ops.multiN(f, () -> new ImagePlus[]{In.stack("s2", bd, 37, 23, 4, 9), In.stack("s1", bd, 37, 23, 4, 1)}, "Image Calculator...",
                bd == 8 ? o.toArray(new String[0]) : new String[]{o.get(0), o.get(7), o.get(10), o.get(11)}));
        }
        W4Stk.kase("stackproc", "calc_stack_x_image", "imageCalculator", f -> W4Ops.multiN(f, () -> new ImagePlus[]{In.image("s2", 8, 37, 23, 9), In.stack("s1", 8, 37, 23, 4, 1)}, "Image Calculator...",
            "image1=s1 operation=Add image2=s2 create stack", "image1=s1 operation=Difference image2=s2 create 32-bit stack", "image1=s1 operation=Subtract image2=s2 stack", "image1=s1 operation=Multiply image2=s2 create"));
        W4Stk.kase("stackproc", "calc_image_x_stack", "imageCalculator", f -> W4Ops.multiN(f, () -> new ImagePlus[]{In.stack("s2", 8, 37, 23, 4, 9), In.image("s1", 8, 37, 23, 1)}, "Image Calculator...",
            "image1=s1 operation=Add image2=s2 create stack", "image1=s1 operation=Add image2=s2 create"));
        W4Stk.kase("stackproc", "calc_stack_different_depths", "imageCalculator", f -> W4Ops.multiN(f, () -> new ImagePlus[]{In.stack("s2", 8, 37, 23, 3, 9), In.stack("s1", 8, 37, 23, 4, 1)}, "Image Calculator...",
            "image1=s1 operation=Add image2=s2 create stack", "image1=s2 operation=Add image2=s1 create stack"));
        W4Stk.kase("stackproc", "calc_stack_different_sizes", "imageCalculator", f -> W4Ops.multiN(f, () -> new ImagePlus[]{In.stack("s2", 8, 30, 20, 4, 9), In.stack("s1", 8, 37, 23, 4, 1)}, "Image Calculator...",
            "image1=s1 operation=Add image2=s2 create stack"));
        W4Stk.kase("stackproc", "calc_stack_mixed_types", "imageCalculator", f -> W4Ops.multiN(f, () -> new ImagePlus[]{In.stack("s2", 16, 37, 23, 4, 9), In.stack("s1", 8, 37, 23, 4, 1)}, "Image Calculator...",
            "image1=s1 operation=Add image2=s2 create stack", "image1=s1 operation=Add image2=s2 create 32-bit stack"));
        W4Stk.kase("stackproc", "calc_hyperstack_x_hyperstack", "imageCalculator", f -> W4Ops.multiN(f, () -> new ImagePlus[]{In.hyper("h2", 16, 32, 24, 2, 2, 2, 9, true), In.hyper("h1", 16, 32, 24, 2, 2, 2, 1, true)}, "Image Calculator...",
            "image1=h1 operation=Add image2=h2 create stack", "image1=h1 operation=Subtract image2=h2 create stack 32-bit"));
        W4Stk.kase("stackproc", "calc_hyperstack_x_image", "imageCalculator", f -> W4Ops.multiN(f, () -> new ImagePlus[]{In.image("i", 16, 32, 24, 5), In.hyper("h1", 16, 32, 24, 2, 2, 2, 1, true)}, "Image Calculator...",
            "image1=h1 operation=Add image2=i create stack", "image1=h1 operation=Add image2=i create"));
        W4Stk.kase("stackproc", "calc_rgb_stacks", "imageCalculator", f -> W4Ops.multiN(f, () -> new ImagePlus[]{In.rgbStack("s2", 37, 23, 3, 9), In.rgbStack("s1", 37, 23, 3, 1)}, "Image Calculator...",
            "image1=s1 operation=Add image2=s2 create stack", "image1=s1 operation=Difference image2=s2 create stack"));
    }

    /** Binary stack: touching disks / lines drifting between the slices. */
    static ImagePlus binaryStack(String title, int n, boolean inverted) {
        ImageStack st = new ImageStack(48, 40);
        for (int i = 0; i < n; i++) {
            ByteProcessor ip = Gen.touchingDisks(48, 40);
            Gen.disk(ip, 38, 10 + 4 * i, 3.5 + i, 255);
            if (i % 2 == 1) Gen.disk(ip, 6, 5, 2.5, 0);
            ip.set(1, 1, 255);
            if (inverted) ip.invert();
            st.addSlice("p" + (i + 1), ip);
        }
        ImagePlus imp = new ImagePlus(title, st);
        if (inverted) imp.getProcessor().invertLut();
        return imp;
    }

    static void particles() {
        String m = "area mean centroid bounding shape stack display redirect=None decimal=3";
        String[] opts = {
            "size=0-Infinity circularity=0.00-1.00 show=Nothing display clear stack",
            "size=0-Infinity circularity=0.00-1.00 show=Nothing display clear summarize stack",
            "size=5-Infinity circularity=0.00-1.00 show=Nothing display clear stack",
            "size=0-Infinity circularity=0.50-1.00 show=Nothing display clear stack",
            "size=0-Infinity circularity=0.00-1.00 show=Nothing display exclude clear stack",
            "size=0-Infinity circularity=0.00-1.00 show=Nothing display include clear stack",
            "size=0-Infinity circularity=0.00-1.00 show=Masks display clear stack",
            "size=0-Infinity circularity=0.00-1.00 show=[Count Masks] display clear stack",
            "size=0-Infinity circularity=0.00-1.00 show=Nothing display clear",
            "size=0-Infinity circularity=0.00-1.00 show=Nothing summarize stack",
            "size=0-Infinity circularity=0.00-1.00 show=Overlay display clear stack"};
        W4Stk.kase("stackproc", "analyze_particles_stack", "analyzeParticles", f -> {
            W4Ana.setMeasurements(m);
            f.put("setMeasurements", m);
            f.put("command", "Analyze Particles...");
            f.put("input", Stk.stack(binaryStack("bin", 3, false)));
            List<Object> cases = new ArrayList<>();
            for (String o : opts) {
                ImagePlus cur = binaryStack("bin", 3, false);
                cur.show();
                IJ.setThreshold(cur, 255, 255);
                closeSummary();
                Map<String, Object> r = W4Stk.run1(cur, "Analyze Particles...", o);
                LinkedHashMap<String, Object> c = new LinkedHashMap<>();
                c.put("options", o);
                Frame fr = WindowManager.getFrame("Summary");
                if (fr instanceof ij.text.TextWindow) c.put("summary", Stk.table(((ij.text.TextWindow) fr).getResultsTable()));
                Overlay ov = cur.getOverlay();
                if (ov != null) c.put("overlayCount", ov.size());
                c.putAll(r);
                cases.add(c);
                closeSummary();
                W4Stk.closeAll();
            }
            f.put("cases", cases);
            W4Ana.setMeasurements(W4Ana.DEFAULT);
        });
        W4Stk.kase("stackproc", "analyze_particles_stack_inverting_lut", "analyzeParticles", f -> {
            W4Ana.setMeasurements(m);
            f.put("setMeasurements", m);
            f.put("command", "Analyze Particles...");
            f.put("input", Stk.stack(binaryStack("bini", 3, true)));
            List<Object> cases = new ArrayList<>();
            for (String o : new String[]{"size=0-Infinity circularity=0.00-1.00 show=Nothing display clear stack", "size=0-Infinity circularity=0.00-1.00 show=Nothing display clear"}) {
                ImagePlus cur = binaryStack("bini", 3, true);
                cur.show();
                closeSummary();
                Map<String, Object> r = W4Stk.run1(cur, "Analyze Particles...", o);
                LinkedHashMap<String, Object> c = new LinkedHashMap<>();
                c.put("options", o);
                c.putAll(r);
                cases.add(c);
                closeSummary();
                W4Stk.closeAll();
            }
            f.put("cases", cases);
            W4Ana.setMeasurements(W4Ana.DEFAULT);
        });
        W4Stk.kase("stackproc", "analyze_particles_stack_with_roi", "analyzeParticles", f -> {
            W4Ana.setMeasurements(m);
            f.put("setMeasurements", m);
            f.put("command", "Analyze Particles...");
            ImagePlus first = W4Ana.roi(binaryStack("binr", 3, false), new Roi(2, 2, 40, 30));
            f.put("input", Stk.stack(first));
            f.put("roi", Stk.roi(first.getRoi()));
            List<Object> cases = new ArrayList<>();
            for (String o : new String[]{"size=0-Infinity circularity=0.00-1.00 show=Nothing display clear stack"}) {
                ImagePlus cur = W4Ana.roi(binaryStack("binr", 3, false), new Roi(2, 2, 40, 30));
                cur.show();
                IJ.setThreshold(cur, 255, 255);
                Map<String, Object> r = W4Stk.run1(cur, "Analyze Particles...", o);
                LinkedHashMap<String, Object> c = new LinkedHashMap<>();
                c.put("options", o);
                c.putAll(r);
                cases.add(c);
                W4Stk.closeAll();
            }
            f.put("cases", cases);
            W4Ana.setMeasurements(W4Ana.DEFAULT);
        });
    }

    static void closeSummary() {
        Frame fr = WindowManager.getFrame("Summary");
        if (fr != null) fr.dispose();
    }

    static void histograms() {
        W4Stk.kase("stackproc", "histogram_all_slices", "stackHistogram", f -> {
            f.put("command", "Histogram");
            List<Object> cases = new ArrayList<>();
            for (int bits : new int[]{8, 16, 32}) {
                ImagePlus s = In.stack("s" + bits, bits, 37, 23, 4, 3 + bits);
                ImageStatistics all = new StackStatistics(s);
                List<Object> per = new ArrayList<>();
                for (int i = 1; i <= s.getStackSize(); i++) {
                    ImageProcessor ip = s.getStack().getProcessor(i);
                    ip.resetRoi();
                    per.add(ip.getStats().histogram);
                }
                cases.add(J.o("bitDepth", bits, "input", Stk.stack(s), "stackHistogram", all.histogram, "stackMin", all.min, "stackMax", all.max, "stackMean", all.mean, "stackStdDev", all.stdDev,
                    "sliceHistograms", per, "histMin", all.histMin, "histMax", all.histMax, "binSize", all.binSize, "nBins", all.nBins));
            }
            f.put("cases", cases);
        });
        W4Stk.kase("stackproc", "histogram_command_all_images", "stackHistogram", f -> {
            f.put("command", "Histogram");
            List<Object> cases = new ArrayList<>();
            for (String o : new String[]{"bins=256 use x_min=0 x_max=255 y_max=Auto stack", "bins=256 use x_min=0 x_max=255 y_max=Auto", "bins=64 x_min=0 x_max=255 y_max=Auto stack", "stack"}) {
                ImagePlus s = In.stack("s8", 8, 37, 23, 4, 3);
                s.show();
                List<Integer> before = W4Stk.ids();
                W4Dlg.unexpected.clear();
                W4Dlg.guard = true;
                String thrown = null;
                try { IJ.run(s, "Histogram", o); } catch (Throwable e) { thrown = e.toString(); } finally { W4Dlg.guard = false; }
                List<Object> plots = new ArrayList<>();
                for (int id : W4Stk.ids()) if (!before.contains(id)) {
                    ImagePlus p = WindowManager.getImage(id);
                    if (p == null) continue;
                    Object po = p.getProperty(Plot.PROPERTY_KEY);
                    plots.add(po instanceof Plot ? J.o("title", p.getTitle(), "x", ((Plot) po).getXValues(), "y", ((Plot) po).getYValues()) : J.o("title", p.getTitle(), "width", p.getWidth(), "height", p.getHeight()));
                }
                cases.add(J.o("options", o, "plots", plots, "thrown", thrown, "dialogs", new ArrayList<Object>(W4Dlg.unexpected)));
                W4Stk.closeAll();
            }
            f.put("input", Stk.stack(In.stack("s8", 8, 37, 23, 4, 3)));
            f.put("cases", cases);
        });
    }
}
