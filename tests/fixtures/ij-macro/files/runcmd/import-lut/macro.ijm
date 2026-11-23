newImage("img", "8-bit ramp", 16, 16, 1);
run("LUT... ", "open=[{ROOT}fire.lut]");
getLut(r, g, b);
print("lut " + r[255] + " " + g[255] + " " + b[255] + " " + r[128] + " " + g[128] + " " + b[128]);
print("title " + getTitle());
