function dump() { for (y=0; y<getHeight; y++) { s=""; for (x=0; x<getWidth; x++) s=s+getPixel(x,y)+" "; print(s); } }
newImage("a", "8-bit black", 12, 10, 1);
setColor(200); makeRectangle(1,1,4,3); fill(); setColor(100); makeOval(5,2,6,5); fill(); setColor(50); makePolygon(0,9,4,5,8,9); fill(); makeRectangle(0,0,0,0); dump();
