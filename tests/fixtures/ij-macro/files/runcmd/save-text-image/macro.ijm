newImage("img", "32-bit ramp", 16, 16, 1);

run("Text Image...", "path=[{ROOT}t.txt]");
print("title " + getTitle());
print("exists " + File.exists("{ROOT}t.txt"));
