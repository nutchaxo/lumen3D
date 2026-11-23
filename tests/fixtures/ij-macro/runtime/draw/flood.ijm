function dump() { for (y=0; y<getHeight; y++) { s=""; for (x=0; x<getWidth; x++) s=s+getPixel(x,y)+" "; print(s); } }
newImage("a", "8-bit black", 10, 8, 1);
setColor(255); drawRect(1,1,6,5); setPixel(4,1,0); setColor(80); floodFill(3,3); dump(); setColor(150); floodFill(0,0,"8-connected"); dump();
