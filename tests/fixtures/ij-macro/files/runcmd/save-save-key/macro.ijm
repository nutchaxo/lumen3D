newImage("img", "8-bit ramp", 16, 16, 1);
run("Tiff...", "save=[{ROOT}s.tif]");
print("title " + getTitle());
run("PNG...", "save=[{ROOT}s.png]");
print("title " + getTitle());
