newImage("img", "8-bit ramp", 16, 16, 1);

run("PGM...", "path=[{ROOT}t.pgm]");
print("title " + getTitle());
print("exists " + File.exists("{ROOT}t.pgm"));
