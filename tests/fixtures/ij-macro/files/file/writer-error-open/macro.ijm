f = File.open("{ROOT}w.txt");
print(f, "written before the error");
print("before");
x = nosuchfunction();
print("not reached");
