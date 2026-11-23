import ij.*;
import ij.gui.*;
import ij.measure.*;
import ij.process.*;
import java.util.*;
import java.util.function.Supplier;

/**
 * Stack commands by IJ.run (macro option keys as the GenericDialogs derive them): reslice substack reduce reverse concat hyper montage
 * zprofile stats labels slices. Each case file records the command, the options string, the input stack(s) and what ImageJ made of them.
 */
final class W4Ops {
    static void run(String g) throws Exception {
        switch (g) {
            case "reslice": W4Ops.reslice(); break;
            case "substack": W4Ops.substack(); break;
            case "reduce": W4Ops.reduce(); break;
            case "reverse": W4Ops.reverse(); break;
            case "concat": W4Ops.concat(); break;
            case "hyper": W4Hyp.run(); break;
            case "montage": W4Ops.montage(); break;
            case "zprofile": W4Ana.zprofile(); break;
            case "stats": W4Ana.stats(); break;
            case "labels": W4Ana.labels(); break;
            case "slices": W4Ana.slices(); break;
        }
    }

    /** Several runs of one command whose inputs are several images (the last one is the image the command is run on). */
    static void multiN(Fx f, Supplier<ImagePlus[]> mk, String command, String... optionsList) {
        f.put("command", command);
        ImagePlus[] first = mk.get();
        List<Object> ins = new ArrayList<>();
        for (ImagePlus i : first) ins.add(Stk.stack(i));
        f.put("inputs", ins);
        f.put("current", first.length - 1);
        List<Object> cases = new ArrayList<>();
        for (String o : optionsList) {
            ImagePlus[] a = mk.get();
            for (ImagePlus i : a) i.show();
            ImagePlus cur = a[a.length - 1];
            Map<String, Object> r = W4Stk.run1(cur, command, o);
            LinkedHashMap<String, Object> c = new LinkedHashMap<>();
            c.put("options", o);
            c.putAll(r);
            List<Object> others = new ArrayList<>();
            for (int k = 0; k < a.length - 1; k++) {
                ImagePlus x = a[k];
                Map<String, Object> now = WindowManager.getImage(x.getID()) == null ? null : Stk.stack(x);
                others.add(now != null && J.val(now).equals(J.val(ins.get(k))) ? "unchanged" : now);
            }
            c.put("others", others);
            cases.add(c);
            W4Stk.closeAll();
        }
        f.put("cases", cases);
    }

    static ImagePlus withRoi(ImagePlus i, Roi r) { i.setRoi(r); return i; }

    static ImagePlus cal(ImagePlus i, double pw, double ph, double pd) {
        Calibration c = i.getCalibration();
        c.pixelWidth = pw; c.pixelHeight = ph; c.pixelDepth = pd; c.setUnit("micron");
        i.setCalibration(c);
        return i;
    }

