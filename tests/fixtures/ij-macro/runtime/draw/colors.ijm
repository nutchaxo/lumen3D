function dump() { for (y=0; y<getHeight; y++) { s=""; for (x=0; x<getWidth; x++) s=s+getPixel(x,y)+" "; print(s); } }
newImage("a", "8-bit black", 4, 2, 1);
setColor(255,0,0); fillRect(0,0,1,1); setColor("green"); fillRect(1,0,1,1); setColor(10,20,30); fillRect(2,0,1,1); setColor("#808080"); fillRect(3,0,1,1);
setForegroundColor(1,2,3); fillRect(0,1,1,1); setForegroundColor(200,200,200); fillRect(1,1,1,1); setColor(17); fillRect(2,1,1,1); dump();
newImage("s", "16-bit black", 3, 1, 1); setMinAndMax(100, 1100); setColor(255,255,255); fillRect(0,0,1,1); setColor(128,128,128); fillRect(1,0,1,1); setColor(0,0,0); fillRect(2,0,1,1); dump();
newImage("f", "32-bit black", 3, 1, 1); setMinAndMax(-1, 1); setColor(255,255,255); fillRect(0,0,1,1); setColor(64,64,64); fillRect(1,0,1,1); setColor(2.5); fillRect(2,0,1,1); dump();
newImage("c", "RGB black", 2, 1, 1); setColor(1,2,3); fillRect(0,0,1,1); setColor(0x0a0b0c); fillRect(1,0,1,1); dump();
