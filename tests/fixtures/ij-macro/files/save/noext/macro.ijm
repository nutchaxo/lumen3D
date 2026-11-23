newImage("img", "8-bit ramp", 16, 16, 1);
save("{ROOT}o");
print("title " + getTitle());
print("exists o.tif " + File.exists("{ROOT}o.tif"));
