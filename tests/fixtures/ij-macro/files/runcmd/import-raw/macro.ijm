run("Raw...", "open=[{ROOT}r.raw] image=8-bit width=16 height=16 offset=0 number=1 gap=0");
print("title " + getTitle() + " " + getWidth() + "x" + getHeight() + " bitDepth " + bitDepth());
print("pixels " + getPixel(0, 0) + " " + getPixel(15, 0) + " " + getPixel(3, 2));
