newImage("img", "8-bit ramp", 16, 16, 1);
makeRectangle(2, 3, 5, 6);
run("Selection...", "path=[{ROOT}t.roi]");
print("title " + getTitle());
print("exists " + File.exists("{ROOT}t.roi"));
