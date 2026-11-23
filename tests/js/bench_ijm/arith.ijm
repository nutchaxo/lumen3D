// 1e6 iterations of pure arithmetic
t0 = getTime();
x = 0;
for (i = 0; i < 1000000; i++) {
  x = x + (i * 3) % 7 - i / 5;
}
print("ELAPSED " + (getTime() - t0) + " " + x);
