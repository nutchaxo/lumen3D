import ij.*;
import ij.io.*;
import ij.process.*;
import java.io.*;
import java.nio.*;
import java.nio.file.*;
import java.util.*;
import java.util.function.Supplier;

/**
 * tiff: FileSaver.saveAsTiffStack / saveAsTiff bytes + the ImageDescription + the IFD chain, and what Opener reads back (dims, labels, ranges, LUTs, calibration).
 */
final class W4Tiff {
    static Path tmp;

    static void run() throws Exception {
        tmp = Files.createTempDirectory("w4tiff");
        try {
            hyper16();
            plain8();
            rgb();
            rgbStack();
            f32Stack();
            more();
            descriptionOnly();
        } finally {
            try (DirectoryStream<Path> ds = Files.newDirectoryStream(tmp)) { for (Path p : ds) Files.deleteIfExists(p); }
            Files.deleteIfExists(tmp);
        }
    }

    // ---------------------------------------------------------------- inputs
    static ImagePlus hyp16() {
        ImagePlus h = In.hyper("hyp", 16, 24, 16, 2, 3, 2, 21, true);
        In.calibrate(h);
        CompositeImage ci = (CompositeImage) h;
        ci.setC(1); ci.setChannelLut(W4Rgb.lut("green", 0, 255)); ci.setDisplayRange(5000, 40000);
        ci.setC(2); ci.setChannelLut(W4Rgb.lut("magenta", 0, 255)); ci.setDisplayRange(1000, 20000);
        ci.setC(1);
        return ci;
    }

    // ---------------------------------------------------------------- cases
    static void hyper16() {
        W4Stk.kase("tiff", "hyperstack_u16_2c3z2t_calibrated", "saveAsTiffStack", f -> save(f, hyp16(), true, "hyp16.tif"));
        W4Stk.kase("tiff", "hyperstack_u16_2c3z2t_calibrated_save_as_tiff", "saveAsTiff", f -> save(f, hyp16(), false, "hyp16b.tif"));
        W4Stk.kase("tiff", "hyperstack_u16_default_luts", "saveAsTiffStack", f -> save(f, In.hyper("hdl", 16, 24, 16, 2, 3, 2, 22, true), true, "hdl.tif"));
        W4Stk.kase("tiff", "hyperstack_u16_color_mode", "saveAsTiffStack", f -> save(f, W4Ana.roi(colorMode(In.hyper("hcm", 16, 24, 16, 3, 2, 1, 23, true)), null), true, "hcm.tif"));
        W4Stk.kase("tiff", "hyperstack_u8_3c_composite", "saveAsTiffStack", f -> save(f, In.hyper("h83", 8, 24, 16, 3, 2, 2, 24, true), true, "h83.tif"));
        W4Stk.kase("tiff", "hyperstack_1c_z_t_not_composite", "saveAsTiffStack", f -> save(f, In.calibrate2(In.hyper("h1c", 16, 24, 16, 1, 3, 2, 25, false)), true, "h1c.tif"));
        W4Stk.kase("tiff", "hyperstack_f32_2c", "saveAsTiffStack", f -> save(f, In.hyper("h32", 32, 24, 16, 2, 2, 1, 26, true), true, "h32.tif"));
        W4Stk.kase("tiff", "hyperstack_1c_t_only", "saveAsTiffStack", f -> save(f, In.hyper("h1t", 8, 24, 16, 1, 1, 4, 27, false), true, "h1t.tif"));
        W4Stk.kase("tiff", "hyperstack_2c_z_only_hyperstack_flag", "saveAsTiffStack", f -> save(f, In.hyper("h2z", 16, 24, 16, 2, 4, 1, 28, true), true, "h2z.tif"));
    }

    static ImagePlus colorMode(ImagePlus h) { ((CompositeImage) h).setMode(IJ.COLOR); return h; }

    static void plain8() {
        W4Stk.kase("tiff", "stack_u8_4_slices", "saveAsTiffStack", f -> save(f, In.stack("s8", 8, 24, 16, 4, 3), true, "s8.tif"));
        W4Stk.kase("tiff", "stack_u8_4_slices_labels_calibrated", "saveAsTiffStack", f -> save(f, In.calibrate2(W4Ops.labelled(In.stack("s8l", 8, 24, 16, 4, 3))), true, "s8l.tif"));
        W4Stk.kase("tiff", "stack_u16_3_slices_display_range", "saveAsTiffStack", f -> { ImagePlus s = In.stack("s16", 16, 24, 16, 3, 4); s.setDisplayRange(5000, 40000); save(f, s, true, "s16.tif"); });
        W4Stk.kase("tiff", "stack_u8_inverting_lut", "saveAsTiffStack", f -> { ImagePlus s = In.stack("s8i", 8, 24, 16, 3, 3); s.getProcessor().invertLut(); save(f, s, true, "s8i.tif"); });
        W4Stk.kase("tiff", "stack_u8_fire_lut", "saveAsTiffStack", f -> { ImagePlus s = In.stack("s8f", 8, 24, 16, 3, 3); s.getProcessor().setColorModel(ij.plugin.LutLoader.getLut("fire")); save(f, s, true, "s8f.tif"); });
        W4Stk.kase("tiff", "image_u8_single", "saveAsTiff", f -> save(f, In.image("i8", 8, 24, 16, 3), false, "i8.tif"));
        W4Stk.kase("tiff", "image_u16_single_calibrated", "saveAsTiff", f -> { ImagePlus i = In.calibrate2(In.image("i16", 16, 24, 16, 3)); i.setDisplayRange(4000, 50000); save(f, i, false, "i16.tif"); });
    }

