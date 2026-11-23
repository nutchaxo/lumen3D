newImage("img", "16-bit ramp", 16, 16, 1);

run("Raw Data...", "path=[{ROOT}t.raw]");
print("title " + getTitle());
print("exists " + File.exists("{ROOT}t.raw"));
