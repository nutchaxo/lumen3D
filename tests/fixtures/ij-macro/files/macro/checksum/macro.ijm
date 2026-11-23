print("md5 " + IJ.checksum("MD5 file", "{ROOT}c.txt"));
print("sha256 " + IJ.checksum("SHA-256 file", "{ROOT}c.txt"));
print("md5 missing " + IJ.checksum("MD5 file", "{ROOT}nope.txt"));
print("md5 empty " + IJ.checksum("md5 file", "{ROOT}empty.txt"));
print("md5 string " + IJ.checksum("MD5 string", "abc"));
