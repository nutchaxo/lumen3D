newImage("img", "8-bit ramp", 16, 16, 1);

run("Jpeg...", "path=[{ROOT}t.jpg]");
print("title " + getTitle());
print("exists " + File.exists("{ROOT}t.jpg"));
