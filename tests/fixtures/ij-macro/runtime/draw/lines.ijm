function dump() { for (y=0; y<getHeight; y++) { s=""; for (x=0; x<getWidth; x++) s=s+getPixel(x,y)+" "; print(s); } }
newImage("a", "8-bit black", 14, 12, 1);
setColor(255); drawLine(0,0,13,5); setColor(128); setLineWidth(1); moveTo(2,11); lineTo(12,2); setColor(77); drawRect(1,1,6,4); dump();
