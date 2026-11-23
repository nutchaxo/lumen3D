newImage("img", "8-bit ramp", 16, 16, 1);
makePolygon(2, 3, 12, 4, 7, 13);
run("XY Coordinates...", "path=[{ROOT}t.txt]");
print("title " + getTitle());
print("exists " + File.exists("{ROOT}t.txt"));
