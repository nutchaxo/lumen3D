open("{ROOT}x.tiff");
print("tiff: name [" + File.name + "] without [" + File.nameWithoutExtension + "] dir [" + File.directory + "]");
open("{ROOT}sub/y.longext");
print("longext: name [" + File.name + "] without [" + File.nameWithoutExtension + "] dir [" + File.directory + "]");
open("{ROOT}sub/z.abc");
print("abc: name [" + File.name + "] without [" + File.nameWithoutExtension + "] dir [" + File.directory + "]");
print("title " + getTitle());
print("image.directory " + getInfo("image.directory") + " image.filename " + getInfo("image.filename"));
