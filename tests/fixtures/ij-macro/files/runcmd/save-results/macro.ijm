newImage("img", "8-bit ramp", 16, 16, 1);
run("Clear Results"); run("Set Measurements...", "area mean redirect=None decimal=3"); makeRectangle(0, 0, 8, 8); run("Measure");
run("Results...", "path=[{ROOT}t.csv]");
print("title " + getTitle());
print("exists " + File.exists("{ROOT}t.csv"));
