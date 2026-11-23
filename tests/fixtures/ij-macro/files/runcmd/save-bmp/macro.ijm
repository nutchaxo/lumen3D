newImage("img", "8-bit ramp", 16, 16, 1);

run("BMP...", "path=[{ROOT}t.bmp]");
print("title " + getTitle());
print("exists " + File.exists("{ROOT}t.bmp"));
