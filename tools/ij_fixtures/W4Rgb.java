import ij.*;
import ij.gui.*;
import ij.measure.*;
import ij.plugin.LutLoader;
import ij.process.*;
import java.awt.image.IndexColorModel;
import java.util.*;
import java.util.function.Supplier;

/**
 * rgb: the 24-bit type. RGB Color from composites / single images, RGB Stack / HSB / Lab, conversions to 8/16/32-bit (Weighted RGB conversions off and on),
 * 8-bit Color (MedianCut), Make Composite, Split Channels, Merge Channels, RGB filters / measure / histogram, display-range bake.
 */
final class W4Rgb {
    static final String UNWEIGHTED = " ", WEIGHTED = " weighted";

    static LUT lut(String name, double min, double max) { return new LUT(LutLoader.getLut(name), min, max); }

    /** Composite of n channels (16-bit unless stated) with set LUTs and ranges. */
    static ImagePlus comp(String title, int bits, int nc, int nz, int nt, long seed, String[] luts, double[][] ranges) {
        ImagePlus h = In.hyper(title, bits, 32, 24, nc, nz, nt, seed, true);
        CompositeImage ci = (CompositeImage) h;
        for (int c = 1; c <= nc; c++) {
            if (luts != null && luts[c - 1] != null) { ci.setC(c); ci.setChannelLut(lut(luts[c - 1], 0, 255)); }
            if (ranges != null && ranges[c - 1] != null) { ci.setC(c); ci.setDisplayRange(ranges[c - 1][0], ranges[c - 1][1]); }
        }
        ci.setC(1);
        return ci;
    }

    static void conv(boolean scale, boolean weighted) {
        IJ.run("Conversions...", " " + (scale ? "scale" : "") + (weighted ? " weighted" : ""));
    }