    // ------------------------------------------------------------------ reslice
    static void reslice() {
        String[] dirs = {"Top", "Left", "Bottom", "Right"};
        List<String> o = new ArrayList<>();
        for (String d : dirs) o.add("output=1.000 start=" + d + " avoid");
        o.add("output=1.000 start=Top flip avoid");
        o.add("output=1.000 start=Top rotate avoid");
        o.add("output=1.000 start=Left flip rotate avoid");
        o.add("output=1.000 start=Top");
        String[] none = o.toArray(new String[0]);
        W4Stk.kase("reslice", "reslice_u8_norect", "reslice", f -> W4Stk.multi(f, () -> In.stack("stk", 8, 37, 23, 6, 3), "Reslice [/]...", none));
        W4Stk.kase("reslice", "reslice_u8_calibrated_spacing", "reslice", f -> W4Stk.multi(f, () -> cal(In.stack("stkc", 8, 37, 23, 6, 3), 0.5, 0.5, 2.0), "Reslice [/]...",
            "output=0.500 start=Top", "output=1.000 start=Top", "output=0.500 start=Top avoid", "output=2.000 start=Top avoid", "output=3.000 start=Left", "output=0.750 start=Left", "output=0.500 start=Bottom flip"));
        W4Stk.kase("reslice", "reslice_u8_unequal_pixel", "reslice", f -> W4Stk.multi(f, () -> cal(In.stack("stku", 8, 37, 23, 6, 3), 0.5, 0.25, 3.0), "Reslice [/]...",
            "output=0.500 start=Top", "output=0.500 start=Left", "output=1.000 start=Right avoid"));
        W4Stk.kase("reslice", "reslice_u8_rect", "reslice", f -> W4Stk.multi(f, () -> withRoi(In.stack("stkr", 8, 37, 23, 6, 3), new Roi(4, 3, 16, 10)), "Reslice [/]...",
            "output=1.000 start=Top avoid", "output=1.000 start=Left avoid", "output=1.000 start=Bottom avoid", "output=1.000 start=Right avoid", "output=1.000 start=Top flip rotate avoid"));
        W4Stk.kase("reslice", "reslice_u8_line", "reslice", f -> W4Stk.multi(f, () -> withRoi(In.stack("stkl", 8, 37, 23, 6, 3), new Line(3, 3, 22, 13)), "Reslice [/]...",
            "output=1.000 slice_count=1 avoid", "output=1.000 slice_count=1", "output=1.000 slice_count=3 avoid", "output=1.000 slice_count=3", "output=2.000 slice_count=1", "output=1.000 slice_count=1 flip rotate avoid"));
        W4Stk.kase("reslice", "reslice_u8_line_horizontal_vertical", "reslice", f -> W4Stk.multi(f, () -> withRoi(In.stack("stkh", 8, 37, 23, 6, 3), new Line(2, 7, 22, 7)), "Reslice [/]...",
            "output=1.000 slice_count=1 avoid", "output=1.000 slice_count=2 avoid", "output=0.500 slice_count=1"));
        W4Stk.kase("reslice", "reslice_u8_line_vertical", "reslice", f -> W4Stk.multi(f, () -> withRoi(In.stack("stkv", 8, 37, 23, 6, 3), new Line(9, 2, 9, 15)), "Reslice [/]...",
            "output=1.000 slice_count=1 avoid", "output=1.000 slice_count=3 avoid"));
        W4Stk.kase("reslice", "reslice_u8_line_calibrated", "reslice", f -> W4Stk.multi(f, () -> withRoi(cal(In.stack("stklc", 8, 37, 23, 6, 3), 0.5, 0.5, 2.0), new Line(3, 3, 22, 13)), "Reslice [/]...",
            "output=0.500 slice_count=1", "output=2.000 slice_count=1 avoid"));
        W4Stk.kase("reslice", "reslice_u16", "reslice", f -> W4Stk.multi(f, () -> In.stack("stk16", 16, 37, 23, 6, 4), "Reslice [/]...",
            "output=1.000 start=Top avoid", "output=1.000 start=Left", "output=0.500 start=Top"));
        W4Stk.kase("reslice", "reslice_f32", "reslice", f -> W4Stk.multi(f, () -> In.stack("stk32", 32, 37, 23, 6, 5), "Reslice [/]...",
            "output=1.000 start=Top avoid", "output=1.000 start=Left", "output=0.500 start=Top"));
        W4Stk.kase("reslice", "reslice_rgb_stack", "reslice", f -> W4Stk.multi(f, () -> In.rgbStack("rgbs", 37, 23, 4, 3), "Reslice [/]...",
            "output=1.000 start=Top avoid", "output=1.000 start=Left"));
        W4Stk.kase("reslice", "reslice_hyper_composite", "reslice", f -> W4Stk.multi(f, () -> In.hyper("hyp", 16, 40, 30, 2, 3, 2, 2, true), "Reslice [/]...",
            "output=1.000 start=Top avoid", "output=1.000 start=Left avoid"));
        W4Stk.kase("reslice", "reslice_hyper_1c", "reslice", f -> W4Stk.multi(f, () -> In.hyper("hyp1", 16, 40, 30, 1, 4, 1, 2, false), "Reslice [/]...",
            "output=1.000 start=Top avoid", "output=1.000 start=Left avoid"));
        W4Stk.kase("reslice", "reslice_hyper_1c_2t", "reslice", f -> W4Stk.multi(f, () -> In.hyper("hyp1t", 16, 40, 30, 1, 3, 2, 2, false), "Reslice [/]...",
            "output=1.000 start=Top avoid"));
        W4Stk.kase("reslice", "reslice_hyper_1z", "reslice", f -> W4Stk.multi(f, () -> In.hyper("hypt", 16, 40, 30, 1, 1, 4, 2, false), "Reslice [/]...",
            "output=1.000 start=Top avoid"));
        W4Stk.kase("reslice", "reslice_hyper_composite_roi", "reslice", f -> W4Stk.multi(f, () -> withRoi(In.hyper("hyproi", 16, 40, 30, 2, 3, 2, 2, true), new Roi(3, 2, 16, 10)), "Reslice [/]...",
            "output=1.000 start=Top avoid"));
    }

