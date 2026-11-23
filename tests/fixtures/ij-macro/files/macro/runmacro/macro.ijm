r = runMacro("{ROOT}m.ijm", "hello world");
print("returned [" + r + "]");
r2 = runMacro("{ROOT}m.ijm");
print("returned without arg [" + r2 + "]");
