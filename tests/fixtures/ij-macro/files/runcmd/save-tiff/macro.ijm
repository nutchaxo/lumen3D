newImage("img", "8-bit ramp", 16, 16, 1);

run("Tiff...", "path=[{ROOT}t.tif]");
print("title " + getTitle());
print("exists " + File.exists("{ROOT}t.tif"));
