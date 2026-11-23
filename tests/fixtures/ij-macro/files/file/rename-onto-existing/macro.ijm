print("rename onto existing " + File.rename("{ROOT}r3.txt", "{ROOT}r4.txt"));
print("after " + File.exists("{ROOT}r3.txt") + " " + File.exists("{ROOT}r4.txt"));
print("content " + File.openAsString("{ROOT}r4.txt"));
