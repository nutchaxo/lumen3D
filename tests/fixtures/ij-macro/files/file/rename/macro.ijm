print("rename " + File.rename("{ROOT}r1.txt", "{ROOT}r2.txt"));
print("after " + File.exists("{ROOT}r1.txt") + " " + File.exists("{ROOT}r2.txt"));
print("content " + File.openAsString("{ROOT}r2.txt"));
print("rename missing " + File.rename("{ROOT}nope.txt", "{ROOT}r5.txt"));
print("rename into missing folder " + File.rename("{ROOT}r2.txt", "{ROOT}nodir/r6.txt"));
print("rename folder " + File.rename("{ROOT}d1", "{ROOT}d2"));
print("folder after " + File.exists("{ROOT}d1") + " " + File.isDirectory("{ROOT}d2") + " " + File.exists("{ROOT}d2/x.txt"));
