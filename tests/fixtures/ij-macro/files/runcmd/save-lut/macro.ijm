newImage("img", "8-bit ramp", 16, 16, 1);
run("Fire");
run("LUT...", "path=[{ROOT}t.lut]");
print("title " + getTitle());
print("exists " + File.exists("{ROOT}t.lut"));
