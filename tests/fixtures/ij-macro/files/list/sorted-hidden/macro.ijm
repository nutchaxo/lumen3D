a = getFileList("{ROOT}");
print("count " + a.length);
for (i = 0; i < a.length; i++) print(i + " " + a[i]);
b = getFileList("{ROOT}sub");
print("sub count " + b.length);
for (i = 0; i < b.length; i++) print(i + " " + b[i]);
c = getFileList("{ROOT}sub/");
print("sub/ count " + c.length);