    // ------------------------------------------------------------------ substack
    static void substack() {
        W4Stk.kase("substack", "substack_range", "substack", f -> W4Stk.multi(f, () -> labelled(In.stack("stk", 8, 37, 23, 8, 3)), "Make Substack...",
            "slices=2-4", "slices=1,3,5", "slices=1-8-3", "slices=3", "slices=7-8,1", "slices=5-2", "slices=2-4 delete", "slices=1,3,5 delete", "slices=2-4 do", "slices=2-4 delete do",
            "slices=0-3", "slices=6-12", "slices=9", "slices=1-8-1", "slices=2,2,4"));
        W4Stk.kase("substack", "substack_calibrated_u16", "substack", f -> W4Stk.multi(f, () -> { ImagePlus s = labelled(In.stack("stkc", 16, 37, 23, 6, 3)); In.calibrate(s); return s; }, "Make Substack...",
            "slices=2-4", "slices=1-6-2 delete"));
        W4Stk.kase("substack", "substack_hyper_make_substack", "substack", f -> W4Stk.multi(f, () -> In.hyper("hyp", 16, 40, 30, 2, 3, 2, 2, true), "Make Substack...",
            "channels=1-2 slices=2-3 frames=1-2", "channels=1 slices=1-3 frames=2", "channels=2 slices=2 frames=1", "channels=1-2 slices=1-3-2 frames=1,2", "channels=2,1 slices=1 frames=1"));
        W4Stk.kase("substack", "substack_hyper_make_subset", "substack", f -> W4Stk.multi(f, () -> In.hyper("hyp", 16, 40, 30, 2, 3, 2, 2, true), "Make Subset...",
            "channels=1-2 slices=2-3 frames=1-2", "channels=2 slices=1-3 frames=2", "channels=1 slices=3 frames=1-2", "channels=1-2 slices=1-3-2 frames=1,2"));
        W4Stk.kase("substack", "substack_hyper_calibrated_color", "substack", f -> W4Stk.multi(f, () -> { ImagePlus h = In.hyper("hypc", 16, 40, 30, 3, 3, 2, 6, true); In.calibrate(h); ((CompositeImage) h).setMode(IJ.COLOR); return h; }, "Make Subset...",
            "channels=1-2 slices=2-3 frames=2", "channels=3 slices=1-3 frames=1-2"));
        W4Stk.kase("substack", "substack_hyper_1c", "substack", f -> W4Stk.multi(f, () -> In.hyper("hyp1", 16, 40, 30, 1, 4, 3, 2, false), "Make Substack...",
            "channels=1 slices=2-3 frames=1-2", "channels=1 slices=1-4-3 frames=3"));
        W4Stk.kase("substack", "substack_hyper_ranges_current_position", "substack", f -> W4Stk.multi(f, () -> { ImagePlus h = In.hyper("hyppos", 16, 40, 30, 2, 3, 2, 7, true); h.setPosition(2, 3, 2); return h; }, "Make Subset...",
            "channels=1-2 slices=1-2 frames=2"));
        W4Stk.kase("substack", "substack_rgb_stack", "substack", f -> W4Stk.multi(f, () -> In.rgbStack("rgbs", 37, 23, 5, 3), "Make Substack...", "slices=2-4", "slices=1,5"));
        W4Stk.kase("substack", "substack_plain_from_stack_with_nc", "substack", f -> W4Stk.multi(f, () -> labelled(In.stack("s12", 8, 37, 23, 12, 3)), "Make Substack...", "slices=4-9", "slices=1-12-4"));
    }

