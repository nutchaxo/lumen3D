import ij.*;
import ij.gui.*;
import ij.measure.*;
import ij.plugin.filter.Analyzer;
import ij.process.*;
import java.util.*;
import java.util.function.Supplier;

/** zprofile (Plot Z-axis Profile), stats (Statistics, Measure Stack..., Measure with Stack position), labels (Label...), slices (Add/Delete/Set Slice, Images to Stack...). */
final class W4Ana {
    static final String ALL = "area mean standard modal min centroid center perimeter bounding fit shape feret's integrated median skewness kurtosis area_fraction stack display redirect=None decimal=3";
    static final String DEFAULT = "area mean min redirect=None decimal=3";

    static void setMeasurements(String s) { IJ.run("Set Measurements...", s); }

    static ImagePlus roi(ImagePlus i, Roi r) { i.setRoi(r); return i; }

    // ------------------------------------------------------------------ zprofile
    /** The plot's x / y arrays of a "Plot Z-axis Profile" run (the plot picture itself is font-dependent and not recorded). */
    static Map<String, Object> plotRun(ImagePlus cur, String opts) {
        List<Integer> before = W4Stk.ids();
        ResultsTable.getResultsTable().reset();
        W4Dlg.unexpected.clear();
        W4Dlg.guard = true;
        String thrown = null;
        try { IJ.run(cur, "Plot Z-axis Profile", opts); } catch (Throwable e) { thrown = e.getClass().getSimpleName() + ": " + e.getMessage(); }
        finally { W4Dlg.guard = false; }
        LinkedHashMap<String, Object> r = new LinkedHashMap<>();
        r.put("options", opts);
        List<Object> plots = new ArrayList<>();
        for (int id : W4Stk.ids()) if (!before.contains(id)) {
            ImagePlus p = WindowManager.getImage(id);
            if (p == null) continue;
            Object o = p.getProperty(Plot.PROPERTY_KEY);
            if (o instanceof Plot) {
                Plot pl = (Plot) o;
                plots.add(J.o("title", p.getTitle(), "x", pl.getXValues(), "y", pl.getYValues(), "limits", pl.getLimits()));
            } else plots.add(J.o("title", p.getTitle(), "noPlot", true));
        }
        r.put("plots", plots);
        ResultsTable rt = ResultsTable.getResultsTable();
        if (rt != null && rt.size() > 0) r.put("table", Stk.table(rt));
        if (!W4Dlg.unexpected.isEmpty()) r.put("dialogs", new ArrayList<Object>(W4Dlg.unexpected));
        if (thrown != null) r.put("thrown", thrown);
        return r;
    }

    static void plotCase(String name, Supplier<ImagePlus> mk, String... opts) {
        W4Stk.kase("zprofile", name, "zAxisProfile", f -> {
            f.put("command", "Plot Z-axis Profile");
            ImagePlus first = mk.get();
            f.put("input", Stk.stack(first));
            if (first.getRoi() != null) f.put("roi", Stk.roi(first.getRoi()));
            List<Object> cases = new ArrayList<>();
            for (String o : opts) {
                ImagePlus cur = mk.get();
                cur.show();
                cases.add(plotRun(cur, o));
                W4Stk.closeAll();
            }
            f.put("cases", cases);
        });
    }

