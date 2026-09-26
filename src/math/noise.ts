// Deterministic hash + gradient noise. The WGSL twin lives in
// src/shaders/noise.wgsl and must produce the same values (up to f32 error),
// because the CPU uses these to place the camera, car, and road on the terrain
// that the GPU renders.

export function pcg(x: number): number {
  const v = (Math.imul(x >>> 0, 747796405) + 2891336453) >>> 0;
  const w = Math.imul(((v >>> ((v >>> 28) + 4)) ^ v) >>> 0, 277803737) >>> 0;
  return ((w >>> 22) ^ w) >>> 0;
}

export function hash2i(ix: number, iy: number): number {
  return pcg((ix + pcg(iy)) >>> 0);
}

export function hash1i(ix: number): number {
  return pcg(ix >>> 0);
}

const INV_U32 = 1 / 4294967296;

export function hash01(ix: number, iy: number): number {
  return hash2i(ix, iy) * INV_U32;
}

// 2D gradient noise with analytic derivatives. Returns [value, dx, dy].
// Value roughly in [-0.7, 0.7].
export function noised(x: number, y: number): [number, number, number] {
  const ix = Math.floor(x),
    iy = Math.floor(y);
  const fx = x - ix,
    fy = y - iy;
  const ux = fx * fx * fx * (fx * (fx * 6 - 15) + 10);
  const uy = fy * fy * fy * (fy * (fy * 6 - 15) + 10);
  const dux = 30 * fx * fx * (fx * (fx - 2) + 1);
  const duy = 30 * fy * fy * (fy * (fy - 2) + 1);
  const g = (cx: number, cy: number): [number, number] => {
    const a = hash2i(cx | 0, cy | 0) * INV_U32 * 6.283185307;
    return [Math.cos(a), Math.sin(a)];
  };
  const ga = g(ix, iy),
    gb = g(ix + 1, iy),
    gc = g(ix, iy + 1),
    gd = g(ix + 1, iy + 1);
  const va = ga[0] * fx + ga[1] * fy;
  const vb = gb[0] * (fx - 1) + gb[1] * fy;
  const vc = gc[0] * fx + gc[1] * (fy - 1);
  const vd = gd[0] * (fx - 1) + gd[1] * (fy - 1);
  const k = va - vb - vc + vd;
  const v = va + ux * (vb - va) + uy * (vc - va) + ux * uy * k;
  const dx =
    ga[0] +
    ux * (gb[0] - ga[0]) +
    uy * (gc[0] - ga[0]) +
    ux * uy * (ga[0] - gb[0] - gc[0] + gd[0]) +
    dux * (uy * k + (vb - va));
  const dy =
    ga[1] +
    ux * (gb[1] - ga[1]) +
    uy * (gc[1] - ga[1]) +
    ux * uy * (ga[1] - gb[1] - gc[1] + gd[1]) +
    duy * (ux * k + (vc - va));
  return [v, dx, dy];
}

export function noise(x: number, y: number): number {
  return noised(x, y)[0];
}

// 1D smooth value noise in [-1, 1] (used for road curvature).
export function noise1(x: number, seed: number): number {
  const i = Math.floor(x);
  const f = x - i;
  const u = f * f * (3 - 2 * f);
  const a = hash2i(i, seed) * INV_U32 * 2 - 1;
  const b = hash2i(i + 1, seed) * INV_U32 * 2 - 1;
  return a + (b - a) * u;
}

export function smoothstep(e0: number, e1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

export function clamp(x: number, a: number, b: number): number {
  return x < a ? a : x > b ? b : x;
}

export function mix(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

// Small seeded PRNG (mulberry32) for CPU-side procedural generation.
export class Rng {
  private s: number;
  constructor(seed: number) {
    this.s = seed >>> 0 || 1;
  }
  next(): number {
    let t = (this.s = (this.s + 0x6d2b79f5) >>> 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  range(a: number, b: number): number {
    return a + (b - a) * this.next();
  }
  int(a: number, b: number): number {
    return Math.floor(this.range(a, b + 1));
  }
  pick<T>(arr: readonly T[]): T {
    return arr[Math.floor(this.next() * arr.length)];
  }
}
