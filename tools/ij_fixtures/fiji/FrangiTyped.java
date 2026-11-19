import ij.*;
import ij.process.*;
import java.nio.file.*;
import java.util.*;
import net.imglib2.RandomAccess;
import net.imglib2.img.Img;
import net.imglib2.img.array.ArrayImgs;
import org.scijava.Context;
import org.scijava.command.CommandService;
import org.scijava.module.Module;

/**
 * Frangi Vesselness on the integer pixel types the Fiji GUI hands the command (ImagePlus 8-bit -> UnsignedByteType, 16-bit ->
 * UnsignedShortType): with "Apply Gaussian at each scale" ops.filter().gauss(input, sigma) returns an image of the INPUT's type,
 * so the smoothed values are rounded integers before the Hessian is taken. FijiRefs frangi feeds FloatType (no rounding).
 * Usage: run_fiji.sh FrangiTyped <outDir ending in ij-wave3>   -> <outDir>/fiji/frangi/typed_{blobs8,blobs16}.json
 */
public final class FrangiTyped {
    @SuppressWarnings({"unchecked", "rawtypes"})
    public static void main(String[] a) throws Exception {
        Locale.setDefault(Locale.ROOT);
        System.setProperty("user.home", System.getProperty("java.io.tmpdir") + "/fijirefs-home");
        Fx.root = Paths.get(a[0]).toAbsolutePath().normalize();
        if (!Fx.root.getFileName().toString().equals("ij-wave3")) throw new IllegalArgumentException("outDir must end in ij-wave3");
        Thread t = new Thread(() -> {
            try {
                new ImageJ(ImageJ.NO_SHOW);
                Context ctx = new Context(CommandService.class, net.imagej.ops.OpService.class);
                CommandService cs = ctx.getService(CommandService.class);
                Class<?> cmd = Class.forName("net.imagej.ops.commands.filter.FrangiVesselness");
                ImageProcessor ip = FijiRefs.blobs8(64, 56, 3);
                int w = ip.getWidth(), h = ip.getHeight();
                for (int bits : new int[]{8, 16}) {
                    short[] sdata = new short[w * h]; byte[] bdata = new byte[w * h];
                    for (int i = 0; i < w * h; i++) { int v = bits == 8 ? ip.get(i) : ip.get(i) * 200; if (bits == 8) bdata[i] = (byte) v; else sdata[i] = (short) v; }
                    List<Object> cases = new ArrayList<>();
                    for (String[] s : new String[][]{{"true", "1, 1", "2, 5"}, {"true", "1, 1", "3"}, {"false", "1, 1", "2"}}) {
                        Img in = bits == 8 ? ArrayImgs.unsignedBytes(bdata.clone(), w, h) : ArrayImgs.unsignedShorts(sdata.clone(), w, h);
                        Module m = (Module) cs.run((Class) cmd, true, "input", in, "doGauss", Boolean.parseBoolean(s[0]), "spacingString", s[1], "scaleString", s[2]).get();
                        Img out = (Img) m.getOutput("result");
                        long[] dims = new long[out.numDimensions()];
                        out.dimensions(dims);
                        long total = 1;
                        for (long d : dims) total *= d;
                        float[] vals = new float[(int) total];
                        RandomAccess ra = out.randomAccess();
                        int[] pos = new int[dims.length];
                        for (int i = 0; i < total; i++) {
                            long rem = i;
                            for (int d = 0; d < dims.length; d++) { pos[d] = (int) (rem % dims[d]); rem /= dims[d]; }
                            ra.setPosition(pos);
                            vals[i] = ((net.imglib2.type.numeric.RealType) ra.get()).getRealFloat();
                        }
                        double[] dd = new double[dims.length]; for (int q = 0; q < dd.length; q++) dd[q] = dims[q];
                        cases.add(J.o("params", J.o("doGauss", Boolean.parseBoolean(s[0]), "spacing", s[1], "scales", s[2]),
                            "result", J.o("dims", dd, "type", ra.get().getClass().getName(), "values", J.b64(FijiRefs2.toBytes(vals), "f32", vals.length))));
                    }
                    ImageProcessor src = bits == 8 ? ip.duplicate() : ip.convertToShort(false);
                    if (bits == 16) { for (int i = 0; i < w * h; i++) src.set(i, ip.get(i) * 200); }
                    new Fx("fiji/frangi", "typed_blobs" + bits, "frangi").call("CommandService.run(FrangiVesselness, input = ArrayImg<" + (bits == 8 ? "UnsignedByteType" : "UnsignedShortType") + "> (the type the GUI gives an " + bits + "-bit image; 16-bit = the blobs values x 200), doGauss, spacingString, scaleString)")
                        .input(src).put("cases", cases).write();
                }
            } catch (Throwable e) { e.printStackTrace(); }
        }, "Run$_frangityped");
        t.start();
        t.join();
        System.exit(0);
    }
}
