// Procedural vegetation and rock meshes. Trees are built from recursive
// tapered branch tubes plus alpha-tested leaf/needle cards whose normals point
// out from the crown center (soft, volumetric-looking foliage lighting).
// Each generator produces LOD0 (full) and LOD1 (reduced) meshes; LOD2 is an
// octahedral impostor baked on the GPU.
import {Rng} from '../math/noise';
import {
  MeshBuilder,
  add,
  cross,
  len,
  lerp3,
  mul,
  norm,
  rotate,
  sub,
} from './meshBuilder';

export const MAT_BARK = 0;
export const MAT_LEAF = 1;
export const MAT_NEEDLE = 2;
export const MAT_ROCK = 3;
export const MAT_CACTUS = 4;
export const MAT_BIRCH = 5;
export const MAT_REDWOOD = 6;
export const MAT_DRYLEAF = 7;

export type VegKind =
  | 'oak'
  | 'pine'
  | 'birch'
  | 'redwood'
  | 'bare'
  | 'cactus'
  | 'cypress'
  | 'palm'
  | 'bush'
  | 'rock'
  | 'hedge';

export interface VegMesh {
  kind: VegKind;
  lods: Array<{vertices: Float32Array; indices: Uint32Array}>;
  radius: number; // bounding sphere radius (around center)
  center: [number, number, number];
  height: number;
}

type Build = (mb: MeshBuilder, rng: Rng, lod: number) => void;

function crownCards(
  mb: MeshBuilder,
  rng: Rng,
  tips: number[][],
  crownCenter: number[],
  size: number,
  perTip: number,
  mat: number,
) {
  for (const tip of tips) {
    for (let k = 0; k < perTip; ++k) {
      const off = [rng.range(-1, 1), rng.range(-0.6, 0.8), rng.range(-1, 1)];
      const c = add(tip, mul(off, size * 0.45));
      let n = norm(add(sub(c, crownCenter), [0, size * 0.6, 0]));
      // Random card orientation, biased to face outward.
      const rnd = norm([rng.range(-1, 1), rng.range(-1, 1), rng.range(-1, 1)]);
      const face = norm(add(n, mul(rnd, 0.9)));
      let right = cross(face, [0, 1, 0]);
      if (len(right) < 0.1) right = [1, 0, 0];
      right = norm(right);
      const up = norm(cross(right, face));
      const s = size * rng.range(0.75, 1.2);
      const rot = rng.range(0, Math.PI * 2);
      const r2 = rotate(right, face, rot);
      const u2 = rotate(up, face, rot);
      n = norm(add(n, [0, 0.15, 0]));
      mb.card(c, mul(r2, s * 0.5), mul(u2, s * 0.5), n, mat, 1);
    }
  }
}

