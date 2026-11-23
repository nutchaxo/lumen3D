print("separator [" + File.separator + "]");
f = File.open("{ROOT}sub/last.txt");
File.close(f);
print("directory [" + File.directory + "]");
print("name [" + File.name + "]");
print("nameWithoutExtension [" + File.nameWithoutExtension + "]");
s = File.openAsString("{ROOT}sub/other.txt");
print("after openAsString: directory [" + File.directory + "] name [" + File.name + "]");