    static void run() {
        // ---- RGB Color from a composite
        double[][] r2 = {{4000, 40000}, {10000, 30000}};
        double[][] r3 = {{5000, 40000}, {1000, 20000}, {0, 60000}};
        W4Stk.kase("rgb", "rgbcolor_composite_2ch_u16", "rgbColor", f -> W4Stk.multi(f, () -> comp("c2", 16, 2, 3, 2, 3, null, r2), "RGB Color",
            "slices frames", "slices frames keep", "slices", "frames", "keep", ""));
        W4Stk.kase("rgb", "rgbcolor_composite_3ch_u16_ranges", "rgbColor", f -> W4Stk.multi(f, () -> comp("c3", 16, 3, 2, 2, 4, null, r3), "RGB Color", "slices frames keep", "slices keep"));
        W4Stk.kase("rgb", "rgbcolor_composite_3ch_u8", "rgbColor", f -> W4Stk.multi(f, () -> comp("c3b", 8, 3, 2, 1, 5, null, new double[][]{{20, 200}, {0, 255}, {50, 120}}), "RGB Color", "slices keep"));
        W4Stk.kase("rgb", "rgbcolor_composite_f32", "rgbColor", f -> W4Stk.multi(f, () -> comp("c3f", 32, 3, 1, 1, 6, null, new double[][]{{-50, 300}, {0, 400}, {100, 200}}), "RGB Color", "keep"));
        W4Stk.kase("rgb", "rgbcolor_composite_luts_grays_fire", "rgbColor", f -> W4Stk.multi(f, () -> comp("cl", 16, 2, 2, 1, 7, new String[]{"grays", "fire"}, new double[][]{{0, 60000}, {2000, 50000}}), "RGB Color", "slices keep"));
        W4Stk.kase("rgb", "rgbcolor_composite_luts_cyan_magenta_yellow", "rgbColor", f -> W4Stk.multi(f, () -> comp("cmy", 16, 3, 1, 1, 8, new String[]{"cyan", "magenta", "yellow"}, new double[][]{{0, 60000}, {0, 60000}, {0, 60000}}), "RGB Color", "keep"));
        W4Stk.kase("rgb", "rgbcolor_composite_4ch_gray", "rgbColor", f -> W4Stk.multi(f, () -> comp("c4", 16, 4, 1, 1, 9, new String[]{"red", "green", "blue", "grays"}, new double[][]{{0, 60000}, {0, 60000}, {0, 60000}, {0, 60000}}), "RGB Color", "keep"));
        W4Stk.kase("rgb", "rgbcolor_composite_active_channels", "rgbColor", f -> W4Stk.multi(f, () -> {
            ImagePlus h = comp("ca", 16, 3, 1, 1, 10, null, r3);
            ((CompositeImage) h).getActiveChannels()[1] = false;
            return h;
        }, "RGB Color", "keep"));
        W4Stk.kase("rgb", "rgbcolor_color_mode", "rgbColor", f -> W4Stk.multi(f, () -> {
            ImagePlus h = comp("cc", 16, 2, 2, 1, 11, null, r2);
            ((CompositeImage) h).setMode(IJ.COLOR); h.setPosition(2, 1, 1);
            return h;
        }, "RGB Color", "slices keep"));
        W4Stk.kase("rgb", "rgbcolor_grayscale_mode", "rgbColor", f -> W4Stk.multi(f, () -> {
            ImagePlus h = comp("cg", 16, 2, 2, 1, 12, null, r2);
            ((CompositeImage) h).setMode(IJ.GRAYSCALE); h.setPosition(1, 1, 1);
            return h;
        }, "RGB Color", "slices keep"));
        W4Stk.kase("rgb", "stack_to_rgb_composite", "stackToRgb", f -> W4Stk.multi(f, () -> comp("c3s", 16, 3, 2, 2, 13, null, r3), "Stack to RGB", "slices frames keep", "slices keep", ""));

        // ---- RGB Color from a single-channel image: LUT + display range applied
        W4Stk.kase("rgb", "rgbcolor_single_u8_fire_range", "rgbColor", f -> W4Stk.multi(f, () -> {
            ImagePlus i = In.image("g8", 8, 37, 23, 3);
            i.getProcessor().setColorModel(LutLoader.getLut("fire")); i.getProcessor().setMinAndMax(40, 200);
            return i;
        }, "RGB Color", ""));
        W4Stk.kase("rgb", "rgbcolor_single_u8_grays", "rgbColor", f -> W4Stk.multi(f, () -> In.image("g8", 8, 37, 23, 3), "RGB Color", ""));
        W4Stk.kase("rgb", "rgbcolor_single_u8_inverting", "rgbColor", f -> W4Stk.multi(f, () -> {
            ImagePlus i = In.image("g8i", 8, 37, 23, 3);
            i.getProcessor().invertLut();
            return i;
        }, "RGB Color", ""));
        W4Stk.kase("rgb", "rgbcolor_single_u16_range_grays", "rgbColor", f -> W4Stk.multi(f, () -> {
            ImagePlus i = In.image("g16", 16, 37, 23, 4);
            i.getProcessor().setMinAndMax(5000, 40000);
            return i;
        }, "RGB Color", ""));
        W4Stk.kase("rgb", "rgbcolor_single_u16_ice", "rgbColor", f -> W4Stk.multi(f, () -> {
            ImagePlus i = In.image("g16", 16, 37, 23, 4);
            i.getProcessor().setColorModel(LutLoader.getLut("ice")); i.getProcessor().setMinAndMax(1000, 60000);
            return i;
        }, "RGB Color", ""));
        W4Stk.kase("rgb", "rgbcolor_single_f32_inverted_range", "rgbColor", f -> W4Stk.multi(f, () -> {
            ImagePlus i = In.image("g32", 32, 37, 23, 5);
            i.getProcessor().invertLut(); i.getProcessor().setMinAndMax(0, 300);
            return i;
        }, "RGB Color", ""));
        W4Stk.kase("rgb", "rgbcolor_stack_u16_display_range", "rgbColor", f -> W4Stk.multi(f, () -> {
            ImagePlus s = In.stack("s16", 16, 37, 23, 3, 3);
            s.getProcessor().setMinAndMax(8000, 45000);
            return s;
        }, "RGB Color", ""));
        W4Stk.kase("rgb", "rgbcolor_stack_u8_fire", "rgbColor", f -> W4Stk.multi(f, () -> {
            ImagePlus s = In.stack("s8", 8, 37, 23, 3, 3);
            s.getProcessor().setColorModel(LutLoader.getLut("fire"));
            return s;
        }, "RGB Color", ""));

        // ---- RGB Stack / HSB Stack / HSB (32-bit) / Lab Stack and their way back
        for (String[] c : new String[][]{{"rgb_stack", "RGB Stack"}, {"hsb_stack", "HSB Stack"}, {"hsb_32bit", "HSB (32-bit)"}, {"lab_stack", "Lab Stack"}}) {
            final String cmd = c[1];
            W4Stk.kase("rgb", "convert_" + c[0], "rgbConvert", f -> W4Stk.multi(f, () -> In.rgbImage("rgb", 37, 23, 3), cmd, ""));
            W4Stk.kase("rgb", "convert_" + c[0] + "_of_rgb_stack", "rgbConvert", f -> W4Stk.multi(f, () -> In.rgbStack("rgbs", 37, 23, 3, 3), cmd, ""));
        }
        W4Stk.kase("rgb", "convert_rgb_stack_roundtrip", "rgbConvert", f -> {
            for (String back : new String[]{"RGB Stack", "HSB Stack", "Lab Stack", "HSB (32-bit)"}) {
                ImagePlus i = In.rgbImage("rgb", 37, 23, 3);
                i.show();
                if (f.m.get("input") == null) f.put("input", Stk.stack(i));
                W4Stk.run1(i, back, "");
                Map<String, Object> mid = Stk.stack(i);
                Map<String, Object> r = W4Stk.run1(i, "RGB Color", "");
                List<Object> cs = (List<Object>) f.m.computeIfAbsent("cases", k -> new ArrayList<Object>());
                cs.add(J.o("via", back, "middle", mid, "after", r));
                W4Stk.closeAll();
            }
        });
        W4Stk.kase("rgb", "convert_make_composite_rgb", "makeComposite", f -> W4Stk.multi(f, () -> In.rgbImage("rgb", 37, 23, 3), "Make Composite", "display=Composite", "display=Color", "display=Grayscale", ""));
        W4Stk.kase("rgb", "convert_make_composite_stack", "makeComposite", f -> {
            for (int n : new int[]{2, 3, 4, 7, 8}) {
                ImagePlus i = In.stack("s" + n, 8, 37, 23, n, 3);
                i.show();
                if (n == 2) f.put("input", Stk.stack(i));
                Map<String, Object> r = W4Stk.run1(i, "Make Composite", "display=Composite");
                List<Object> cs = (List<Object>) f.m.computeIfAbsent("cases", k -> new ArrayList<Object>());
                r.put("slices", n);
                cs.add(r);
                W4Stk.closeAll();
            }
            f.put("command", "Make Composite");
        });
        W4Stk.kase("rgb", "convert_make_composite_hyperstack_z", "makeComposite", f -> W4Stk.multi(f, () -> In.hyper("hz", 8, 37, 23, 1, 3, 2, 2, false), "Make Composite", "display=Composite", ""));

        // ---- conversions of RGB to 8/16/32-bit, weighted off / on, scale on
        for (boolean w : new boolean[]{false, true}) {
            final boolean weighted = w;
            for (String t : new String[]{"8-bit", "16-bit", "32-bit"}) {
                final String type = t;
                W4Stk.kase("rgb", "to_" + t.replace("-", "") + (w ? "_weighted" : "_unweighted"), "rgbTo" + t, f -> {
                    conv(true, weighted);
                    f.put("weighted", weighted);
                    W4Stk.multi(f, () -> In.rgbImage("rgb", 37, 23, 3), type, "");
                    conv(true, false);
                });
            }
            W4Stk.kase("rgb", "to_8bit_rgb_stack" + (w ? "_weighted" : "_unweighted"), "rgbTo8bit", f -> {
                conv(true, weighted);
                f.put("weighted", weighted);
                W4Stk.multi(f, () -> In.rgbStack("rgbs", 37, 23, 3, 3), "8-bit", "");
                conv(true, false);
            });
            W4Stk.kase("rgb", "to_8bit_saturated_extremes" + (w ? "_weighted" : "_unweighted"), "rgbTo8bit", f -> {
                conv(true, weighted);
                f.put("weighted", weighted);
                W4Stk.multi(f, () -> {
                    int[] px = new int[6 * 4];
                    int[] cols = {0xFF0000, 0x00FF00, 0x0000FF, 0xFFFFFF, 0x000000, 0xFFFF00, 0x00FFFF, 0xFF00FF, 0x010203, 0x7F7F7F, 0x808080, 0xFE0001};
                    for (int i = 0; i < px.length; i++) px[i] = cols[i % cols.length];
                    return new ImagePlus("ext", new ColorProcessor(6, 4, px));
                }, "8-bit", "");
                conv(true, false);
            });
        }
        // 8-bit RGB -> gray with the weights ImageJ stores (Conversions...): the factors that were in force
        W4Stk.kase("rgb", "to_8bit_weighting_factors", "weights", f -> {
            double[] w0 = ColorProcessor.getWeightingFactors();
            conv(true, true);
            double[] w1 = ColorProcessor.getWeightingFactors();
            conv(true, false);
            double[] w2 = ColorProcessor.getWeightingFactors();
            f.put("result", J.o("default", w0, "weighted", w1, "unweightedAgain", w2));
        });

        // ---- 8-bit Color (MedianCut)
        W4Stk.kase("rgb", "eightbit_color_blobs", "eightBitColor", f -> W4Stk.multi(f, () -> In.rgbImage("rgb", 37, 23, 3), "8-bit Color", "number=256", "number=16", "number=2", "number=64", "number=4", "number=300", "number=1"));
        W4Stk.kase("rgb", "eightbit_color_few_colours", "eightBitColor", f -> W4Stk.multi(f, () -> {
            int[] px = new int[20 * 12];
            int[] cols = {0xC81E1E, 0x1EC81E, 0x1E1EC8, 0xC8C81E, 0xC81EC8};
            for (int i = 0; i < px.length; i++) px[i] = cols[(i / 7 + i / 20) % cols.length];
            return new ImagePlus("few", new ColorProcessor(20, 12, px));
        }, "8-bit Color", "number=256", "number=4", "number=3", "number=2"));
        W4Stk.kase("rgb", "eightbit_color_stack", "eightBitColor", f -> W4Stk.multi(f, () -> In.rgbStack("rgbs", 37, 23, 2, 3), "8-bit Color", "number=256", "number=16"));
        W4Stk.kase("rgb", "eightbit_color_gray_rgb", "eightBitColor", f -> W4Stk.multi(f, () -> {
            int[] px = new int[30 * 8];
            for (int i = 0; i < px.length; i++) { int v = (i * 7) % 256; px[i] = (v << 16) | (v << 8) | v; }
            return new ImagePlus("gray", new ColorProcessor(30, 8, px));
        }, "8-bit Color", "number=256", "number=8"));
        W4Stk.kase("rgb", "eightbit_color_composite", "eightBitColor", f -> W4Stk.multi(f, () -> comp("c3c", 16, 3, 1, 1, 14, null, r3), "8-bit Color", "number=256"));

        // ---- Split Channels / Merge Channels
        W4Stk.kase("rgb", "split_channels_rgb", "splitChannels", f -> W4Stk.multi(f, () -> In.rgbImage("rgb", 37, 23, 3), "Split Channels", ""));
        W4Stk.kase("rgb", "split_channels_rgb_stack", "splitChannels", f -> W4Stk.multi(f, () -> In.rgbStack("rgbs", 37, 23, 3, 3), "Split Channels", ""));
        W4Stk.kase("rgb", "split_channels_composite", "splitChannels", f -> W4Stk.multi(f, () -> comp("c3", 16, 3, 2, 2, 15, null, r3), "Split Channels", ""));
        W4Stk.kase("rgb", "split_channels_rgb_calibrated", "splitChannels", f -> W4Stk.multi(f, () -> In.calibrate2(In.rgbImage("rgbc", 37, 23, 3)), "Split Channels", ""));
        String create = "c1=c1 c2=c2 c3=c3 create", rgb = "c1=c1 c2=c2 c3=c3";
        W4Stk.kase("rgb", "merge_channels_8bit", "mergeChannels", f -> W4Ops.multiN(f, () -> three(8, 3), "Merge Channels...",
            rgb, rgb + " keep", create, create + " keep", "c1=c1 c2=c2", "c2=c1 c3=c2", "c1=c1 c2=c2 c3=c3 c4=c4", "c1=c1 c2=c2 c3=c3 c4=c4 create", "c5=c1 c6=c2 c7=c3 create", "c4=c1 c5=c2 create",
            "c1=c1 c2=c2 c3=c3 create ignore", "c1=c3 c2=c2 c3=c1"));
        W4Stk.kase("rgb", "merge_channels_16bit", "mergeChannels", f -> W4Ops.multiN(f, () -> three(16, 3), "Merge Channels...", rgb, create, "c1=c1 c2=c2 create"));
        W4Stk.kase("rgb", "merge_channels_16bit_display_ranges", "mergeChannels", f -> W4Ops.multiN(f, () -> {
            ImagePlus[] a = three(16, 3);
            a[0].getProcessor().setMinAndMax(5000, 40000); a[1].getProcessor().setMinAndMax(1000, 20000); a[2].getProcessor().setMinAndMax(0, 30000);
            return a;
        }, "Merge Channels...", rgb, create));
        W4Stk.kase("rgb", "merge_channels_32bit", "mergeChannels", f -> W4Ops.multiN(f, () -> three(32, 3), "Merge Channels...", rgb, create));
        W4Stk.kase("rgb", "merge_channels_source_luts", "mergeChannels", f -> W4Ops.multiN(f, () -> {
            ImagePlus[] a = three(8, 3);
            a[0].getProcessor().setColorModel(LutLoader.getLut("fire")); a[1].getProcessor().invertLut();
            return a;
        }, "Merge Channels...", create, create + " ignore", rgb));
        W4Stk.kase("rgb", "merge_channels_stacks", "mergeChannels", f -> W4Ops.multiN(f, () -> new ImagePlus[]{In.stack("c1", 8, 37, 23, 3, 1), In.stack("c2", 8, 37, 23, 3, 9), In.stack("c3", 8, 37, 23, 3, 17)}, "Merge Channels...",
            create, rgb, create + " keep"));
        W4Stk.kase("rgb", "merge_channels_hyperstack_sources", "mergeChannels", f -> W4Ops.multiN(f, () -> new ImagePlus[]{In.hyper("c1", 16, 37, 23, 1, 2, 2, 1, false), In.hyper("c2", 16, 37, 23, 1, 2, 2, 9, false)}, "Merge Channels...",
            "c1=c1 c2=c2 create", "c1=c1 c2=c2"));
        W4Stk.kase("rgb", "merge_channels_mismatch", "mergeChannels", f -> W4Ops.multiN(f, () -> new ImagePlus[]{In.image("c1", 8, 37, 23, 1), In.image("c2", 8, 30, 20, 2)}, "Merge Channels...", "c1=c1 c2=c2 create"));
        W4Stk.kase("rgb", "merge_channels_mixed_types", "mergeChannels", f -> W4Ops.multiN(f, () -> new ImagePlus[]{In.image("c1", 8, 37, 23, 1), In.image("c2", 16, 37, 23, 2)}, "Merge Channels...", "c1=c1 c2=c2 create", "c1=c1 c2=c2"));
        W4Stk.kase("rgb", "merge_channels_calibrated", "mergeChannels", f -> W4Ops.multiN(f, () -> new ImagePlus[]{In.calibrate2(In.image("c1", 8, 37, 23, 1)), In.calibrate2(In.image("c2", 8, 37, 23, 2))}, "Merge Channels...", "c1=c1 c2=c2 create", "c1=c1 c2=c2"));

        // ---- filters on an RGB image / stack
        String[][] filters = {{"gaussian", "Gaussian Blur...", "sigma=2"}, {"median", "Median...", "radius=2"}, {"add", "Add...", "value=25"}, {"invert", "Invert", ""},
            {"rotate90right", "Rotate 90 Degrees Right", ""}, {"rotate90left", "Rotate 90 Degrees Left", ""}, {"flip_h", "Flip Horizontally", ""}, {"scale_half", "Scale...", "x=0.5 y=0.5 interpolation=Bilinear average create title=out"},
            {"multiply", "Multiply...", "value=1.5"}, {"subtract", "Subtract...", "value=40"}, {"gamma", "Gamma...", "value=0.5"}, {"log", "Log", ""}, {"mean", "Mean...", "radius=2"}, {"sharpen", "Sharpen", ""},
            {"find_edges", "Find Edges", ""}, {"smooth", "Smooth", ""}, {"unsharp", "Unsharp Mask...", "radius=2 mask=0.6"}, {"min", "Minimum...", "radius=1"}, {"max", "Maximum...", "radius=1"},
            {"enhance", "Enhance Contrast...", "saturated=0.35 normalize"}, {"size", "Size...", "width=20 height=12 depth=1 constrain average interpolation=Bilinear"},
            {"canvas", "Canvas Size...", "width=45 height=30 position=Center zero"}, {"translate", "Translate...", "x=3 y=2 interpolation=None"}, {"rotate_30", "Rotate... ", "angle=30 grid=1 interpolation=Bilinear"}, {"bin", "Bin...", "x=2 y=2 bin=Average"}};
        for (String[] flt : filters) {
            W4Stk.kase("rgb", "filter_" + flt[0], "rgbFilter", f -> W4Stk.multi(f, () -> In.rgbImage("rgb", 37, 23, 3), flt[1], flt[2]));
        }
        W4Stk.kase("rgb", "filter_gaussian_stack_all", "rgbFilter", f -> W4Stk.multi(f, () -> In.rgbStack("rgbs", 37, 23, 3, 3), "Gaussian Blur...", "sigma=2 stack", "sigma=2"));
        W4Stk.kase("rgb", "filter_invert_stack_all", "rgbFilter", f -> W4Stk.multi(f, () -> In.rgbStack("rgbs", 37, 23, 3, 3), "Invert", "stack", ""));
        W4Stk.kase("rgb", "filter_gaussian_with_roi", "rgbFilter", f -> W4Stk.multi(f, () -> W4Ana.roi(In.rgbImage("rgb", 37, 23, 3), new OvalRoi(5, 3, 20, 12)), "Gaussian Blur...", "sigma=2"));
        W4Stk.kase("rgb", "filter_add_with_roi", "rgbFilter", f -> W4Stk.multi(f, () -> W4Ana.roi(In.rgbImage("rgb", 37, 23, 3), new Roi(5, 3, 20, 12)), "Add...", "value=25"));
        // binary / threshold commands refuse RGB
        W4Stk.kase("rgb", "refused_on_rgb", "rgbRefused", f -> {
            List<Object> cases = new ArrayList<>();
            for (String[] c : new String[][]{{"Make Binary", ""}, {"Convert to Mask", ""}, {"Skeletonize", ""}, {"Distance Map", ""}, {"Watershed", ""}, {"Analyze Particles...", "size=0-Infinity show=Nothing"},
                    {"Find Maxima...", "prominence=10 output=Count"}, {"Subtract Background...", "rolling=10"}, {"Fill Holes", ""}, {"Erode", ""}, {"Apply LUT", ""}, {"Invert LUT", ""},
                    {"FFT", ""}, {"Gaussian Blur 3D...", "x=2 y=2 z=2"}, {"Enhance Contrast...", "saturated=0.35 equalize"}, {"Find Edges", ""}, {"Threshold...", ""}}) {
                ImagePlus i = In.rgbImage("rgb", 37, 23, 3);
                i.show();
                Map<String, Object> r = W4Stk.run1(i, c[0], c[1]);
                r.put("command", c[0]); r.put("options", c[1]);
                r.remove("self"); r.remove("created");
                cases.add(r);
                W4Stk.closeAll();
            }
            f.put("input", Stk.stack(In.rgbImage("rgb", 37, 23, 3)));
            f.put("cases", cases);
        });

        // ---- RGB measure / histogram / statistics (weighted and unweighted)
        for (boolean w : new boolean[]{false, true}) {
            final boolean weighted = w;
            W4Stk.kase("rgb", "measure_" + (w ? "weighted" : "unweighted"), "rgbMeasure", f -> {
                conv(true, weighted);
                f.put("weighted", weighted);
                W4Ana.setMeasurements("area mean standard modal min integrated median skewness kurtosis area_fraction redirect=None decimal=3");
                f.put("setMeasurements", "area mean standard modal min integrated median skewness kurtosis area_fraction");
                W4Stk.multi(f, () -> W4Ana.roi(In.rgbImage("rgb", 37, 23, 3), new Roi(4, 3, 16, 10)), "Measure", "");
                conv(true, false);
                W4Ana.setMeasurements(W4Ana.DEFAULT);
            });
            W4Stk.kase("rgb", "statistics_" + (w ? "weighted" : "unweighted"), "rgbStatistics", f -> {
                conv(true, weighted);
                ImagePlus i = In.rgbImage("rgb", 37, 23, 3);
                i.setRoi(new OvalRoi(4, 3, 16, 10));
                ImageStatistics st = i.getStatistics(Measurements.AREA | Measurements.MEAN | Measurements.STD_DEV | Measurements.MODE | Measurements.MIN_MAX | Measurements.MEDIAN | Measurements.SKEWNESS | Measurements.KURTOSIS, 256);
                ImageStatistics wh = In.rgbImage("rgb", 37, 23, 3).getStatistics(Measurements.AREA | Measurements.MEAN | Measurements.STD_DEV | Measurements.MODE | Measurements.MIN_MAX | Measurements.MEDIAN, 256);
                f.put("weighted", weighted);
                f.put("input", Stk.stack(In.rgbImage("rgb", 37, 23, 3)));
                f.put("roi", Stk.roi(i.getRoi()));
                f.put("result", J.o("roi", stat(st), "whole", stat(wh), "histogramRoi", st.histogram, "histogramWhole", wh.histogram, "pixelCountRoi", st.pixelCount));
                conv(true, false);
            });
        }
        W4Stk.kase("rgb", "histogram_values", "rgbHistogram", f -> {
            List<Object> cases = new ArrayList<>();
            for (boolean w : new boolean[]{false, true}) {
                conv(true, w);
                ColorProcessor cp = In.rgb(37, 23, 3);
                cases.add(J.o("weighted", w, "histogram", cp.getHistogram(), "weightingFactors", ColorProcessor.getWeightingFactors()));
                ColorProcessor cp2 = In.rgb(37, 23, 3);
                cp2.setRoi(new Roi(4, 3, 16, 10));
                cases.add(J.o("weighted", w, "roi", J.roi(new Roi(4, 3, 16, 10)), "histogram", cp2.getHistogram()));
                conv(true, false);
            }
            f.put("input", Stk.stack(In.rgbImage("rgb", 37, 23, 3)));
            f.put("cases", cases);
        });
        W4Stk.kase("rgb", "histogram_command_rgb", "rgbHistogram", f -> W4Stk.multi(f, () -> In.rgbImage("rgb", 37, 23, 3), "Histogram", ""));
        // display range of an RGB image: ColorProcessor.setMinAndMax rewrites the pixel values (B&C of an RGB image), reset() undoes it
        W4Stk.kase("rgb", "rgb_set_min_max", "rgbDisplayRange", f -> {
            List<Object> cases = new ArrayList<>();
            f.put("input", Stk.stack(In.rgbImage("rgb", 37, 23, 3)));
            for (double[] mm : new double[][]{{40, 200}, {0, 128}, {100, 255}, {0, 255}, {200, 50}}) {
                ImagePlus i = In.rgbImage("rgb", 37, 23, 3);
                i.getProcessor().snapshot();
                i.getProcessor().setMinAndMax(mm[0], mm[1]);
                Map<String, Object> after = Stk.stack(i);
                i.getProcessor().reset();
                cases.add(J.o("min", mm[0], "max", mm[1], "after", after, "resetEqualsInput", J.val(Stk.stack(i).get("planes")).equals(J.val(Stk.stack(In.rgbImage("rgb", 37, 23, 3)).get("planes")))));
            }
            f.put("cases", cases);
        });
        W4Stk.kase("rgb", "rgb_apply_lut_and_reset_range", "rgbDisplayRange", f -> W4Stk.multi(f, () -> { ImagePlus i = In.rgbImage("rgb", 37, 23, 3); i.getProcessor().setMinAndMax(40, 200); return i; }, "Apply LUT", "", ""));
    }

    static ImagePlus[] three(int bits, long seed) { return new ImagePlus[]{In.image("c1", bits, 37, 23, seed), In.image("c2", bits, 37, 23, seed + 10), In.image("c3", bits, 37, 23, seed + 20)}; }

    static Map<String, Object> stat(ImageStatistics s) {
        return J.o("area", s.area, "mean", s.mean, "stdDev", s.stdDev, "dmode", s.dmode, "min", s.min, "max", s.max, "median", s.median, "skewness", s.skewness, "kurtosis", s.kurtosis, "pixelCount", s.pixelCount);
    }
}
