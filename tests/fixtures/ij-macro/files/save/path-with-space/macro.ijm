newImage("img", "8-bit ramp", 16, 16, 1);
saveAs("Tiff", "{ROOT}my image.tif");
print("title " + getTitle());
print("exists " + File.exists("{ROOT}my image.tif"));
