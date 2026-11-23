setAutoThreshold("Default no-reset");
//run("Threshold...");
setThreshold(100, 255, "raw");
//setThreshold(100, 255);
setOption("BlackBackground", false);
run("Convert to Mask");
