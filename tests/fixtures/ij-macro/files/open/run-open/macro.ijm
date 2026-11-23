run("Open...", "open=[{ROOT}a b.tif]");
print("title " + getTitle() + " " + getWidth() + "x" + getHeight());
print("image.directory " + getInfo("image.directory") + " image.filename " + getInfo("image.filename"));
