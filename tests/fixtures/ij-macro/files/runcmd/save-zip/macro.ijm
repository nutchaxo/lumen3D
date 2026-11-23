newImage("img", "8-bit ramp", 16, 16, 1);

run("ZIP...", "path=[{ROOT}t.zip]");
print("title " + getTitle());
print("exists " + File.exists("{ROOT}t.zip"));
