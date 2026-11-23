open("{ROOT}fire.lut");
print("images " + nImages);
print("title " + getTitle() + " " + getWidth() + "x" + getHeight() + " bitDepth " + bitDepth());
getLut(r, g, b);
print("lut " + r[255] + " " + g[255] + " " + b[255]);