    static void zprofile() {
        plotCase("zaxis_u8_no_roi", () -> In.stack("stk", 8, 37, 23, 5, 3), "");
        plotCase("zaxis_u8_rect", () -> roi(In.stack("stk", 8, 37, 23, 5, 3), new Roi(4, 3, 16, 10)), "");
        plotCase("zaxis_u8_oval", () -> roi(In.stack("stk", 8, 37, 23, 5, 3), new OvalRoi(4, 3, 16, 10)), "");
        plotCase("zaxis_u8_polygon", () -> roi(In.stack("stk", 8, 37, 23, 5, 3), new PolygonRoi(new float[]{4, 22, 14}, new float[]{3, 8, 14}, Roi.POLYGON)), "");
        plotCase("zaxis_u8_line", () -> roi(In.stack("stk", 8, 37, 23, 5, 3), new Line(3, 3, 22, 13)), "");
        plotCase("zaxis_u16_rect", () -> roi(In.stack("stk16", 16, 37, 23, 5, 4), new Roi(4, 3, 16, 10)), "");
        plotCase("zaxis_f32_rect", () -> roi(In.stack("stk32", 32, 37, 23, 5, 5), new Roi(4, 3, 16, 10)), "");
        plotCase("zaxis_f32_nan", () -> {
            ImagePlus s = In.stack("stkn", 32, 37, 23, 4, 5);
            ((float[]) s.getStack().getProcessor(2).getPixels())[5 * 37 + 8] = Float.NaN;
            return roi(s, new Roi(4, 3, 16, 10));
        }, "");
        plotCase("zaxis_calibrated_stack", () -> roi(In.calibrate2(In.stack("stkc", 16, 37, 23, 5, 4)), new Roi(4, 3, 16, 10)), "");
        plotCase("zaxis_rgb_stack", () -> roi(In.rgbStack("rgbs", 37, 23, 4, 3), new Roi(4, 3, 16, 10)), "");
        plotCase("zaxis_hyper_z_and_t", () -> roi(In.hyper("hyp", 16, 40, 30, 2, 3, 2, 2, true), new Roi(4, 3, 16, 10)), "profile=z-axis", "profile=time", "");
        plotCase("zaxis_hyper_t_calibrated", () -> roi(In.calibrate2(In.hyper("hypt", 16, 40, 30, 1, 1, 5, 2, false)), new Roi(4, 3, 16, 10)), "");
        plotCase("zaxis_hyper_z_only", () -> roi(In.hyper("hypz", 16, 40, 30, 2, 4, 1, 2, true), new Roi(4, 3, 16, 10)), "");
        plotCase("zaxis_hyper_second_channel", () -> { ImagePlus h = In.hyper("hypc", 16, 40, 30, 2, 4, 1, 2, true); h.setPosition(2, 1, 1); return roi(h, new Roi(4, 3, 16, 10)); }, "");
        plotCase("zaxis_single_image", () -> In.image("img", 8, 37, 23, 3), "");
    }

    // ------------------------------------------------------------------ stats
    static void statsCase(String name, String measure, Supplier<ImagePlus> mk, String command, String... opts) {
        W4Stk.kase("stats", name, command.equals("Statistics") ? "stackStatistics" : "measureStack", f -> {
            setMeasurements(measure);
            f.put("setMeasurements", measure);
            W4Stk.multi(f, mk, command, opts);
        });
    }