    static void rgb() {
        W4Stk.kase("tiff", "rgb_image", "saveAsTiff", f -> save(f, In.rgbImage("rgb", 24, 16, 3), false, "rgb.tif"));
        W4Stk.kase("tiff", "rgb_image_calibrated", "saveAsTiff", f -> save(f, In.calibrate2(In.rgbImage("rgbc", 24, 16, 3)), false, "rgbc.tif"));
    }

    static void rgbStack() {
        W4Stk.kase("tiff", "rgb_stack_3_slices", "saveAsTiffStack", f -> save(f, In.rgbStack("rgbs", 24, 16, 3, 3), true, "rgbs.tif"));
        W4Stk.kase("tiff", "rgb_stack_3_slices_labels", "saveAsTiffStack", f -> save(f, In.calibrate2(W4Ops.labelled(In.rgbStack("rgbsl", 24, 16, 3, 3))), true, "rgbsl.tif"));
    }

    static void f32Stack() {
        W4Stk.kase("tiff", "stack_f32_3_slices", "saveAsTiffStack", f -> { ImagePlus s = In.stack("s32", 32, 24, 16, 3, 5); save(f, s, true, "s32.tif"); });
        W4Stk.kase("tiff", "stack_f32_3_slices_calibrated_range", "saveAsTiffStack", f -> { ImagePlus s = In.calibrate2(In.stack("s32c", 32, 24, 16, 3, 5)); s.setDisplayRange(0, 300); save(f, s, true, "s32c.tif"); });
    }

    static void more() {
        // the same stack saved with calibration of a pixel-unit image (no calibration entries) and with a non-integer pixel size
        W4Stk.kase("tiff", "stack_u16_pixel_size_non_integer", "saveAsTiffStack", f -> {
            ImagePlus s = In.stack("s16p", 16, 24, 16, 3, 4);
            ij.measure.Calibration c = s.getCalibration();
            c.pixelWidth = 0.3225806; c.pixelHeight = 0.3225806; c.pixelDepth = 1.5; c.setUnit("um");
            s.setCalibration(c);
            save(f, s, true, "s16p.tif");
        });
        W4Stk.kase("tiff", "stack_u8_info_property", "saveAsTiffStack", f -> {
            ImagePlus s = In.stack("s8n", 8, 24, 16, 3, 3);
            s.setProperty("Info", "line one\nline two");
            save(f, s, true, "s8n.tif");
        });
        W4Stk.kase("tiff", "stack_u8_overlay", "saveAsTiffStack", f -> {
            ImagePlus s = In.stack("s8o", 8, 24, 16, 3, 3);
            ij.gui.Overlay ov = new ij.gui.Overlay();
            ov.add(new ij.gui.Roi(3, 2, 8, 6));
            s.setOverlay(ov);
            save(f, s, true, "s8o.tif");
        });
        W4Stk.kase("tiff", "hyperstack_u16_slice_labels_only_first_channel", "saveAsTiffStack", f -> {
            ImagePlus h = In.hyper("hsl", 16, 24, 16, 2, 2, 1, 31, true);
            for (int i = 1; i <= h.getStackSize(); i++) h.getStack().setSliceLabel(i % 2 == 1 ? "odd " + i : null, i);
            save(f, h, true, "hsl.tif");
        });
    }

    /** Only the description string of the images FileSaver would write (no file): the same values by IJ's own getDescriptionString. */
    static void descriptionOnly() {
        W4Stk.kase("tiff", "description_strings", "description", f -> {
            List<Object> cases = new ArrayList<>();
            Object[][] imgs = {{"hyp16", (Supplier<ImagePlus>) W4Tiff::hyp16}, {"stack8", (Supplier<ImagePlus>) () -> In.stack("s8", 8, 24, 16, 4, 3)},
                {"rgb", (Supplier<ImagePlus>) () -> In.rgbImage("rgb", 24, 16, 3)}, {"hyp_color", (Supplier<ImagePlus>) () -> colorMode(In.hyper("hcm", 16, 24, 16, 3, 2, 1, 23, true))},
                {"hyp_grayscale", (Supplier<ImagePlus>) () -> { ImagePlus h = In.hyper("hgs", 8, 24, 16, 2, 2, 1, 29, true); ((CompositeImage) h).setMode(IJ.GRAYSCALE); return h; }}};
            for (Object[] c : imgs) {
                ImagePlus i = ((Supplier<ImagePlus>) c[1]).get();
                cases.add(J.o("name", c[0], "description", describe(i)));
            }
            f.put("cases", cases);
        });
    }

