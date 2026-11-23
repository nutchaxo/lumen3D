newImage("img", "8-bit ramp", 16, 16, 1);

run("Gif...", "path=[{ROOT}t.gif]");
print("title " + getTitle());
print("exists " + File.exists("{ROOT}t.gif"));