    static void stats() {
        // Image > Stacks > Statistics: the Results row(s) of a whole stack (ImageStatistics of every slice together)
        statsCase("stackstats_u8", ALL, () -> In.stack("stk", 8, 37, 23, 5, 3), "Statistics", "");
        statsCase("stackstats_u8_rect", ALL, () -> roi(In.stack("stk", 8, 37, 23, 5, 3), new Roi(4, 3, 16, 10)), "Statistics", "");
        statsCase("stackstats_u8_oval", ALL, () -> roi(In.stack("stk", 8, 37, 23, 5, 3), new OvalRoi(4, 3, 16, 10)), "Statistics", "");
        statsCase("stackstats_u16", ALL, () -> In.stack("stk16", 16, 37, 23, 5, 4), "Statistics", "");
        statsCase("stackstats_u16_rect", ALL, () -> roi(In.stack("stk16", 16, 37, 23, 5, 4), new Roi(4, 3, 16, 10)), "Statistics", "");
        statsCase("stackstats_f32", ALL, () -> In.stack("stk32", 32, 37, 23, 5, 5), "Statistics", "");
        statsCase("stackstats_f32_nan", ALL, () -> {
            ImagePlus s = In.stack("stkn", 32, 37, 23, 4, 5);
            ((float[]) s.getStack().getProcessor(2).getPixels())[5 * 37 + 8] = Float.NaN;
            return s;
        }, "Statistics", "");
        statsCase("stackstats_calibrated", ALL, () -> In.calibrate2(In.stack("stkc", 16, 37, 23, 5, 4)), "Statistics", "");
        statsCase("stackstats_calibrated_rect", ALL, () -> roi(In.calibrate2(In.stack("stkc", 8, 37, 23, 5, 4)), new Roi(4, 3, 16, 10)), "Statistics", "");
        statsCase("stackstats_default_measurements", DEFAULT, () -> In.stack("stk", 8, 37, 23, 5, 3), "Statistics", "");
        statsCase("stackstats_hyper", ALL, () -> In.hyper("hyp", 16, 40, 30, 2, 3, 2, 2, true), "Statistics", "");
        statsCase("stackstats_hyper_position", ALL, () -> { ImagePlus h = In.hyper("hyp", 16, 40, 30, 2, 3, 2, 2, true); h.setPosition(2, 2, 2); return h; }, "Statistics", "");
        statsCase("stackstats_rgb", ALL, () -> In.rgbStack("rgbs", 37, 23, 4, 3), "Statistics", "");
        statsCase("stackstats_threshold_limit", ALL + " limit", () -> {
            ImagePlus s = In.stack("stkt", 8, 37, 23, 5, 3);
            s.getProcessor().setThreshold(60, 200, ImageProcessor.NO_LUT_UPDATE);
            return s;
        }, "Statistics", "");

        // Image > Stacks > Measure Stack...: every slice measured with the selection (Slice / Ch / Frame via Stack position)
        statsCase("measurestack_u8_rect", ALL, () -> roi(In.stack("stk", 8, 37, 23, 4, 3), new Roi(4, 3, 16, 10)), "Measure Stack...", "");
        statsCase("measurestack_u8_oval_default", DEFAULT + " stack display", () -> roi(In.stack("stk", 8, 37, 23, 4, 3), new OvalRoi(4, 3, 16, 10)), "Measure Stack...", "");
        statsCase("measurestack_u8_no_roi", "area mean min stack display redirect=None decimal=3", () -> In.stack("stk", 8, 37, 23, 4, 3), "Measure Stack...", "");
        statsCase("measurestack_u8_no_stack_position", DEFAULT, () -> roi(In.stack("stk", 8, 37, 23, 4, 3), new Roi(4, 3, 16, 10)), "Measure Stack...", "");
        statsCase("measurestack_u16_calibrated", "area mean standard min stack display redirect=None decimal=3", () -> roi(In.calibrate2(In.stack("stkc", 16, 37, 23, 4, 3)), new Roi(4, 3, 16, 10)), "Measure Stack...", "");
        statsCase("measurestack_f32", "area mean standard min stack display redirect=None decimal=3", () -> roi(In.stack("stk32", 32, 37, 23, 4, 3), new Roi(4, 3, 16, 10)), "Measure Stack...", "");
        statsCase("measurestack_labels", "area mean min stack display redirect=None decimal=3", () -> roi(W4Ops.labelled(In.stack("stkl", 8, 37, 23, 4, 3)), new Roi(4, 3, 16, 10)), "Measure Stack...", "");
        statsCase("measurestack_hyper", "area mean min stack display redirect=None decimal=3", () -> roi(In.hyper("hyp", 16, 40, 30, 2, 3, 2, 2, true), new Roi(4, 3, 16, 10)), "Measure Stack...", "channels slices frames", "slices frames", "channels frames", "channels slices", "channels", "slices", "frames", "keep");
        statsCase("measurestack_hyper_1c_t", "area mean min stack display redirect=None decimal=3", () -> roi(In.hyper("hypt", 16, 40, 30, 1, 1, 3, 2, false), new Roi(4, 3, 16, 10)), "Measure Stack...", "");
        statsCase("measurestack_rgb", "area mean min stack display redirect=None decimal=3", () -> roi(In.rgbStack("rgbs", 37, 23, 3, 3), new Roi(4, 3, 16, 10)), "Measure Stack...", "");
        statsCase("measurestack_threshold_limit", "area mean min limit stack display redirect=None decimal=3", () -> {
            ImagePlus s = roi(In.stack("stkt", 8, 37, 23, 4, 3), new Roi(4, 3, 16, 10));
            s.getProcessor().setThreshold(60, 200, ImageProcessor.NO_LUT_UPDATE);
            return s;
        }, "Measure Stack...", "");

        // Measure (current plane only) with Stack position / Display label on a stack and a hyperstack
        statsCase("measure_stack_position_stack", "area mean min stack display redirect=None decimal=3", () -> { ImagePlus s = roi(W4Ops.labelled(In.stack("stk", 8, 37, 23, 4, 3)), new Roi(4, 3, 16, 10)); s.setSlice(3); return s; }, "Measure", "");
        statsCase("measure_stack_position_hyper", "area mean min stack display redirect=None decimal=3", () -> { ImagePlus h = roi(In.hyper("hyp", 16, 40, 30, 2, 3, 2, 2, true), new Roi(4, 3, 16, 10)); h.setPosition(2, 2, 2); return h; }, "Measure", "");
        statsCase("measure_stack_position_hyper_1c", "area mean min stack display redirect=None decimal=3", () -> { ImagePlus h = roi(In.hyper("hyp1", 16, 40, 30, 1, 3, 2, 2, false), new Roi(4, 3, 16, 10)); h.setPosition(1, 3, 2); return h; }, "Measure", "");
        statsCase("measure_display_label_single", "area mean min display redirect=None decimal=3", () -> roi(In.image("img", 8, 37, 23, 3), new Roi(4, 3, 16, 10)), "Measure", "");
        statsCase("measure_display_label_stack_labelled", "area mean min display redirect=None decimal=3", () -> { ImagePlus s = roi(W4Ops.labelled(In.stack("stkl", 8, 37, 23, 3, 3)), new Roi(4, 3, 16, 10)); s.setSlice(2); return s; }, "Measure", "");
        statsCase("measure_display_label_stack_unlabelled", "area mean min display redirect=None decimal=3", () -> { ImagePlus s = roi(In.stack("stku", 8, 37, 23, 3, 3), new Roi(4, 3, 16, 10)); s.setSlice(2); return s; }, "Measure", "");
        statsCase("measure_rgb", ALL, () -> roi(In.rgbImage("rgb", 37, 23, 3), new Roi(4, 3, 16, 10)), "Measure", "");
        setMeasurements(DEFAULT);
    }