    static String describe(ImagePlus imp) {
        try {
            java.lang.reflect.Method m = FileSaver.class.getDeclaredMethod("getDescriptionString");
            m.setAccessible(true);
            return (String) m.invoke(new FileSaver(imp));
        } catch (Throwable e) { return "unavailable: " + e; }
    }

    // ---------------------------------------------------------------- the writer + reader
    static void save(Fx f, ImagePlus imp, boolean stack, String name) throws Exception {
        f.put("call", stack ? "new FileSaver(imp).saveAsTiffStack(path)" : "new FileSaver(imp).saveAsTiff(path)");
        f.put("input", Stk.stack(imp));
        String path = tmp.resolve(name).toString();
        FileSaver fs = new FileSaver(imp);
        boolean ok = stack ? fs.saveAsTiffStack(path) : fs.saveAsTiff(path);
        if (!ok) throw new IllegalStateException("FileSaver refused");
        byte[] bytes = Files.readAllBytes(Paths.get(path));
        f.put("tiff", J.b64(bytes, "u8", bytes.length));
        f.put("byteOrder", bytes[0] == 'I' ? "II" : "MM");
        f.put("ifdCount", ifdCount(bytes));
        f.put("ifds", ifds(bytes));
        TiffDecoder td = new TiffDecoder(tmp.toString(), name);
        FileInfo[] fi = td.getTiffInfo();
        f.put("description", fi != null && fi.length > 0 ? fi[0].description : null);
        f.put("fileInfoCount", fi == null ? 0 : fi.length);
        if (fi != null && fi.length > 0) {
            FileInfo a = fi[0];
            f.put("fileInfo", J.o("fileType", a.fileType, "width", a.width, "height", a.height, "nImages", a.nImages, "gapBetweenImages", a.gapBetweenImages, "offset", a.offset,
                "unit", a.unit, "pixelWidth", a.pixelWidth, "pixelHeight", a.pixelHeight, "pixelDepth", a.pixelDepth, "compression", a.compression,
                "samplesPerPixel", a.samplesPerPixel, "metaDataTypes", a.metaDataTypes, "sliceLabelsCount", a.sliceLabels == null ? 0 : a.sliceLabels.length));
        }
        ImagePlus re = new Opener().openImage(path);
        if (re == null) throw new IllegalStateException("Opener returned null");
        f.put("reopened", Stk.stack(re));
        f.put("reopenedClass", re.getClass().getSimpleName());
        f.put("reopenedProperties", J.o("info", re.getInfoProperty(), "overlaySize", re.getOverlay() == null ? 0 : re.getOverlay().size()));
        Files.deleteIfExists(Paths.get(path));
    }

    static long u(byte[] b, int off, int n, boolean le) {
        long v = 0;
        for (int i = 0; i < n; i++) v |= (long) (b[off + (le ? i : n - 1 - i)] & 255) << (8 * i);
        return v;
    }

    static int ifdCount(byte[] b) {
        boolean le = b[0] == 'I';
        long off = u(b, 4, 4, le);
        int n = 0;
        while (off > 0 && off < b.length - 2 && n < 100000) {
            n++;
            int ent = (int) u(b, (int) off, 2, le);
            off = u(b, (int) off + 2 + ent * 12, 4, le);
        }
        return n;
    }

    /** [{entries: [[tag, type, count, valueOrOffset]...]}] of the first 3 IFDs (the structure the port must reproduce). */
    static List<Object> ifds(byte[] b) {
        boolean le = b[0] == 'I';
        long off = u(b, 4, 4, le);
        List<Object> out = new ArrayList<>();
        int n = 0;
        while (off > 0 && off < b.length - 2 && n < 3) {
            int ent = (int) u(b, (int) off, 2, le);
            List<Object> es = new ArrayList<>();
            for (int i = 0; i < ent; i++) {
                int p = (int) off + 2 + i * 12;
                es.add(new double[]{u(b, p, 2, le), u(b, p + 2, 2, le), u(b, p + 4, 4, le), u(b, p + 8, 4, le)});
            }
            out.add(J.o("offset", off, "entries", es.toArray()));
            off = u(b, (int) off + 2 + ent * 12, 4, le);
            n++;
        }
        return out;
    }
}
