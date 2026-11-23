f = "{ROOT}a.txt";
d = "{ROOT}sub";
m = "{ROOT}nope.txt";
print("exists " + File.exists(f) + " " + File.exists(d) + " " + File.exists(m));
print("isDirectory " + File.isDirectory(f) + " " + File.isDirectory(d) + " " + File.isDirectory(m));
print("isFile " + File.isFile(f) + " " + File.isFile(d) + " " + File.isFile(m));
print("trailing slash " + File.exists("{ROOT}sub/") + " " + File.isDirectory("{ROOT}sub/") + " " + File.isFile("{ROOT}a.txt/"));
