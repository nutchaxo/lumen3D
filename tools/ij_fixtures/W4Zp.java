import ij.*;
import ij.process.*;
import java.util.*;
import java.util.function.Supplier;

/**
 * zproj: Image > Stacks > Z Project... by IJ.run (macro keys: start, stop, projection=[...], all) on plain stacks of every type and on
 * hyperstacks (with and without "All time frames", current frame other than 1, one channel, one frame).
 */
final class W4Zp {
    static final String[] METHODS = {"Average Intensity", "Max Intensity", "Min Intensity", "Sum Slices", "Standard Deviation", "Median"};

    static String[] opts(int a, int b, boolean all) {
        List<String> l = new ArrayList<>();
        for (String m : METHODS) l.add("start=" + a + " stop=" + b + " projection=[" + m + "]" + (all ? " all" : ""));
        return l.toArray(new String[0]);
    }

    static String[] cat(String[]... p) {
        List<String> l = new ArrayList<>();
        for (String[] a : p) l.addAll(Arrays.asList(a));
        return l.toArray(new String[0]);
    }

    static void run() {
        for (int bits : new int[]{8, 16, 32}) {
            final int bd = bits;
            W4Stk.kase("zproj", "zproject_stack_" + Gen.bits(bits), "zProject", f ->
                W4Stk.multi(f, () -> In.stack("stk", bd, 37, 23, 5, 10 + bd), "Z Project...", cat(opts(1, 5, false), opts(2, 4, false))));
        }
        // rounding traps: 4 noise slices -> averages / medians ending in .5, 16-bit sums above 2^16
        W4Stk.kase("zproj", "zproject_noise_u8", "zProject", f ->
            W4Stk.multi(f, () -> In.noiseStack("n8", 8, 19, 11, 4, 5), "Z Project...", cat(opts(1, 4, false), opts(2, 3, false))));
        W4Stk.kase("zproj", "zproject_noise_u16", "zProject", f ->
            W4Stk.multi(f, () -> In.noiseStack("n16", 16, 19, 11, 6, 7), "Z Project...", cat(opts(1, 6, false), opts(1, 2, false))));
        W4Stk.kase("zproj", "zproject_noise_f32", "zProject", f ->
            W4Stk.multi(f, () -> In.noiseStack("n32", 32, 19, 11, 5, 9), "Z Project...", opts(1, 5, false)));
        // a stack with a single slice range
        W4Stk.kase("zproj", "zproject_single_slice_range", "zProject", f ->
            W4Stk.multi(f, () -> In.stack("stk", 16, 37, 23, 5, 3), "Z Project...", "start=3 stop=3 projection=[Max Intensity]", "start=3 stop=3 projection=[Average Intensity]", "start=3 stop=3 projection=[Sum Slices]", "start=3 stop=3 projection=[Standard Deviation]"));
        // out of range start/stop (ImageJ clamps)
        W4Stk.kase("zproj", "zproject_clamped_range", "zProject", f ->
            W4Stk.multi(f, () -> In.stack("stk", 8, 37, 23, 5, 3), "Z Project...", "start=0 stop=9 projection=[Max Intensity]", "start=4 stop=2 projection=[Max Intensity]"));

        // hyperstacks: 2 channels x 3 slices x 2 frames
        Supplier<ImagePlus> h16 = () -> In.hyper("hyp", 16, 40, 30, 2, 3, 2, 2, true);
        W4Stk.kase("zproj", "zproject_hyper_u16_all_frames", "zProject", f -> W4Stk.multi(f, h16, "Z Project...", cat(opts(1, 3, true), opts(2, 3, true))));
        W4Stk.kase("zproj", "zproject_hyper_u16_current_frame", "zProject", f -> W4Stk.multi(f, h16, "Z Project...", opts(1, 3, false)));
        W4Stk.kase("zproj", "zproject_hyper_u16_frame2_current", "zProject", f ->
            W4Stk.multi(f, () -> { ImagePlus h = h16.get(); h.setPosition(2, 2, 2); return h; }, "Z Project...", "start=1 stop=3 projection=[Max Intensity]", "start=1 stop=3 projection=[Sum Slices]", "start=1 stop=3 projection=[Max Intensity] all"));
        W4Stk.kase("zproj", "zproject_hyper_u8", "zProject", f ->
            W4Stk.multi(f, () -> In.hyper("hyp8", 8, 40, 30, 2, 3, 2, 4, true), "Z Project...", "start=1 stop=3 projection=[Average Intensity] all", "start=1 stop=3 projection=[Sum Slices] all", "start=1 stop=3 projection=[Median] all"));
        W4Stk.kase("zproj", "zproject_hyper_f32", "zProject", f ->
            W4Stk.multi(f, () -> In.hyper("hyp32", 32, 40, 30, 2, 3, 2, 5, true), "Z Project...", "start=1 stop=3 projection=[Average Intensity] all", "start=1 stop=3 projection=[Standard Deviation] all"));
        W4Stk.kase("zproj", "zproject_hyper_1c", "zProject", f ->
            W4Stk.multi(f, () -> In.hyper("hyp1", 16, 40, 30, 1, 3, 2, 6, false), "Z Project...", "start=1 stop=3 projection=[Max Intensity] all", "start=1 stop=3 projection=[Max Intensity]", "start=2 stop=3 projection=[Average Intensity] all"));
        W4Stk.kase("zproj", "zproject_hyper_1t", "zProject", f ->
            W4Stk.multi(f, () -> In.hyper("hypz", 16, 40, 30, 2, 3, 1, 7, true), "Z Project...", "start=1 stop=3 projection=[Max Intensity]", "start=1 stop=3 projection=[Sum Slices]"));
        W4Stk.kase("zproj", "zproject_hyper_3c_color_mode", "zProject", f ->
            W4Stk.multi(f, () -> { ImagePlus h = In.hyper("hypc", 16, 40, 30, 3, 3, 2, 8, true); ((CompositeImage) h).setMode(IJ.COLOR); return h; }, "Z Project...", "start=1 stop=3 projection=[Max Intensity] all"));
        W4Stk.kase("zproj", "zproject_hyper_calibrated", "zProject", f ->
            W4Stk.multi(f, () -> { ImagePlus h = In.hyper("hypcal", 16, 40, 30, 2, 3, 2, 9, true); In.calibrate(h); return h; }, "Z Project...", "start=1 stop=3 projection=[Max Intensity] all", "start=1 stop=3 projection=[Max Intensity]"));
        // composite channels with set display ranges / custom luts survive a projection (ranges of the output)
        W4Stk.kase("zproj", "zproject_hyper_display_ranges", "zProject", f ->
            W4Stk.multi(f, () -> {
                ImagePlus h = In.hyper("hypr", 16, 40, 30, 3, 3, 2, 11, true);
                CompositeImage ci = (CompositeImage) h;
                ci.setC(1); ci.setDisplayRange(5000, 40000); ci.setC(2); ci.setDisplayRange(1000, 20000); ci.setC(3); ci.setDisplayRange(0, 60000);
                ci.setC(1);
                return ci;
            }, "Z Project...", "start=1 stop=3 projection=[Max Intensity] all", "start=1 stop=3 projection=[Average Intensity]"));
        // a stack with calibration: the projection keeps it (pixelDepth stays)
        W4Stk.kase("zproj", "zproject_stack_calibrated", "zProject", f ->
            W4Stk.multi(f, () -> { ImagePlus s = In.stack("stkcal", 16, 37, 23, 5, 3); In.calibrate(s); return s; }, "Z Project...", "start=1 stop=5 projection=[Max Intensity]"));
        // slice labels survive?
        W4Stk.kase("zproj", "zproject_stack_labels", "zProject", f ->
            W4Stk.multi(f, () -> { ImagePlus s = In.stack("stkl", 8, 37, 23, 4, 3); for (int i = 1; i <= 4; i++) s.getStack().setSliceLabel("lab" + i, i); return s; }, "Z Project...", "start=1 stop=4 projection=[Max Intensity]"));
        // RGB stack
        W4Stk.kase("zproj", "zproject_rgb_stack", "zProject", f ->
            W4Stk.multi(f, () -> In.rgbStack("rgbs", 37, 23, 4, 3), "Z Project...", cat(opts(1, 4, false))));
    }
}
