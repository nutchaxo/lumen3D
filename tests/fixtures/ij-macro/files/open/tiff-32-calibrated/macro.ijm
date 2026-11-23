open("{ROOT}cal32.tif");
getPixelSize(unit, pw, ph);
print("pixel size " + pw + " x " + ph + " " + unit);
getVoxelSize(vw, vh, vd, vunit);
print("voxel size " + vw + " " + vh + " " + vd + " " + vunit);
print("bitDepth " + bitDepth());
print("pixel " + getPixel(8, 0));
print("title " + getTitle());
