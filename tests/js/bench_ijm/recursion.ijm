// recursion: fib(25) = 242785 calls
function fib(n) {
  if (n < 2) return n;
  return fib(n - 1) + fib(n - 2);
}
t0 = getTime();
r = fib(25);
print("ELAPSED " + (getTime() - t0) + " " + r);