function branchTree(
  mb: MeshBuilder,
  rng: Rng,
  lod: number,
  opt: {
    trunkH: number;
    trunkR: number;
    depth: number;
    children: number;
    spread: number;
    lenScale: number;
    upBias: number;
    leafSize: number;
    leavesPerTip: number;
    barkMat: number;
    leafMat: number;
    leaves: boolean;
  },
) {
  const tips: number[][] = [];
  const H = opt.trunkH;
  const windAt = (p: number[]) => Math.min(1, (p[1] / (H * 2)) ** 2 * 0.6);
  const sides = lod === 0 ? 7 : 4;
  const maxDepth = lod === 0 ? opt.depth : Math.max(1, opt.depth - 1);
  const grow = (
    start: number[],
    dir: number[],
    length: number,
    radius: number,
    depth: number,
  ) => {
    // Slightly curved branch.
    const segs = depth === 0 ? 4 : 3;
    const pts: number[][] = [start];
    const radii: number[] = [radius];
    let d = dir;
    let p = start;
    for (let i = 1; i <= segs; ++i) {
      d = norm(
        add(d, [
          rng.range(-0.15, 0.15),
          opt.upBias * 0.15,
          rng.range(-0.15, 0.15),
        ]),
      );
      p = add(p, mul(d, length / segs));
      pts.push(p);
      radii.push(radius * (1 - (0.75 * i) / segs));
    }
    if (radius > 0.012 || lod === 0)
      mb.tube(
        pts,
        radii,
        depth === 0 ? sides : Math.max(3, sides - 2),
        opt.barkMat,
        windAt,
      );
    if (depth >= maxDepth) {
      tips.push(p);
      return;
    }
    const n = depth === 0 ? opt.children + 1 : opt.children;
    for (let c = 0; c < n; ++c) {
      const t = depth === 0 ? rng.range(0.55, 1.0) : rng.range(0.4, 1.0);
      const k = Math.min(Math.floor(t * segs), segs - 1);
      const sp = lerp3(pts[k], pts[k + 1], t * segs - k);
      let axis = norm(
        cross(d, [rng.range(-1, 1), rng.range(-1, 1), rng.range(-1, 1)]),
      );
      if (len(axis) < 0.1) axis = [1, 0, 0];
      let nd = rotate(d, axis, opt.spread * rng.range(0.6, 1.2));
      nd = rotate(nd, d, (c / n) * Math.PI * 2 + rng.range(0, 1));
      nd = norm(add(nd, [0, opt.upBias * 0.3, 0]));
      grow(
        sp,
        nd,
        length * opt.lenScale * rng.range(0.8, 1.1),
        radius * 0.55,
        depth + 1,
      );
    }
    if (depth > 0 && rng.next() < 0.5) tips.push(p);
  };
  grow([0, 0, 0], [0, 1, 0], H, opt.trunkR, 0);
  if (!opt.leaves) return;
  let cx = 0,
    cy = 0,
    cz = 0;
  for (const t of tips) {
    cx += t[0];
    cy += t[1];
    cz += t[2];
  }
  const cc = [cx / tips.length, cy / tips.length, cz / tips.length];
  crownCards(
    mb,
    rng,
    tips,
    cc,
    opt.leafSize * (lod === 0 ? 1 : 1.35),
    lod === 0 ? opt.leavesPerTip : Math.max(1, Math.ceil(opt.leavesPerTip / 2)),
    opt.leafMat,
  );
}

function conifer(
  mb: MeshBuilder,
  rng: Rng,
  lod: number,
  H: number,
  R: number,
  crownStart: number,
  maxBranch: number,
  barkMat: number,
  narrow: number,
) {
  const windAt = (p: number[]) => Math.min(1, (p[1] / H) ** 2 * 0.5);
  mb.tube(
    [
      [0, 0, 0],
      [0, H * 0.5, 0],
      [0, H, 0],
    ],
    [R, R * 0.55, 0.02],
    lod === 0 ? 7 : 4,
    barkMat,
    windAt,
  );
  const step = lod === 0 ? 0.55 : 1.1;
  let rot = rng.range(0, 6);
  for (let y = crownStart; y < H; y += step * rng.range(0.8, 1.2)) {
    const t = (y - crownStart) / (H - crownStart);
    const L = (maxBranch * Math.pow(1 - t, 0.9) + 0.35) * narrow;
    const n = lod === 0 ? 5 : 3;
    rot += 1.3;
    for (let b = 0; b < n; ++b) {
      const a = rot + (b / n) * Math.PI * 2 + rng.range(-0.3, 0.3);
      const dir = norm([Math.cos(a), -0.25 - 0.2 * t * 0, Math.sin(a)]);
      const start = [0, y, 0];
      const end = add(start, mul(dir, L));
      if (lod === 0 && L > 0.8) {
        mb.tube(
          [start, end],
          [0.05 * (1 - t) + 0.02, 0.01],
          3,
          barkMat,
          windAt,
        );
      }
      // Needle cards along the branch, roughly horizontal, drooping.
      const cards = lod === 0 ? Math.max(1, Math.round(L / 0.7)) : 1;
      for (let c = 0; c < cards; ++c) {
        const f = (c + 0.6) / (cards + 0.2);
        const pc = lerp3(start, end, f);
        const right = norm(cross([0, 1, 0], dir));
        const fwd = norm(add(dir, [0, -0.35, 0]));
        const sz = Math.max(0.55, L * 0.55) * (lod === 0 ? 1 : 1.5);
        const nrm = norm(add([dir[0] * 0.6, 1, dir[2] * 0.6], [0, 0, 0]));
        mb.card(
          pc,
          mul(right, sz * 0.6),
          mul(fwd, sz * 0.55),
          nrm,
          MAT_NEEDLE,
          1,
        );
      }
    }
  }
  // Top tuft.
  mb.card(
    [0, H - 0.3, 0],
    [0.35, 0, 0],
    [0, 0.6, 0],
    [0, 0.3, 1],
    MAT_NEEDLE,
    1,
  );
  mb.card(
    [0, H - 0.3, 0],
    [0, 0, 0.35],
    [0, 0.6, 0],
    [1, 0.3, 0],
    MAT_NEEDLE,
    1,
  );
}