    // ------------------------------------------------------------------ labels
    static void labelCase(String name, Supplier<ImagePlus> mk, String... opts) {
        W4Stk.kase("labels", name, "stackLabeler", f -> {
            f.put("command", "Label...");
            ImagePlus first = mk.get();
            f.put("input", Stk.stack(first));
            List<Object> cases = new ArrayList<>();
            for (String o : opts) {
                ImagePlus cur = mk.get();
                cur.show();
                int n = cur.getStackSize();
                String[] before = new String[n];
                for (int i = 1; i <= n; i++) before[i - 1] = J.val(Stk.plane(cur.getStack().getProcessor(i)));
                Map<String, Object> r = W4Stk.run1(cur, "Label...", o);
                LinkedHashMap<String, Object> c = new LinkedHashMap<>();
                c.put("options", o);
                List<Integer> changed = new ArrayList<>();
                try {
                    for (int i = 1; i <= cur.getStackSize() && i <= n; i++) if (!J.val(Stk.plane(cur.getStack().getProcessor(i))).equals(before[i - 1])) changed.add(i);
                } catch (Throwable ignore) { }
                c.put("changedSlices", changed);
                c.put("stackSize", cur.getStackSize());
                Overlay ov = cur.getOverlay();
                List<Object> items = new ArrayList<>();
                if (ov != null) for (int i = 0; i < ov.size(); i++) {
                    Roi e = ov.get(i);
                    items.add(J.o("class", e.getClass().getSimpleName(), "position", e.getPosition(), "c", e.getCPosition(), "z", e.getZPosition(), "t", e.getTPosition(), "name", e.getName(), "text", e instanceof TextRoi ? ((TextRoi) e).getText() : null,
                        "x", e.getBounds().x, "y", e.getBounds().y));
                }
                c.put("overlay", items);
                // slice labels left on the stack (a Label format does not touch them)
                for (String k : new String[]{"thrown", "dialogs", "log"}) if (r.containsKey(k)) c.put(k, r.get(k));
                cases.add(c);
                W4Stk.closeAll();
            }
            f.put("cases", cases);
        });
    }