    static ImagePlus labelled(ImagePlus s) {
        for (int i = 1; i <= s.getStackSize(); i++) s.getStack().setSliceLabel("slice " + i, i);
        return s;
    }

    // ------------------------------------------------------------------ reduce
    static void reduce() {
        W4Stk.kase("reduce", "reduce_stack", "reduce", f -> W4Stk.multi(f, () -> labelled(In.stack("stk", 8, 37, 23, 9, 3)), "Reduce...",
            "reduction=2", "reduction=3", "reduction=4", "reduction=1", "reduction=9", "reduction=10", "reduction=2 reduce"));
        W4Stk.kase("reduce", "reduce_stack_calibrated_u16", "reduce", f -> W4Stk.multi(f, () -> { ImagePlus s = labelled(In.stack("stkc", 16, 37, 23, 8, 3)); In.calibrate(s); return s; }, "Reduce...", "reduction=2", "reduction=3"));
        W4Stk.kase("reduce", "reduce_stack_even_odd", "reduce", f -> W4Stk.multi(f, () -> labelled(In.stack("stk7", 8, 37, 23, 7, 3)), "Reduce...", "reduction=2", "reduction=3"));
        W4Stk.kase("reduce", "reduce_hyper_frames_default", "reduce", f -> W4Stk.multi(f, () -> In.hyper("hyp", 16, 40, 30, 2, 4, 5, 2, true), "Reduce...",
            "reduction=2", "reduction=3", "reduction=2 reduce", "reduction=3 reduce"));
        W4Stk.kase("reduce", "reduce_hyper_calibrated", "reduce", f -> W4Stk.multi(f, () -> { ImagePlus h = In.hyper("hypc", 16, 40, 30, 2, 4, 4, 3, true); In.calibrate(h); return h; }, "Reduce...",
            "reduction=2", "reduction=2 reduce"));
        W4Stk.kase("reduce", "reduce_hyper_only_z", "reduce", f -> W4Stk.multi(f, () -> In.hyper("hypz", 16, 40, 30, 2, 6, 1, 3, true), "Reduce...", "reduction=2", "reduction=2 reduce"));
        W4Stk.kase("reduce", "reduce_hyper_only_t", "reduce", f -> W4Stk.multi(f, () -> In.hyper("hypt", 16, 40, 30, 1, 1, 6, 3, false), "Reduce...", "reduction=2", "reduction=3"));
        W4Stk.kase("reduce", "reduce_rgb_stack", "reduce", f -> W4Stk.multi(f, () -> In.rgbStack("rgbs", 37, 23, 6, 3), "Reduce...", "reduction=2"));
    }

