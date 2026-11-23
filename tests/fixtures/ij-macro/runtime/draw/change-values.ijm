function dump() { for (y=0; y<getHeight; y++) { s=""; for (x=0; x<getWidth; x++) s=s+getPixel(x,y)+" "; print(s); } }
newImage("a", "8-bit black", 8, 6, 1);
for (y=0; y<getHeight; y++) for (x=0; x<getWidth; x++) setPixel(x, y, (x*7+y*13)%256);
changeValues(10, 60, 255); dump(); makeOval(1,1,5,4); changeValues(0, 255, 3); makeRectangle(0,0,0,0); dump();
newImage("f", "32-bit black", 4, 3, 1); setPixel(1,1,NaN); setPixel(2,1,5); changeValues(NaN, NaN, -1); changeValues(4, 6, 2.5); dump();
newImage("s", "16-bit black", 4, 3, 1); setPixel(0,0,500); changeValues(400, 600, 90000); print(getPixel(0,0));