    static void labels() {
        String base = " x=5 y=20 font=18 text=[] range=1-4";
        labelCase("label_formats_overlay", () -> In.stack("stk", 8, 37, 23, 4, 3),
            "format=0 starting=0 interval=1" + base + " use", "format=0000 starting=0 interval=1" + base + " use", "format=00:00 starting=0 interval=1" + base + " use",
            "format=00:00:00 starting=0 interval=1" + base + " use", "format=Text starting=0 interval=1 x=5 y=20 font=18 text=abc range=1-4 use",
            "format=Label starting=0 interval=1" + base + " use", "format=0 starting=5 interval=2" + base + " use", "format=0 starting=0 interval=0.5" + base + " use",
            "format=0000 starting=10 interval=15" + base + " use", "format=00:00 starting=0 interval=30" + base + " use", "format=00:00:00 starting=0 interval=1500" + base + " use",
            "format=0 starting=0 interval=1 x=5 y=20 font=18 text=[] range=2-3 use", "format=0 starting=0 interval=1 x=5 y=20 font=18 text=[] range=1-4-2 use",
            "format=0 starting=0 interval=1 x=5 y=20 font=18 text=[] range=6-9 use");
        labelCase("label_formats_labelled_stack", () -> W4Ops.labelled(In.stack("stkl", 8, 37, 23, 4, 3)), "format=Label starting=0 interval=1" + base + " use", "format=Text starting=0 interval=1 x=5 y=20 font=18 text=hello range=1-4 use");
        labelCase("label_burned_in_pixels", () -> In.stack("stk", 8, 37, 23, 4, 3), "format=0 starting=0 interval=1" + base, "format=0 starting=0 interval=1 x=5 y=20 font=18 text=[] range=2-3",
            "format=Text starting=0 interval=1 x=5 y=20 font=18 text=ab range=1-4");
        labelCase("label_burned_16bit_f32", () -> In.stack("stk16", 16, 37, 23, 4, 3), "format=0 starting=0 interval=1" + base);
        labelCase("label_burned_f32", () -> In.stack("stk32", 32, 37, 23, 4, 3), "format=0 starting=0 interval=1" + base);
        labelCase("label_burned_rgb", () -> In.rgbStack("rgbs", 37, 23, 4, 3), "format=0 starting=0 interval=1" + base);
        labelCase("label_calibrated_frame_interval", () -> { ImagePlus s = In.stack("stkc", 8, 37, 23, 4, 3); In.calibrate(s); return s; },
            "format=00:00 starting=0 interval=1" + base + " use", "format=0 starting=0 interval=1" + base + " use");
        labelCase("label_hyperstack", () -> In.hyper("hyp", 16, 40, 30, 2, 3, 2, 2, true), "format=0 starting=0 interval=1 x=5 y=20 font=18 text=[] range=1-12 use");
    }

