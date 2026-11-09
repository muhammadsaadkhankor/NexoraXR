// Deterministic seeded RNG for the floor benchmark — every scenario draw is
// reproducible from the recorded seed.
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Exponential variate with mean `meanMs` — Poisson-like inter-arrival times.
export function expovariate(rng, meanMs) {
  return -Math.log(1 - rng()) * meanMs;
}
