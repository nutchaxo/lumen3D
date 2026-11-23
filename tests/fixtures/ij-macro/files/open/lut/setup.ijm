setBatchMode(true);
newImage("a", "8-bit ramp", 16, 16, 1);
run("Fire");
saveAs("LUT", "{ROOT}fire.lut");