    // ------------------------------------------------------------------ slices
    static void slices() {
        // Add Slice / Delete Slice on a plain stack: after the current slice; what the new slice holds
        for (int bits : new int[]{8, 16, 32}) {
            final int bd = bits;
            W4Stk.kase("slices", "add_slice_stack_" + Gen.bits(bits), "addSlice", f -> W4Stk.multi(f, () -> In.stack("stk", bd, 37, 23, 4, 3), "Add Slice", ""));
        }
        W4Stk.kase("slices", "add_slice_stack_at_position", "addSlice", f -> W4Stk.multi(f, () -> { ImagePlus s = W4Ops.labelled(In.stack("stkp", 8, 37, 23, 4, 3)); s.setSlice(3); return s; }, "Add Slice", ""));
        W4Stk.kase("slices", "add_slice_stack_calibrated_inverting", "addSlice", f -> W4Stk.multi(f, () -> {
            ImagePlus s = In.stack("stki", 8, 37, 23, 3, 3); s.setSlice(2); s.getProcessor().invertLut(); return s;
        }, "Add Slice", ""));
        W4Stk.kase("slices", "add_slice_rgb_stack", "addSlice", f -> W4Stk.multi(f, () -> { ImagePlus s = In.rgbStack("rgbs", 37, 23, 3, 3); s.setSlice(2); return s; }, "Add Slice", ""));
        W4Stk.kase("slices", "add_slice_single_image", "addSlice", f -> W4Stk.multi(f, () -> In.image("img", 8, 37, 23, 3), "Add Slice", ""));
        W4Stk.kase("slices", "add_slice_hyper", "addSlice", f -> W4Stk.multi(f, () -> { ImagePlus h = In.hyper("hyp", 16, 40, 30, 2, 3, 2, 2, true); h.setPosition(2, 2, 1); return h; }, "Add Slice",
            "add=slice", "add=slice prepend", "add=channel", "add=channel prepend", "add=frame", "add=frame prepend"));
        W4Stk.kase("slices", "add_slice_hyper_1c", "addSlice", f -> W4Stk.multi(f, () -> { ImagePlus h = In.hyper("hyp1", 16, 40, 30, 1, 3, 2, 2, false); h.setPosition(1, 2, 2); return h; }, "Add Slice",
            "add=slice", "add=frame prepend", "add=channel"));
        W4Stk.kase("slices", "delete_slice_stack", "deleteSlice", f -> W4Stk.multi(f, () -> { ImagePlus s = W4Ops.labelled(In.stack("stk", 8, 37, 23, 4, 3)); s.setSlice(2); return s; }, "Delete Slice", ""));
        W4Stk.kase("slices", "delete_slice_stack_last", "deleteSlice", f -> W4Stk.multi(f, () -> { ImagePlus s = W4Ops.labelled(In.stack("stk", 8, 37, 23, 3, 3)); s.setSlice(3); return s; }, "Delete Slice", ""));
        W4Stk.kase("slices", "delete_slice_stack_two", "deleteSlice", f -> W4Stk.multi(f, () -> In.stack("stk2", 8, 37, 23, 2, 3), "Delete Slice", ""));
        W4Stk.kase("slices", "delete_slice_hyper", "deleteSlice", f -> W4Stk.multi(f, () -> { ImagePlus h = In.hyper("hyp", 16, 40, 30, 2, 3, 2, 2, true); h.setPosition(2, 2, 2); return h; }, "Delete Slice",
            "delete=slice", "delete=channel", "delete=frame"));
        W4Stk.kase("slices", "delete_slice_hyper_last_of_dimension", "deleteSlice", f -> W4Stk.multi(f, () -> { ImagePlus h = In.hyper("hypz", 16, 40, 30, 2, 1, 3, 2, true); h.setPosition(1, 1, 1); return h; }, "Delete Slice",
            "delete=slice", "delete=channel", "delete=frame"));
        W4Stk.kase("slices", "set_slice_stack", "setSlice", f -> W4Stk.multi(f, () -> In.stack("stk", 8, 37, 23, 4, 3), "Set Slice...", "slice=3", "slice=1", "slice=9", "slice=0"));
        W4Stk.kase("slices", "set_slice_hyper", "setSlice", f -> W4Stk.multi(f, () -> In.hyper("hyp", 16, 40, 30, 2, 3, 2, 2, true), "Set Slice...",
            "channel=2 slice=3 frame=2", "channel=1 slice=2 frame=1", "channel=9 slice=9 frame=9", "channel=2 slice=1 frame=1"));
        W4Stk.kase("slices", "next_previous_slice", "nextSlice", f -> {
            f.put("command", "Next Slice [>]");
            List<Object> cases = new ArrayList<>();
            for (Object[] c : new Object[][]{{"stack", "Next Slice [>]", 1}, {"stack", "Next Slice [>]", 4}, {"stack", "Previous Slice [<]", 1}, {"stack", "Previous Slice [<]", 3},
                    {"hyper", "Next Slice [>]", 1}, {"hyper", "Next Slice [>]", 3}, {"hyper", "Previous Slice [<]", 1}, {"hyper_nz1", "Next Slice [>]", 1}, {"hyper_nz1", "Previous Slice [<]", 2}}) {
                ImagePlus imp = c[0].equals("stack") ? In.stack("stk", 8, 37, 23, 4, 3) : c[0].equals("hyper") ? In.hyper("hyp", 16, 40, 30, 2, 3, 2, 2, true) : In.hyper("hypt", 16, 40, 30, 2, 1, 3, 2, true);
                imp.show();
                if (c[0].equals("stack")) imp.setSlice((Integer) c[2]); else imp.setPosition(1, (Integer) c[2], 1);
                if (c[0].equals("hyper_nz1")) imp.setPosition(1, 1, (Integer) c[2]);
                int[] p0 = imp.convertIndexToPosition(imp.getCurrentSlice());
                Map<String, Object> r = W4Stk.run1(imp, (String) c[1], "");
                cases.add(J.o("kind", c[0], "command", c[1], "from", p0, "to", imp.convertIndexToPosition(imp.getCurrentSlice()), "currentSlice", imp.getCurrentSlice()));
                W4Stk.closeAll();
            }
            f.put("cases", cases);
        });
        W4Stk.kase("slices", "set_label_and_remove_labels", "setLabel", f -> {
            f.put("command", "Set Label...");
            List<Object> cases = new ArrayList<>();
            ImagePlus s = W4Ops.labelled(In.stack("stk", 8, 37, 23, 3, 3));
            s.show(); s.setSlice(2);
            W4Stk.run1(s, "Set Label...", "label=hello");
            cases.add(J.o("options", "label=hello", "labels", labelsOf(s)));
            W4Stk.run1(s, "Set Label...", "label=[with spaces]");
            cases.add(J.o("options", "label=[with spaces]", "labels", labelsOf(s)));
            W4Stk.run1(s, "Set Label...", "label=");
            cases.add(J.o("options", "label=", "labels", labelsOf(s)));
            W4Stk.run1(s, "Remove Slice Labels", "");
            cases.add(J.o("options", "Remove Slice Labels", "labels", labelsOf(s)));
            W4Stk.closeAll();
            ImagePlus h = In.hyper("hyp", 16, 40, 30, 2, 3, 2, 2, true);
            h.show(); h.setPosition(2, 2, 2);
            W4Stk.run1(h, "Set Label...", "label=hyperlabel");
            cases.add(J.o("options", "hyper label=hyperlabel at c2 z2 t2", "labels", labelsOf(h), "stackIndex", h.getCurrentSlice()));
            f.put("cases", cases);
        });
        W4Stk.kase("slices", "images_to_stack", "imagesToStack", f -> W4Ops.multiN(f, () -> new ImagePlus[]{In.image("a", 8, 37, 23, 3), In.image("b", 8, 37, 23, 4), In.image("c", 8, 37, 23, 5)}, "Images to Stack",
            "name=Stack title=[] use", "name=Stack title=[] use keep", "name=Stack title=[]", "name=Stack title=[b]", "name=Stack title=[a] use", "name=Out title=[z]"));
        W4Stk.kase("slices", "images_to_stack_sizes", "imagesToStack", f -> W4Ops.multiN(f, () -> new ImagePlus[]{In.image("a", 8, 37, 23, 3), In.image("b", 8, 30, 20, 4)}, "Images to Stack",
            "method=[Copy (center)] name=Stack title=[] use", "method=[Copy (top-left)] name=Stack title=[] use", "method=[Scale (smallest)] name=Stack title=[] use", "method=[Scale (largest)] name=Stack title=[] use bicubic",
            "method=[Scale (largest)] name=Stack title=[] use", "method=[Copy (center)] name=Stack title=[] fill=White use"));
        W4Stk.kase("slices", "images_to_stack_types", "imagesToStack", f -> W4Ops.multiN(f, () -> new ImagePlus[]{In.image("a", 8, 37, 23, 3), In.image("b", 16, 37, 23, 4)}, "Images to Stack", "name=Stack title=[] use"));
        W4Stk.kase("slices", "images_to_stack_rgb_and_stack", "imagesToStack", f -> W4Ops.multiN(f, () -> new ImagePlus[]{In.rgbImage("a", 37, 23, 3), In.rgbImage("b", 37, 23, 4)}, "Images to Stack", "name=Stack title=[] use"));
        W4Stk.kase("slices", "images_to_stack_calibrated", "imagesToStack", f -> W4Ops.multiN(f, () -> new ImagePlus[]{In.calibrate2(In.image("a", 16, 37, 23, 3)), In.calibrate2(In.image("b", 16, 37, 23, 4))}, "Images to Stack", "name=Stack title=[] use"));
        W4Stk.kase("slices", "stack_to_images", "stackToImages", f -> W4Stk.multi(f, () -> W4Ops.labelled(In.stack("stk", 8, 37, 23, 3, 3)), "Stack to Images", ""));
        W4Stk.kase("slices", "stack_to_images_unlabelled", "stackToImages", f -> W4Stk.multi(f, () -> In.stack("stk", 8, 37, 23, 3, 3), "Stack to Images", ""));
        W4Stk.kase("slices", "stack_to_images_hyper", "stackToImages", f -> W4Stk.multi(f, () -> In.hyper("hyp", 16, 40, 30, 2, 2, 2, 2, true), "Stack to Images", ""));
        W4Stk.kase("slices", "stack_to_images_calibrated_u16", "stackToImages", f -> W4Stk.multi(f, () -> { ImagePlus s = In.stack("stkc", 16, 37, 23, 2, 3); In.calibrate(s); return s; }, "Stack to Images", ""));
        W4Stk.kase("slices", "new_image_stack", "newImage", f -> {
            f.put("command", "Image...");
            List<Object> cases = new ArrayList<>();
            for (String o : new String[]{
                "name=Untitled type=8-bit fill=Ramp width=32 height=24 slices=3", "name=Untitled type=16-bit fill=Black width=32 height=24 slices=2", "name=Untitled type=32-bit fill=Ramp width=32 height=24 slices=2",
                "name=Untitled type=RGB fill=White width=32 height=24 slices=2", "name=Untitled type=8-bit fill=White width=32 height=24 slices=3"}) {
                Map<String, Object> r = W4Stk.run1(null, "Image...", o);
                r.put("options", o);
                cases.add(r);
                W4Stk.closeAll();
            }
            f.put("cases", cases);
        });
        // 1.54p's fill choices are White, Black, Ramp and Noise: any other word is "not a valid choice" and the macro is cancelled (what the port must refuse)
        W4Stk.kase("slices", "new_image_invalid_fill", "newImageInvalid", f -> {
            f.put("command", "Image...");
            String o = "name=Untitled type=8-bit fill=Random width=32 height=24 slices=1";
            Map<String, Object> r = W4Stk.run1(null, "Image...", o);
            r.put("options", o);
            f.put("cases", new ArrayList<Object>(Collections.singletonList(r)));
            W4Stk.closeAll();
        });
    }

    static List<Object> labelsOf(ImagePlus imp) {
        List<Object> l = new ArrayList<>();
        for (int i = 1; i <= imp.getStackSize(); i++) l.add(imp.getStack().getSliceLabel(i));
        return l;
    }
}
