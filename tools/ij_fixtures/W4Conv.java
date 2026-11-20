import ij.*;
import ij.gui.*;

import ij.process.*;
import java.util.*;
import java.util.function.Supplier;

/** convert: type conversions of stacks (display range, Scale when converting on / off), Convert Stack to Binary (every dialog option), Lab Stack. */
final class W4Conv {
    static ImagePlus ranged(ImagePlus i, double min, double max) { i.setDisplayRange(min, max); return i; }

    static void run() {
        // ---- 16 -> 8 and 32 -> 8 of a stack: ONE display range for every slice (the current one), scaling on / off
        for (boolean scale : new boolean[]{true, false}) {
            final boolean sc = scale;
            final String sfx = scale ? "scale" : "noscale";
            W4Stk.kase("convert", "u16_to_u8_stack_range_" + sfx, "stackConvert", f -> {
                W4Rgb.conv(sc, false);
                f.put("scaleWhenConverting", sc);
                W4Stk.multi(f, () -> ranged(In.stack("s16", 16, 37, 23, 4, 3), 8000, 45000), "8-bit", "");
                W4Rgb.conv(true, false);
            });
            W4Stk.kase("convert", "u16_to_u8_stack_default_range_" + sfx, "stackConvert", f -> {
                W4Rgb.conv(sc, false);
                f.put("scaleWhenConverting", sc);
                W4Stk.multi(f, () -> In.stack("s16d", 16, 37, 23, 4, 4), "8-bit", "");
                W4Rgb.conv(true, false);
            });
            W4Stk.kase("convert", "u16_to_u8_stack_current_slice_range_" + sfx, "stackConvert", f -> {
                W4Rgb.conv(sc, false);
                f.put("scaleWhenConverting", sc);
                W4Stk.multi(f, () -> { ImagePlus s = In.stack("s16c", 16, 37, 23, 4, 4); s.setSlice(3); s.resetDisplayRange(); return s; }, "8-bit", "");
                W4Rgb.conv(true, false);
            });
            W4Stk.kase("convert", "f32_to_u8_stack_range_" + sfx, "stackConvert", f -> {
                W4Rgb.conv(sc, false);
                f.put("scaleWhenConverting", sc);
                W4Stk.multi(f, () -> ranged(In.stack("s32", 32, 37, 23, 4, 5), 0, 300), "8-bit", "");
                W4Rgb.conv(true, false);
            });
            W4Stk.kase("convert", "f32_to_u16_stack_range_" + sfx, "stackConvert", f -> {
                W4Rgb.conv(sc, false);
                f.put("scaleWhenConverting", sc);
                W4Stk.multi(f, () -> ranged(In.stack("s32b", 32, 37, 23, 4, 5), -50, 350), "16-bit", "");
                W4Rgb.conv(true, false);
            });
            W4Stk.kase("convert", "f32_to_u8_stack_default_range_" + sfx, "stackConvert", f -> {
                W4Rgb.conv(sc, false);
                f.put("scaleWhenConverting", sc);
                W4Stk.multi(f, () -> In.stack("s32d", 32, 37, 23, 4, 6), "8-bit", "");
                W4Rgb.conv(true, false);
            });
        }
        W4Stk.kase("convert", "up_conversions_stack", "stackConvert", f -> {
            List<Object> cases = new ArrayList<>();
            f.put("input", Stk.stack(In.stack("s8", 8, 37, 23, 3, 3)));
            for (Object[] c : new Object[][]{{8, "16-bit"}, {8, "32-bit"}, {16, "32-bit"}, {8, "RGB Color"}, {16, "RGB Color"}, {32, "RGB Color"}}) {
                ImagePlus i = In.stack("s" + c[0], (Integer) c[0], 37, 23, 3, 3);
                i.show();
                Map<String, Object> r = W4Stk.run1(i, (String) c[1], "");
                r.put("from", c[0]); r.put("to", c[1]);
                cases.add(r);
                W4Stk.closeAll();
            }
            f.put("cases", cases);
        });
        W4Stk.kase("convert", "stack_calibrated_function_u16_to_u8", "stackConvert", f -> W4Stk.multi(f, () -> ranged(In.calibrate2(In.stack("s16c", 16, 37, 23, 3, 3)), 5000, 50000), "8-bit", ""));
        W4Stk.kase("convert", "hyperstack_composite_u16_to_u8", "stackConvert", f -> W4Stk.multi(f, () -> {
            ImagePlus h = In.hyper("hyp", 16, 32, 24, 2, 3, 2, 2, true);
            CompositeImage ci = (CompositeImage) h;
            ci.setC(1); ci.setDisplayRange(5000, 40000); ci.setC(2); ci.setDisplayRange(1000, 20000); ci.setC(1);
            return ci;
        }, "8-bit", ""));
        W4Stk.kase("convert", "hyperstack_composite_u16_to_f32", "stackConvert", f -> W4Stk.multi(f, () -> In.hyper("hyp", 16, 32, 24, 2, 2, 2, 3, true), "32-bit", ""));
        W4Stk.kase("convert", "hyperstack_composite_f32_to_u16", "stackConvert", f -> W4Stk.multi(f, () -> ranged(In.hyper("hypf", 32, 32, 24, 2, 2, 1, 3, true), 0, 300), "16-bit", ""));

        // ---- Convert Stack to Binary (Thresholder.convertStack): method / background / calculate / only / black / list / create
        String[] opts = {
            "method=Default background=Default calculate black",
            "method=Default background=Default black",
            "method=Otsu background=Dark calculate black",
            "method=Otsu background=Dark black",
            "method=Otsu background=Light calculate black",
            "method=Otsu background=Light black",
            "method=Default background=Dark only black",
            "method=Huang background=Default calculate black",
            "method=IsoData background=Default calculate black",
            "method=Triangle background=Dark calculate black",
            "method=Default background=Default calculate black list",
            "method=Default background=Default calculate black create"};
        W4Stk.kase("convert", "to_binary_stack_u8_black", "convertStackToBinary", f -> W4Stk.multi(f, () -> In.stack("s8", 8, 37, 23, 4, 3), "Convert to Mask", opts));
        W4Stk.kase("convert", "to_binary_stack_u8_black_make_binary", "convertStackToBinary", f -> W4Stk.multi(f, () -> In.stack("s8", 8, 37, 23, 4, 3), "Make Binary",
            "method=Default background=Default calculate black", "method=Otsu background=Light calculate black"));
        W4Stk.kase("convert", "to_binary_stack_u8_white_background", "convertStackToBinary", f -> {
            f.put("blackBackground", false);
            Prefs.blackBackground = false;
            try {
                W4Stk.multi(f, () -> In.stack("s8", 8, 37, 23, 4, 3), "Convert to Mask", "method=Default background=Default calculate", "method=Otsu background=Dark", "method=Default background=Default only");
            } finally { Prefs.blackBackground = true; }
        });
        W4Stk.kase("convert", "to_binary_stack_u8_black_toggles_pref", "convertStackToBinary", f -> {
            // the dialog's "Black background" checkbox stores Prefs.blackBackground
            Prefs.blackBackground = false;
            try {
                f.put("prefBefore", Prefs.blackBackground);
                W4Stk.multi(f, () -> In.stack("s8", 8, 37, 23, 3, 3), "Convert to Mask", "method=Default background=Default calculate black");
                f.put("prefAfter", Prefs.blackBackground);
            } finally { Prefs.blackBackground = true; }
        });
        W4Stk.kase("convert", "to_binary_stack_u8_threshold_set", "convertStackToBinary", f -> W4Stk.multi(f, () -> {
            ImagePlus s = In.stack("s8t", 8, 37, 23, 4, 3);
            s.getProcessor().setThreshold(60, 200, ImageProcessor.NO_LUT_UPDATE);
            return s;
        }, "Convert to Mask", "method=Default background=Default black", "method=Default background=Default calculate black", "method=Default background=Default only black"));
        W4Stk.kase("convert", "to_binary_stack_u16", "convertStackToBinary", f -> W4Stk.multi(f, () -> In.stack("s16", 16, 37, 23, 4, 3), "Convert to Mask",
            "method=Default background=Default calculate black", "method=Otsu background=Dark black"));
        W4Stk.kase("convert", "to_binary_stack_f32", "convertStackToBinary", f -> W4Stk.multi(f, () -> In.stack("s32", 32, 37, 23, 4, 3), "Convert to Mask",
            "method=Default background=Default calculate black", "method=Default background=Default black"));
        W4Stk.kase("convert", "to_binary_stack_u16_threshold_set", "convertStackToBinary", f -> W4Stk.multi(f, () -> {
            ImagePlus s = In.stack("s16t", 16, 37, 23, 4, 3);
            s.getProcessor().setThreshold(10000, 45000, ImageProcessor.NO_LUT_UPDATE);
            return s;
        }, "Convert to Mask", "method=Default background=Default black", "method=Default background=Default calculate black"));
        W4Stk.kase("convert", "to_binary_stack_inverting_lut", "convertStackToBinary", f -> W4Stk.multi(f, () -> {
            ImagePlus s = In.stack("s8i", 8, 37, 23, 3, 3);
            s.getProcessor().invertLut();
            return s;
        }, "Convert to Mask", "method=Default background=Default calculate black"));
        W4Stk.kase("convert", "to_binary_hyperstack", "convertStackToBinary", f -> W4Stk.multi(f, () -> In.hyper("hyp", 8, 32, 24, 2, 2, 2, 3, true), "Convert to Mask",
            "method=Default background=Default calculate black", "method=Default background=Default black"));
        W4Stk.kase("convert", "to_binary_single_image", "convertToBinary", f -> W4Stk.multi(f, () -> In.image("img", 8, 37, 23, 3), "Convert to Mask", "background=Default black", "background=Dark black", ""));

        // ---- Lab Stack: IJ.run in batch mode and through the GUI, and the converter itself
        W4Stk.kase("convert", "lab_stack_gui", "labStack", f -> {
            ij.macro.Interpreter.batchMode = false;
            try {
                ImagePlus i = In.rgbImage("rgb", 37, 23, 3);
                i.show();
                f.put("input", Stk.stack(i));
                f.put("command", "Lab Stack");
                Map<String, Object> r = W4Stk.run1(i, "Lab Stack", "");
                for (Map.Entry<String, Object> e : r.entrySet()) f.put(e.getKey(), e.getValue());
                ImagePlus now = WindowManager.getCurrentImage();
                f.put("currentImageAfter", now == null ? null : Stk.stack(now));
                f.put("sameObjectAsInput", now == i);
                f.put("openImages", W4Stk.ids().size());
            } finally { ij.macro.Interpreter.batchMode = true; }
        });
        W4Stk.kase("convert", "lab_stack_converter_api", "labStack", f -> {
            ImagePlus i = In.rgbImage("rgb", 37, 23, 3);
            f.put("input", Stk.stack(i));
            f.put("call", "new ColorSpaceConverter().RGBToLab(imp)");
            ImagePlus lab = new ColorSpaceConverter().RGBToLab(i);
            f.put("output", Stk.stack(lab));
            f.put("className", lab.getClass().getSimpleName());
        });
        W4Stk.kase("convert", "lab_stack_imageconverter", "labStack", f -> {
            ImagePlus i = In.rgbImage("rgb", 37, 23, 3);
            f.put("input", Stk.stack(i));
            f.put("call", "new ImageConverter(imp).convertToLab()");
            new ImageConverter(i).convertToLab();
            f.put("self", Stk.stack(i));
            f.put("className", i.getClass().getSimpleName());
        });
    }
}