const BUILDERS: Record<VegKind, Build> = {
  oak: (mb, rng, lod) =>
    branchTree(mb, rng, lod, {
      trunkH: rng.range(2.6, 3.6),
      trunkR: 0.32,
      depth: 3,
      children: 3,
      spread: 0.75,
      lenScale: 0.85,
      upBias: 0.35,
      leafSize: 2.0,
      leavesPerTip: 5,
      barkMat: MAT_BARK,
      leafMat: MAT_LEAF,
      leaves: true,
    }),
  birch: (mb, rng, lod) =>
    branchTree(mb, rng, lod, {
      trunkH: rng.range(5, 7),
      trunkR: 0.17,
      depth: 3,
      children: 2,
      spread: 0.55,
      lenScale: 0.6,
      upBias: 0.8,
      leafSize: 1.4,
      leavesPerTip: 5,
      barkMat: MAT_BIRCH,
      leafMat: MAT_LEAF,
      leaves: true,
    }),
  bare: (mb, rng, lod) =>
    branchTree(mb, rng, lod, {
      trunkH: rng.range(3, 4.5),
      trunkR: 0.28,
      depth: 4,
      children: 3,
      spread: 0.6,
      lenScale: 0.7,
      upBias: 0.5,
      leafSize: 0.8,
      leavesPerTip: 1,
      barkMat: MAT_BARK,
      leafMat: MAT_DRYLEAF,
      leaves: false,
    }),
  pine: (mb, rng, lod) =>
    conifer(mb, rng, lod, rng.range(12, 18), 0.25, 2.5, 3.2, MAT_BARK, 1),
  redwood: (mb, rng, lod) =>
    conifer(mb, rng, lod, rng.range(26, 34), 0.7, 9, 4.2, MAT_REDWOOD, 0.9),
  cypress: (mb, rng, lod) => {
    const H = rng.range(9, 13);
    mb.tube(
      [
        [0, 0, 0],
        [0, H * 0.3, 0],
      ],
      [0.2, 0.15],
      5,
      MAT_BARK,
      () => 0,
    );
    const n = lod === 0 ? 70 : 28;
    for (let i = 0; i < n; ++i) {
      const t = rng.next();
      const y = 1.5 + t * (H - 1.5);
      const r =
        1.3 *
          Math.sin(Math.PI * Math.min(1, t * 1.15)) *
          (0.6 + 0.4 * (1 - t)) +
        0.2;
      const a = rng.range(0, Math.PI * 2);
      const c = [Math.cos(a) * r * 0.7, y, Math.sin(a) * r * 0.7];
      const nrm = norm([c[0], 0.4, c[2]]);
      const right = norm(cross([0, 1, 0], nrm));
      const sz = lod === 0 ? 1.3 : 2;
      mb.card(
        c,
        mul(right, sz * 0.5),
        [0, sz * 0.8, 0],
        nrm,
        MAT_NEEDLE,
        (y / H) ** 2,
      );
    }
  },
  palm: (mb, rng, lod) => {
    const H = rng.range(7, 10);
    const bend = rng.range(0.5, 1.5);
    const pts: number[][] = [];
    for (let i = 0; i <= 5; ++i) {
      const t = i / 5;
      pts.push([bend * t * t, H * t, 0]);
    }
    mb.tube(
      pts,
      pts.map((_, i) => 0.22 - i * 0.02),
      lod === 0 ? 7 : 4,
      MAT_BARK,
      p => (p[1] / H) ** 2 * 0.4,
    );
    const top = pts[pts.length - 1];
    for (let f = 0; f < 9; ++f) {
      const a = (f / 9) * Math.PI * 2;
      const dir = norm([Math.cos(a), 0.2, Math.sin(a)]);
      const c = add(top, mul(dir, 1.6));
      mb.card(
        c,
        mul(dir, 1.7),
        mul(norm(cross(dir, [0, 1, 0])), 0.5),
        [0, 1, 0],
        MAT_LEAF,
        1,
      );
    }
  },
  cactus: (mb, rng, lod) => {
    const H = rng.range(3.5, 6.5);
    const R = rng.range(0.22, 0.32);
    const sides = lod === 0 ? 12 : 6;
    const trunk: number[][] = [];
    const rr: number[] = [];
    for (let i = 0; i <= 6; ++i) {
      const t = i / 6;
      trunk.push([0, H * t, 0]);
      rr.push(R * (i === 6 ? 0.55 : 1));
    }
    trunk.push([0, H + R * 0.4, 0]);
    rr.push(0.02);
    mb.tube(trunk, rr, sides, MAT_CACTUS, () => 0);
    const arms = rng.int(0, 3);
    for (let a = 0; a < arms; ++a) {
      const ang = rng.range(0, Math.PI * 2);
      const y0 = rng.range(1.4, H * 0.6);
      const out = rng.range(0.5, 0.8);
      const up = rng.range(1.0, Math.min(2.5, H - y0));
      const dx = Math.cos(ang),
        dz = Math.sin(ang);
      const r2 = R * 0.7;
      const pts = [
        [0, y0, 0],
        [dx * out * 0.6, y0 + 0.05, dz * out * 0.6],
        [dx * out, y0 + 0.35, dz * out],
        [dx * out, y0 + up, dz * out],
        [dx * out, y0 + up + r2 * 0.4, dz * out],
      ];
      mb.tube(
        pts,
        [r2, r2, r2, r2 * 0.6, 0.02],
        Math.max(4, sides - 2),
        MAT_CACTUS,
        () => 0,
      );
    }
  },
  bush: (mb, rng, lod) => {
    const n = lod === 0 ? 14 : 6;
    const tips: number[][] = [];
    for (let i = 0; i < n; ++i) {
      const a = rng.range(0, Math.PI * 2);
      const r = rng.range(0, 0.9);
      tips.push([Math.cos(a) * r, rng.range(0.35, 1.1), Math.sin(a) * r]);
    }
    crownCards(mb, rng, tips, [0, 0.4, 0], lod === 0 ? 1.1 : 1.6, 1, MAT_LEAF);
  },
  hedge: (mb, rng, lod) => {
    const n = lod === 0 ? 26 : 10;
    const tips: number[][] = [];
    for (let i = 0; i < n; ++i) {
      tips.push([
        rng.range(-2.4, 2.4),
        rng.range(0.4, 1.6),
        rng.range(-0.7, 0.7),
      ]);
    }
    crownCards(mb, rng, tips, [0, 0.6, 0], lod === 0 ? 1.3 : 1.9, 1, MAT_LEAF);
  },
  rock: (mb, rng, lod) => {
    // Displaced, flattened icosphere.
    const t = (1 + Math.sqrt(5)) / 2;
    let verts: number[][] = [
      [-1, t, 0],
      [1, t, 0],
      [-1, -t, 0],
      [1, -t, 0],
      [0, -1, t],
      [0, 1, t],
      [0, -1, -t],
      [0, 1, -t],
      [t, 0, -1],
      [t, 0, 1],
      [-t, 0, -1],
      [-t, 0, 1],
    ].map(norm);
    let faces = [
      [0, 11, 5],
      [0, 5, 1],
      [0, 1, 7],
      [0, 7, 10],
      [0, 10, 11],
      [1, 5, 9],
      [5, 11, 4],
      [11, 10, 2],
      [10, 7, 6],
      [7, 1, 8],
      [3, 9, 4],
      [3, 4, 2],
      [3, 2, 6],
      [3, 6, 8],
      [3, 8, 9],
      [4, 9, 5],
      [2, 4, 11],
      [6, 2, 10],
      [8, 6, 7],
      [9, 8, 1],
    ];
    const subdiv = lod === 0 ? 3 : 2;
    for (let s = 0; s < subdiv; ++s) {
      const mid = new Map<string, number>();
      const m = (a: number, b: number) => {
        const k = a < b ? `${a},${b}` : `${b},${a}`;
        let i = mid.get(k);
        if (i === undefined) {
          i = verts.length;
          verts.push(norm(lerp3(verts[a], verts[b], 0.5)));
          mid.set(k, i);
        }
        return i;
      };
      const nf: number[][] = [];
      for (const [a, b, c] of faces) {
        const ab = m(a, b),
          bc = m(b, c),
          ca = m(c, a);
        nf.push([a, ab, ca], [b, bc, ab], [c, ca, bc], [ab, bc, ca]);
      }
      faces = nf;
    }
    const seed = rng.range(0, 100);
    const flat = rng.range(0.45, 0.75);
    verts = verts.map(v => {
      let d = 1;
      let f = 1.3;
      let amp = 0.28;
      for (let o = 0; o < 4; ++o) {
        d +=
          amp *
          Math.sin(v[0] * f * 3.1 + seed) *
          Math.sin(v[1] * f * 2.7 + seed * 1.3) *
          Math.sin(v[2] * f * 3.3 + seed * 0.7);
        f *= 2.1;
        amp *= 0.5;
      }
      return [v[0] * d, v[1] * d * flat + 0.2, v[2] * d * 1.1];
    });
    // Flat-ish normals per face for chunky facets.
    for (const [a, b, c] of faces) {
      const n = norm(cross(sub(verts[b], verts[a]), sub(verts[c], verts[a])));
      const ia = mb.vert(verts[a], n, 0, 0, MAT_ROCK, 0);
      const ib = mb.vert(verts[b], n, 1, 0, MAT_ROCK, 0);
      const ic = mb.vert(verts[c], n, 0, 1, MAT_ROCK, 0);
      mb.tri(ia, ib, ic);
    }
  },
};

export function buildVeg(kind: VegKind, seed: number): VegMesh {
  const lods: Array<{vertices: Float32Array; indices: Uint32Array}> = [];
  for (let lod = 0; lod < 2; ++lod) {
    const mb = new MeshBuilder();
    BUILDERS[kind](mb, new Rng(seed), lod);
    lods.push(mb.build());
  }
  // Bounds from LOD0.
  const v = lods[0].vertices;
  let minY = Infinity,
    maxY = -Infinity,
    maxR = 0;
  for (let i = 0; i < v.length; i += 10) {
    minY = Math.min(minY, v[i + 1]);
    maxY = Math.max(maxY, v[i + 1]);
  }
  const cy = (minY + maxY) / 2;
  for (let i = 0; i < v.length; i += 10) {
    maxR = Math.max(maxR, Math.hypot(v[i], v[i + 1] - cy, v[i + 2]));
  }
  return {kind, lods, radius: maxR, center: [0, cy, 0], height: maxY};
}
