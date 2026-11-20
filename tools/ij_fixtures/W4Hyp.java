import ij.*;
import ij.gui.*;
import ij.process.*;
import java.util.*;
import java.util.function.Supplier;

/** hyper: Stack to Hyperstack (every order), Hyperstack to Stack, New Hyperstack, Reduce Dimensionality, File > New > Image with slices. */
final class W4Hyp {
    static final String[] ORDERS = {"xyczt(default)", "xyctz", "xyzct", "xyztc", "xytcz", "xytzc"};

    static ImagePlus plain12(int bits) {
        ImagePlus s = In.stack("p12", bits, 37, 23, 12, 3);
        for (int i = 1; i <= 12; i++) s.getStack().setSliceLabel("p" + i, i);
        return s;
    }

    static void run() {
        List<String> o = new ArrayList<>();
        for (String ord : ORDERS) o.add("order=" + ord + " channels=2 slices=3 frames=2 display=Composite");
        o.add("order=xytzc channels=3 slices=2 frames=2 display=Color");
        o.add("order=xyczt(default) channels=2 slices=3 frames=2 display=Grayscale");
        o.add("order=xyczt(default) channels=1 slices=3 frames=4 display=Color");
        o.add("order=xyczt(default) channels=4 slices=3 frames=1 display=Composite");
        o.add("order=xyczt(default) channels=12 slices=1 frames=1 display=Composite");
        o.add("order=xyczt(default) channels=2 slices=2 frames=2 display=Composite");
        o.add("order=xyczt(default) channels=5 slices=3 frames=1 display=Composite");
        String[] opts = o.toArray(new String[0]);
        W4Stk.kase("hyper", "stack_to_hyperstack_8bit", "stackToHyperstack", f -> W4Stk.multi(f, () -> plain12(8), "Stack to Hyperstack...", opts));
        W4Stk.kase("hyper", "stack_to_hyperstack_16bit", "stackToHyperstack", f -> W4Stk.multi(f, () -> plain12(16), "Stack to Hyperstack...",
            "order=xyczt(default) channels=2 slices=3 frames=2 display=Composite", "order=xytzc channels=2 slices=3 frames=2 display=Color", "order=xyzct channels=3 slices=2 frames=2 display=Composite"));
        W4Stk.kase("hyper", "stack_to_hyperstack_f32_calibrated", "stackToHyperstack", f -> W4Stk.multi(f, () -> { ImagePlus s = plain12(32); In.calibrate(s); return s; }, "Stack to Hyperstack...",
            "order=xyczt(default) channels=2 slices=3 frames=2 display=Composite"));
        W4Stk.kase("hyper", "stack_to_hyperstack_rgb", "stackToHyperstack", f -> W4Stk.multi(f, () -> In.rgbStack("rgb12", 37, 23, 6, 3), "Stack to Hyperstack...",
            "order=xyczt(default) channels=1 slices=3 frames=2 display=Color", "order=xyczt(default) channels=2 slices=3 frames=1 display=Color"));
        W4Stk.kase("hyper", "stack_to_hyperstack_from_hyperstack", "stackToHyperstack", f -> W4Stk.multi(f, () -> In.hyper("hyp", 16, 40, 30, 2, 3, 2, 2, true), "Stack to Hyperstack...",
            "order=xyzct channels=2 slices=3 frames=2 display=Composite", "order=xyczt(default) channels=3 slices=2 frames=2 display=Composite"));
        W4Stk.kase("hyper", "stack_to_hyperstack_position", "stackToHyperstack", f -> W4Stk.multi(f, () -> { ImagePlus s = plain12(8); s.setSlice(7); return s; }, "Stack to Hyperstack...",
            "order=xyczt(default) channels=2 slices=3 frames=2 display=Composite"));

        W4Stk.kase("hyper", "hyperstack_to_stack", "hyperstackToStack", f -> W4Stk.multi(f, () -> In.hyper("hyp", 16, 40, 30, 2, 3, 2, 2, true), "Hyperstack to Stack", ""));
        W4Stk.kase("hyper", "hyperstack_to_stack_calibrated_1c", "hyperstackToStack", f -> W4Stk.multi(f, () -> { ImagePlus h = In.hyper("hyp1", 16, 40, 30, 1, 3, 2, 2, false); In.calibrate(h); return h; }, "Hyperstack to Stack", ""));
        W4Stk.kase("hyper", "hyperstack_to_stack_color_mode", "hyperstackToStack", f -> W4Stk.multi(f, () -> { ImagePlus h = In.hyper("hypc", 8, 40, 30, 3, 2, 2, 2, true); ((CompositeImage) h).setMode(IJ.COLOR); return h; }, "Hyperstack to Stack", ""));

        W4Stk.kase("hyper", "new_hyperstack", "newHyperstack", f -> {
            f.put("command", "New Hyperstack...");
            List<Object> cases = new ArrayList<>();
            for (String opt : new String[]{
                "name=HS type=8-bit display=Color width=24 height=16 channels=2 slices=3 frames=2 label",
                "name=HS type=16-bit display=Composite width=24 height=16 channels=2 slices=3 frames=2 label",
                "name=HS type=32-bit display=Grayscale width=24 height=16 channels=3 slices=2 frames=2 label",
                "name=HS type=RGB display=Color width=24 height=16 channels=3 slices=2 frames=2 label",
                "name=HS type=8-bit display=Composite width=24 height=16 channels=3 slices=2 frames=2",
                "name=HS type=8-bit display=Composite width=24 height=16 channels=1 slices=3 frames=1 label",
                "name=HS type=16-bit display=Color width=24 height=16 channels=1 slices=1 frames=3 label",
                "name=HS type=8-bit display=Composite width=24 height=16 channels=8 slices=1 frames=1 label"}) {
                Map<String, Object> r = W4Stk.run1(null, "New Hyperstack...", opt);
                r.put("options", opt);
                cases.add(r);
                W4Stk.closeAll();
            }
            f.put("cases", cases);
        });

        W4Stk.kase("hyper", "reduce_dimensionality", "reduceDimensionality", f -> W4Stk.multi(f, () -> { ImagePlus h = In.hyper("hyp", 16, 40, 30, 2, 3, 2, 2, true); h.setPosition(2, 2, 2); return h; }, "Reduce Dimensionality...",
            "channels slices keep", "slices frames keep", "channels frames keep", "channels keep", "slices keep", "frames keep", "keep", "channels slices frames keep", "channels slices", "slices"));
        W4Stk.kase("hyper", "reduce_dimensionality_calibrated_color", "reduceDimensionality", f -> W4Stk.multi(f, () -> { ImagePlus h = In.hyper("hypc", 8, 40, 30, 3, 3, 2, 4, true); In.calibrate(h); ((CompositeImage) h).setMode(IJ.COLOR); h.setPosition(3, 1, 2); return h; }, "Reduce Dimensionality...",
            "channels slices keep", "slices frames keep"));
        W4Stk.kase("hyper", "reduce_dimensionality_1c", "reduceDimensionality", f -> W4Stk.multi(f, () -> { ImagePlus h = In.hyper("hyp1", 16, 40, 30, 1, 3, 2, 4, false); h.setPosition(1, 2, 2); return h; }, "Reduce Dimensionality...",
            "slices keep", "frames keep", "slices frames keep"));
    }
}