    // ------------------------------------------------------------------ reverse
    static void reverse() {
        W4Stk.kase("reverse", "reverse_stack", "reverse", f -> W4Stk.multi(f, () -> labelled(In.stack("stk", 8, 37, 23, 5, 3)), "Reverse", ""));
        W4Stk.kase("reverse", "reverse_stack_calibrated_f32", "reverse", f -> W4Stk.multi(f, () -> { ImagePlus s = labelled(In.stack("stk32", 32, 37, 23, 4, 3)); In.calibrate(s); return s; }, "Reverse", ""));
        W4Stk.kase("reverse", "reverse_hyper", "reverse", f -> W4Stk.multi(f, () -> In.hyper("hyp", 16, 40, 30, 2, 3, 2, 2, true), "Reverse", ""));
        W4Stk.kase("reverse", "reverse_hyper_1c_nt", "reverse", f -> W4Stk.multi(f, () -> In.hyper("hypt", 16, 40, 30, 1, 3, 3, 2, false), "Reverse", ""));
        W4Stk.kase("reverse", "reverse_rgb_stack", "reverse", f -> W4Stk.multi(f, () -> In.rgbStack("rgbs", 37, 23, 3, 3), "Reverse", ""));
        W4Stk.kase("reverse", "reverse_current_slice", "reverse", f -> W4Stk.multi(f, () -> { ImagePlus s = labelled(In.stack("stkp", 8, 37, 23, 5, 3)); s.setSlice(2); return s; }, "Reverse", ""));
    }

