f = File.open("{ROOT}fresh.dat");
print(f, "fresh");
File.close(f);
print("created " + File.length("{ROOT}fresh.dat"));
