newImage("img", "16-bit ramp", 16, 16, 1);

run("FITS...", "path=[{ROOT}t.fits]");
print("title " + getTitle());
print("exists " + File.exists("{ROOT}t.fits"));
