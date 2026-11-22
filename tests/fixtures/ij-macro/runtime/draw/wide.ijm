function dump() { for (y=0; y<getHeight; y++) { s=""; for (x=0; x<getWidth; x++) s=s+getPixel(x,y)+" "; print(s); } }
newImage("a", "8-bit black", 16, 14, 1);
setColor(255); setLineWidth(2); drawLine(1,1,14,6); setColor(120); setLineWidth(3); drawLine(2,12,13,9); setColor(60); setLineWidth(3); drawRect(3,3,8,6); dump();
