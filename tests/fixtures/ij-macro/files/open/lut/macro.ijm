newImage("img", "8-bit ramp", 16, 16, 1);
getLut(r0, g0, b0);
print("before " + r0[255] + " " + g0[255] + " " + b0[255]);
open("{ROOT}fire.lut");
getLut(r, g, b);
print("after " + r[255] + " " + g[255] + " " + b[255] + " " + r[128] + " " + g[128] + " " + b[128]);
print("title " + getTitle());
