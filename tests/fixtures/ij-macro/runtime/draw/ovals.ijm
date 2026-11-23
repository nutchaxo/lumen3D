function dump() { for (y=0; y<getHeight; y++) { s=""; for (x=0; x<getWidth; x++) s=s+getPixel(x,y)+" "; print(s); } }
newImage("a", "8-bit black", 16, 14, 1);
setColor(255); drawOval(1,1,9,7); setColor(90); fillOval(8,6,7,7); setColor(30); fillRect(-2,10,5,9); dump();