    // ------------------------------------------------------------------ concat, insert, combine, grouped
    static void concat() {
        W4Stk.kase("concat", "concatenate_stacks", "concatenate", f -> multiN(f, () -> new ImagePlus[]{labelled(In.stack("s1", 8, 37, 23, 4, 1)), labelled(In.stack("s2", 8, 37, 23, 3, 9))}, "Concatenate...",
            "  title=cat image1=s1 image2=s2 image3=[-- None --]", "  title=cat image1=s1 image2=s2 image3=[-- None --] open", "  title=cat keep image1=s1 image2=s2 image3=[-- None --]",
            "  title=cat image1=s2 image2=s1 image3=[-- None --]", "all title=cat open", "all title=cat"));
        W4Stk.kase("concat", "concatenate_three", "concatenate", f -> multiN(f, () -> new ImagePlus[]{In.stack("s1", 8, 37, 23, 2, 1), In.stack("s2", 8, 37, 23, 2, 9), In.stack("s3", 8, 37, 23, 2, 17)}, "Concatenate...",
            "  title=cat image1=s1 image2=s2 image3=s3 image4=[-- None --]", "  title=cat image1=s1 image2=s2 image3=s3 image4=[-- None --] open", "all title=cat"));
        W4Stk.kase("concat", "concatenate_hyperstacks", "concatenate", f -> multiN(f, () -> new ImagePlus[]{In.hyper("h1", 16, 40, 30, 2, 3, 2, 2, true), In.hyper("h2", 16, 40, 30, 2, 3, 2, 8, true)}, "Concatenate...",
            "  title=cat image1=h1 image2=h2 image3=[-- None --] open", "  title=cat image1=h1 image2=h2 image3=[-- None --]"));
        W4Stk.kase("concat", "concatenate_hyper_nt", "concatenate", f -> multiN(f, () -> new ImagePlus[]{In.hyper("h1", 16, 40, 30, 1, 1, 3, 2, false), In.hyper("h2", 16, 40, 30, 1, 1, 2, 8, false)}, "Concatenate...",
            "  title=cat image1=h1 image2=h2 image3=[-- None --] open", "  title=cat image1=h1 image2=h2 image3=[-- None --]"));
        W4Stk.kase("concat", "concatenate_mismatch", "concatenate", f -> multiN(f, () -> new ImagePlus[]{In.stack("s1", 8, 37, 23, 3, 1), In.stack("s2", 8, 30, 20, 3, 9)}, "Concatenate...",
            "  title=cat image1=s1 image2=s2 image3=[-- None --]"));
        W4Stk.kase("concat", "concatenate_types", "concatenate", f -> multiN(f, () -> new ImagePlus[]{In.stack("s1", 8, 37, 23, 3, 1), In.stack("s2", 16, 37, 23, 3, 9)}, "Concatenate...",
            "  title=cat image1=s1 image2=s2 image3=[-- None --]"));
        W4Stk.kase("concat", "concatenate_single_images", "concatenate", f -> multiN(f, () -> new ImagePlus[]{In.image("a", 8, 37, 23, 1), In.image("b", 8, 37, 23, 2), In.image("c", 8, 37, 23, 3)}, "Concatenate...",
            "  title=cat image1=a image2=b image3=c image4=[-- None --]", "all title=cat"));

        W4Stk.kase("concat", "insert", "insert", f -> multiN(f, () -> new ImagePlus[]{labelled(In.stack("big", 8, 37, 23, 4, 1)), labelled(In.stack("small", 8, 12, 9, 2, 9))}, "Insert...",
            "source=small destination=big x=5 y=3", "source=small destination=big x=30 y=20", "source=small destination=big x=-4 y=-2", "source=small destination=big x=0 y=0"));
        W4Stk.kase("concat", "insert_single", "insert", f -> multiN(f, () -> new ImagePlus[]{In.stack("big", 16, 37, 23, 3, 1), In.image("sm", 16, 10, 8, 9)}, "Insert...",
            "source=sm destination=big x=5 y=3"));
        W4Stk.kase("concat", "insert_types", "insert", f -> multiN(f, () -> new ImagePlus[]{In.stack("big", 16, 37, 23, 3, 1), In.stack("sm", 8, 10, 8, 3, 9)}, "Insert...",
            "source=sm destination=big x=5 y=3"));
        W4Stk.kase("concat", "insert_more_slices", "insert", f -> multiN(f, () -> new ImagePlus[]{In.stack("big", 8, 37, 23, 2, 1), In.stack("sm", 8, 10, 8, 4, 9)}, "Insert...",
            "source=sm destination=big x=5 y=3"));

        W4Stk.kase("concat", "combine", "combine", f -> multiN(f, () -> new ImagePlus[]{labelled(In.stack("s1", 8, 37, 23, 4, 1)), labelled(In.stack("s2", 8, 37, 23, 3, 9))}, "Combine...",
            "stack1=s1 stack2=s2", "stack1=s1 stack2=s2 combine", "stack1=s2 stack2=s1", "stack1=s2 stack2=s1 combine"));
        W4Stk.kase("concat", "combine_sizes", "combine", f -> multiN(f, () -> new ImagePlus[]{In.stack("s1", 8, 37, 23, 3, 1), In.stack("s2", 8, 20, 30, 3, 9)}, "Combine...",
            "stack1=s1 stack2=s2", "stack1=s1 stack2=s2 combine"));
        W4Stk.kase("concat", "combine_types", "combine", f -> multiN(f, () -> new ImagePlus[]{In.stack("s1", 16, 37, 23, 3, 1), In.stack("s2", 16, 20, 30, 2, 9)}, "Combine...",
            "stack1=s1 stack2=s2", "stack1=s1 stack2=s2 combine"));
        W4Stk.kase("concat", "combine_calibrated", "combine", f -> multiN(f, () -> new ImagePlus[]{cal(In.stack("s1", 8, 37, 23, 3, 1), 0.5, 0.5, 2.0), cal(In.stack("s2", 8, 37, 23, 3, 9), 0.5, 0.5, 2.0)}, "Combine...",
            "stack1=s1 stack2=s2"));
        W4Stk.kase("concat", "combine_rgb", "combine", f -> multiN(f, () -> new ImagePlus[]{In.rgbStack("s1", 37, 23, 2, 1), In.rgbStack("s2", 37, 23, 2, 9)}, "Combine...",
            "stack1=s1 stack2=s2"));

        W4Stk.kase("concat", "grouped_z_project", "groupedZProject", f -> W4Stk.multi(f, () -> labelled(In.stack("stk", 8, 37, 23, 6, 3)), "Grouped Z Project...",
            "projection=[Average Intensity] group=2", "projection=[Max Intensity] group=3", "projection=[Min Intensity] group=2", "projection=[Sum Slices] group=3", "projection=[Standard Deviation] group=2", "projection=[Median] group=3",
            "projection=[Max Intensity] group=6", "projection=[Max Intensity] group=1", "projection=[Max Intensity] group=4", "projection=[Max Intensity] group=7"));
        W4Stk.kase("concat", "grouped_z_project_u16", "groupedZProject", f -> W4Stk.multi(f, () -> { ImagePlus s = In.stack("stk16", 16, 37, 23, 6, 3); In.calibrate(s); return s; }, "Grouped Z Project...",
            "projection=[Average Intensity] group=3", "projection=[Sum Slices] group=2", "projection=[Max Intensity] group=2"));
        W4Stk.kase("concat", "grouped_z_project_f32", "groupedZProject", f -> W4Stk.multi(f, () -> In.stack("stk32", 32, 37, 23, 6, 3), "Grouped Z Project...",
            "projection=[Average Intensity] group=2", "projection=[Standard Deviation] group=3"));
        W4Stk.kase("concat", "grouped_z_project_hyper", "groupedZProject", f -> W4Stk.multi(f, () -> In.hyper("hyp", 16, 40, 30, 2, 4, 2, 2, true), "Grouped Z Project...",
            "projection=[Max Intensity] group=2", "projection=[Average Intensity] group=4"));
    }

