// 512 x 512 nested loop through the host's getPixel / setPixel
w = getWidth();
h = getHeight();
t0 = getTime();
for (y = 0; y < h; y++)
  for (x = 0; x < w; x++)
    setPixel(x, y, (getPixel(x, y) + x + y) % 256);
print("ELAPSED " + (getTime() - t0) + " " + getPixel(10, 10));
