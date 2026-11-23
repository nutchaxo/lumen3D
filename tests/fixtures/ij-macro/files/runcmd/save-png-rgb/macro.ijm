newImage("img", "RGB ramp", 16, 16, 1);

run("PNG...", "path=[{ROOT}t.png]");
print("title " + getTitle());
print("exists " + File.exists("{ROOT}t.png"));