    // ------------------------------------------------------------------ montage, montage to stack
    static void montage() {
        W4Stk.kase("montage", "montage_u8", "montage", f -> W4Stk.multi(f, () -> labelled(In.stack("stk", 8, 37, 23, 6, 3)), "Make Montage...",
            "columns=3 rows=2 scale=1 first=1 last=6 increment=1 border=0 font=12",
            "columns=3 rows=2 scale=0.5 first=1 last=6 increment=1 border=0 font=12",
            "columns=2 rows=2 scale=1 first=1 last=6 increment=1 border=0 font=12",
            "columns=3 rows=2 scale=1 first=2 last=6 increment=2 border=0 font=12",
            "columns=3 rows=2 scale=1 first=1 last=6 increment=1 border=2 font=12",
            "columns=3 rows=2 scale=1 first=1 last=6 increment=1 border=2 font=12 use",
            "columns=4 rows=2 scale=1 first=1 last=6 increment=1 border=0 font=12",
            "columns=3 rows=2 scale=2 first=1 last=6 increment=1 border=0 font=12",
            "columns=3 rows=2 scale=0.33 first=1 last=6 increment=1 border=1 font=12",
            "columns=1 rows=6 scale=1 first=1 last=6 increment=1 border=0 font=12",
            "columns=6 rows=1 scale=1 first=3 last=5 increment=1 border=0 font=12"));
        W4Stk.kase("montage", "montage_u16_f32", "montage", f -> W4Stk.multi(f, () -> In.stack("stk16", 16, 37, 23, 4, 3), "Make Montage...",
            "columns=2 rows=2 scale=1 first=1 last=4 increment=1 border=0 font=12", "columns=2 rows=2 scale=0.5 first=1 last=4 increment=1 border=3 font=12"));
        W4Stk.kase("montage", "montage_f32", "montage", f -> W4Stk.multi(f, () -> In.stack("stk32", 32, 37, 23, 4, 3), "Make Montage...",
            "columns=2 rows=2 scale=1 first=1 last=4 increment=1 border=0 font=12", "columns=2 rows=2 scale=0.5 first=1 last=4 increment=1 border=3 font=12"));
        W4Stk.kase("montage", "montage_calibrated", "montage", f -> W4Stk.multi(f, () -> { ImagePlus s = In.stack("stkc", 8, 37, 23, 4, 3); In.calibrate(s); return s; }, "Make Montage...",
            "columns=2 rows=2 scale=1 first=1 last=4 increment=1 border=0 font=12", "columns=2 rows=2 scale=0.5 first=1 last=4 increment=1 border=0 font=12"));
        W4Stk.kase("montage", "montage_rgb_stack", "montage", f -> W4Stk.multi(f, () -> In.rgbStack("rgbs", 37, 23, 4, 3), "Make Montage...",
            "columns=2 rows=2 scale=1 first=1 last=4 increment=1 border=0 font=12", "columns=2 rows=2 scale=1 first=1 last=4 increment=1 border=2 font=12"));
        W4Stk.kase("montage", "montage_composite_one_slice", "montage", f -> W4Stk.multi(f, () -> In.hyper("comp", 16, 40, 30, 3, 1, 1, 2, true), "Make Montage...",
            "columns=3 rows=1 scale=1 first=1 last=3 increment=1 border=0 font=12", "columns=2 rows=2 scale=1 first=1 last=3 increment=1 border=0 font=12"));
        W4Stk.kase("montage", "montage_hyper_composite_multi", "montage", f -> W4Stk.multi(f, () -> In.hyper("hyp", 16, 40, 30, 2, 3, 2, 2, true), "Make Montage...",
            "columns=2 rows=2 scale=1 first=1 last=12 increment=1 border=0 font=12"));
        W4Stk.kase("montage", "montage_hyper_1c_z", "montage", f -> W4Stk.multi(f, () -> In.hyper("hz", 16, 40, 30, 1, 4, 1, 2, false), "Make Montage...",
            "columns=2 rows=2 scale=1 first=1 last=4 increment=1 border=0 font=12"));
        W4Stk.kase("montage", "montage_hyper_1c_t", "montage", f -> W4Stk.multi(f, () -> In.hyper("ht", 16, 40, 30, 1, 1, 4, 2, false), "Make Montage...",
            "columns=2 rows=2 scale=1 first=1 last=4 increment=1 border=0 font=12"));
        W4Stk.kase("montage", "montage_composite_color_mode", "montage", f -> W4Stk.multi(f, () -> { ImagePlus h = In.hyper("comp", 16, 40, 30, 3, 1, 1, 2, true); ((CompositeImage) h).setMode(IJ.COLOR); return h; }, "Make Montage...",
            "columns=3 rows=1 scale=1 first=1 last=3 increment=1 border=0 font=12"));

        // montage to stack: a 60 x 40 image cut into columns x rows tiles
        W4Stk.kase("montage", "montage_to_stack", "montageToStack", f -> W4Stk.multi(f, () -> In.image("montage", 8, 60, 40, 5), "Montage to Stack...",
            "columns=3 rows=2 border=0", "columns=2 rows=2 border=0", "columns=3 rows=2 border=1", "columns=1 rows=1 border=0", "columns=4 rows=3 border=0", "columns=7 rows=1 border=0"));
        W4Stk.kase("montage", "montage_to_stack_u16", "montageToStack", f -> W4Stk.multi(f, () -> { ImagePlus s = In.image("montage16", 16, 60, 40, 6); In.calibrate(s); return s; }, "Montage to Stack...", "columns=3 rows=2 border=0"));
        W4Stk.kase("montage", "montage_to_stack_rgb", "montageToStack", f -> W4Stk.multi(f, () -> In.rgbImage("montagergb", 60, 40, 5), "Montage to Stack...", "columns=3 rows=2 border=0"));
        W4Stk.kase("montage", "montage_to_stack_roundtrip", "montageToStack", f -> {
            // Make Montage with a 2px border, then Montage to Stack with the same border: the tiles come back
            ImagePlus s = In.stack("stk", 8, 20, 15, 4, 3);
            s.show();
            W4Stk.run1(s, "Make Montage...", "columns=2 rows=2 scale=1 first=1 last=4 increment=1 border=2 font=12");
            ImagePlus m = ij.macro.Interpreter.getLastBatchModeImage();
            if (m == null || m == s) throw new IllegalStateException("no montage");
            f.put("montage", Stk.stack(m));
            Map<String, Object> r = W4Stk.run1(m, "Montage to Stack...", "columns=2 rows=2 border=2");
            f.put("options", "columns=2 rows=2 border=2");
            for (Map.Entry<String, Object> e : r.entrySet()) f.put(e.getKey(), e.getValue());
        });
    }
}
