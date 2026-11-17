import ij.process.*;
import ij.gui.*;
import java.awt.Polygon;
import java.io.*;
import java.nio.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.util.*;

/** JSON helpers + fixture builder. Deterministic: no clocks, no hash-order dependence. */
final class J {
    static final class Raw { final String s; Raw(String s) { this.s = s; } }

    static String q(String s) {
        StringBuilder b = new StringBuilder("\"");
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            switch (c) {
                case '"': b.append("\\\""); break;
                case '\\': b.append("\\\\"); break;
                case '\n': b.append("\\n"); break;
                case '\r': b.append("\\r"); break;
                case '\t': b.append("\\t"); break;
                default:
                    if (c < 0x20) b.append(String.format("\\u%04x", (int) c)); else b.append(c);
            }
        }
        return b.append('"').toString();
    }

    static String num(double d) {
        if (Double.isNaN(d)) return "null";
        if (Double.isInfinite(d)) return d > 0 ? "\"Infinity\"" : "\"-Infinity\"";
        if (d == Math.rint(d) && Math.abs(d) < 1e15) return Long.toString((long) d);
        return Double.toString(d);
    }

    static String flt(float f) {
        if (Float.isNaN(f)) return "null";
        if (Float.isInfinite(f)) return f > 0 ? "\"Infinity\"" : "\"-Infinity\"";
        if (f == Math.rint(f) && Math.abs(f) < 1e7f) return Long.toString((long) f);
        return Float.toString(f);
    }

    @SuppressWarnings("unchecked")
    static String val(Object o) {
        if (o == null) return "null";
        if (o instanceof Raw) return ((Raw) o).s;
        if (o instanceof Boolean || o instanceof Integer || o instanceof Long || o instanceof Short || o instanceof Byte) return o.toString();
        if (o instanceof Double) return num((Double) o);
        if (o instanceof Float) return flt((Float) o);
        if (o instanceof String) return q((String) o);
        StringBuilder b = new StringBuilder();
        if (o instanceof Map) {
            b.append('{');
            boolean first = true;
            for (Map.Entry<String, Object> e : ((Map<String, Object>) o).entrySet()) {
                if (!first) b.append(',');
                first = false;
                b.append(q(e.getKey())).append(':').append(val(e.getValue()));
            }
            return b.append('}').toString();
        }
        if (o instanceof List) {
            b.append('[');
            boolean first = true;
            for (Object x : (List<Object>) o) { if (!first) b.append(','); first = false; b.append(val(x)); }
            return b.append(']').toString();
        }
        if (o instanceof int[]) { int[] a = (int[]) o; b.append('['); for (int i = 0; i < a.length; i++) { if (i > 0) b.append(','); b.append(a[i]); } return b.append(']').toString(); }
        if (o instanceof double[]) { double[] a = (double[]) o; b.append('['); for (int i = 0; i < a.length; i++) { if (i > 0) b.append(','); b.append(num(a[i])); } return b.append(']').toString(); }
        if (o instanceof float[]) { float[] a = (float[]) o; b.append('['); for (int i = 0; i < a.length; i++) { if (i > 0) b.append(','); b.append(flt(a[i])); } return b.append(']').toString(); }
        if (o instanceof String[]) { String[] a = (String[]) o; b.append('['); for (int i = 0; i < a.length; i++) { if (i > 0) b.append(','); b.append(q(a[i])); } return b.append(']').toString(); }
        if (o instanceof boolean[]) { boolean[] a = (boolean[]) o; b.append('['); for (int i = 0; i < a.length; i++) { if (i > 0) b.append(','); b.append(a[i]); } return b.append(']').toString(); }
        if (o instanceof Object[]) { Object[] a = (Object[]) o; b.append('['); for (int i = 0; i < a.length; i++) { if (i > 0) b.append(','); b.append(val(a[i])); } return b.append(']').toString(); }
        throw new IllegalArgumentException("json: " + o.getClass());
    }

    static Map<String, Object> o(Object... kv) {
        LinkedHashMap<String, Object> m = new LinkedHashMap<>();
        for (int i = 0; i < kv.length; i += 2) m.put((String) kv[i], kv[i + 1]);
        return m;
    }

    static Map<String, Object> b64(byte[] bytes, String dtype, int length) {
        return o("b64", Base64.getEncoder().encodeToString(bytes), "dtype", dtype, "length", length);
    }

    /** Data array of a processor: plain array (<= 256 values, floats finite or NaN) or {b64,dtype,length}. */
    static Object data(ImageProcessor ip) {
        Object px = ip.getPixels();
        if (px instanceof byte[]) {
            byte[] a = (byte[]) px;
            if (a.length <= 256) { int[] r = new int[a.length]; for (int i = 0; i < r.length; i++) r[i] = a[i] & 255; return r; }
            return b64(a, "u8", a.length);
        }
        if (px instanceof short[]) {
            short[] a = (short[]) px;
            if (a.length <= 256) { int[] r = new int[a.length]; for (int i = 0; i < r.length; i++) r[i] = a[i] & 0xffff; return r; }
            ByteBuffer bb = ByteBuffer.allocate(a.length * 2).order(ByteOrder.LITTLE_ENDIAN);
            for (short s : a) bb.putShort(s);
            return b64(bb.array(), "u16", a.length);
        }
        if (px instanceof float[]) {
            float[] a = (float[]) px;
            boolean inf = false;
            for (float f : a) if (Float.isInfinite(f)) { inf = true; break; }
            if (a.length <= 256 && !inf) return a;
            ByteBuffer bb = ByteBuffer.allocate(a.length * 4).order(ByteOrder.LITTLE_ENDIAN);
            for (float f : a) bb.putFloat(f);
            return b64(bb.array(), "f32", a.length);
        }
        throw new IllegalArgumentException("pixels " + px.getClass());
    }

    static Map<String, Object> image(ImageProcessor ip) {
        return o("width", ip.getWidth(), "height", ip.getHeight(), "bitDepth", ip.getBitDepth(), "data", data(ip));
    }

    /** u8 0/1 mask as {b64} or plain array. */
    static Object maskData(byte[] m01) {
        if (m01.length <= 256) { int[] r = new int[m01.length]; for (int i = 0; i < r.length; i++) r[i] = m01[i]; return r; }
        return b64(m01, "u8", m01.length);
    }

    /** ImageJ roi mask (0/255) -> {x,y,w,h,data 0/1}; null for a plain rectangle. */
    static Map<String, Object> mask(Roi r) {
        ImageProcessor m = r.getMask();
        java.awt.Rectangle b = r.getBounds();
        if (m == null) return null;
        byte[] src = (byte[]) m.getPixels();
        byte[] d = new byte[src.length];
        for (int i = 0; i < d.length; i++) d[i] = (byte) (src[i] != 0 ? 1 : 0);
        return o("x", b.x, "y", b.y, "w", m.getWidth(), "h", m.getHeight(), "data", maskData(d));
    }

    static Map<String, Object> roi(Roi r) {
        java.awt.Rectangle b = r.getBounds();
        int t = r.getType();
        LinkedHashMap<String, Object> m = new LinkedHashMap<>();
        if (t == Roi.RECTANGLE) {
            m.put("type", "rect"); m.put("x", b.x); m.put("y", b.y); m.put("w", b.width); m.put("h", b.height);
        } else if (t == Roi.OVAL) {
            m.put("type", "oval"); m.put("x", b.x); m.put("y", b.y); m.put("w", b.width); m.put("h", b.height);
        } else {
            Polygon p = r.getPolygon();
            int[] pts = new int[p.npoints * 2];
            for (int i = 0; i < p.npoints; i++) { pts[2 * i] = p.xpoints[i]; pts[2 * i + 1] = p.ypoints[i]; }
            m.put("type", "polygon"); m.put("pts", pts);
            if (t == Roi.TRACED_ROI) m.put("traced", true);
        }
        Map<String, Object> mk = mask(r);
        if (mk != null) m.put("mask", mk);
        return m;
    }

    static float[] floatPts(float[] xs, float[] ys, int n) {
        float[] a = new float[2 * n];
        for (int i = 0; i < n; i++) { a[2 * i] = xs[i]; a[2 * i + 1] = ys[i]; }
        return a;
    }
}

final class Fx {
    static Path root;
    static final List<String> written = new ArrayList<>();
    final String pkg, name;
    final LinkedHashMap<String, Object> m = new LinkedHashMap<>();

    Fx(String pkg, String name, String op) {
        this.pkg = pkg; this.name = name;
        m.put("imagej", "1.54p"); m.put("case", name); m.put("op", op);
    }
    Fx call(String s) { m.put("call", s); return this; }
    Fx params(Object... kv) { m.put("params", J.o(kv)); return this; }
    Fx put(String k, Object v) { m.put(k, v); return this; }
    Fx input(ImageProcessor ip) { m.put("input", J.image(ip)); return this; }
    Fx roi(Roi r) { m.put("roi", J.roi(r)); return this; }
    Fx output(ImageProcessor ip) { m.put("output", J.image(ip)); return this; }
    Fx result(Object r) { m.put("result", r); return this; }

    void write() {
        try {
            Path dir = root.resolve(pkg);
            Files.createDirectories(dir);
            Path f = dir.resolve(name + ".json");
            Files.write(f, (J.val(m) + "\n").getBytes(StandardCharsets.UTF_8));
            written.add(pkg + "/" + name + ".json");
        } catch (IOException e) { throw new UncheckedIOException(e); }
    }
}
