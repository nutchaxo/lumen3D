// 1e6 iterations: array write + array read + arithmetic
t0 = getTime();
a = newArray(100);
s = 0;
for (i = 0; i < 1000000; i++) {
  a[i % 100] = i * 2;
  s += a[(i + 1) % 100] + i;
}
print("ELAPSED " + (getTime() - t0) + " " + s);
