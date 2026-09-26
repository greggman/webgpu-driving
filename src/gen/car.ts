// Procedural car bodies. A body is lofted from cross-section rings placed
// along the car's length: the side profile (roof/hood/trunk line and the
// underside with wheel arches), plan-view taper, and a tumblehome greenhouse
// are all parametric per archetype. Local frame: +z forward, +y up, +x left,
// origin on the ground midway between the axles.

export type CarKind = 'sedan' | 'hatch' | 'suv' | 'coupe' | 'wagon' | 'pickup';
export const CAR_KINDS: CarKind[] = [
  'sedan',
  'hatch',
  'suv',
  'coupe',
  'wagon',
  'pickup',
];

// Material ids (see car.wgsl).
export const MAT_PAINT = 0;
export const MAT_GLASS = 1;
export const MAT_TRIM = 2;
export const MAT_FRONT = 3;
export const MAT_REAR = 4;
export const MAT_UNDER = 5;
export const MAT_CHROME = 6;
export const MAT_TIRE = 7;
export const MAT_RIM = 8;

export interface CarSpec {
  kind: CarKind;
  length: number;
  width: number;
  wheelbase: number;
  wheelR: number;
  track: number;
  // Side profile top line: [z (m, + forward), y] from front to back.
  top: Array<[number, number]>;
  belt: number; // beltline height
  // Greenhouse z ranges: windshield base, roof front, roof back, rear glass base.
  wsBase: number;
  roofFront: number;
  roofBack: number;
  rearBase: number;
  bedFront?: number; // pickup bed start (z)
}

export function carSpec(kind: CarKind): CarSpec {
  switch (kind) {
    case 'sedan':
      return {
        kind,
        length: 4.75,
        width: 1.84,
        wheelbase: 2.8,
        wheelR: 0.33,
        track: 1.58,
        top: [
          [2.37, 0.55],
          [2.3, 0.72],
          [2.0, 0.82],
          [1.05, 0.95],
          [0.25, 1.42],
          [-0.75, 1.44],
          [-1.55, 1.05],
          [-2.2, 1.0],
          [-2.37, 0.62],
        ],
        belt: 0.98,
        wsBase: 1.05,
        roofFront: 0.25,
        roofBack: -0.75,
        rearBase: -1.55,
      };
    case 'hatch':
      return {
        kind,
        length: 4.1,
        width: 1.78,
        wheelbase: 2.6,
        wheelR: 0.31,
        track: 1.54,
        top: [
          [2.05, 0.55],
          [1.98, 0.74],
          [1.6, 0.86],
          [0.95, 0.98],
          [0.15, 1.45],
          [-1.35, 1.44],
          [-1.9, 1.12],
          [-2.05, 0.62],
        ],
        belt: 1.0,
        wsBase: 0.95,
        roofFront: 0.15,
        roofBack: -1.35,
        rearBase: -1.9,
      };
    case 'suv':
      return {
        kind,
        length: 4.8,
        width: 1.95,
        wheelbase: 2.85,
        wheelR: 0.38,
        track: 1.66,
        top: [
          [2.4, 0.72],
          [2.32, 0.95],
          [1.95, 1.06],
          [1.2, 1.15],
          [0.45, 1.72],
          [-1.9, 1.74],
          [-2.3, 1.5],
          [-2.4, 0.8],
        ],
        belt: 1.18,
        wsBase: 1.2,
        roofFront: 0.45,
        roofBack: -1.9,
        rearBase: -2.3,
      };
    case 'coupe':
      return {
        kind,
        length: 4.5,
        width: 1.88,
        wheelbase: 2.65,
        wheelR: 0.34,
        track: 1.6,
        top: [
          [2.25, 0.5],
          [2.18, 0.66],
          [1.8, 0.76],
          [0.8, 0.9],
          [-0.1, 1.28],
          [-0.8, 1.27],
          [-1.9, 0.98],
          [-2.25, 0.62],
        ],
        belt: 0.92,
        wsBase: 0.8,
        roofFront: -0.1,
        roofBack: -0.8,
        rearBase: -1.9,
      };
    case 'wagon':
      return {
        kind,
        length: 4.85,
        width: 1.84,
        wheelbase: 2.85,
        wheelR: 0.33,
        track: 1.58,
        top: [
          [2.42, 0.55],
          [2.35, 0.72],
          [2.0, 0.82],
          [1.1, 0.95],
          [0.3, 1.45],
          [-2.05, 1.44],
          [-2.35, 1.2],
          [-2.42, 0.62],
        ],
        belt: 0.98,
        wsBase: 1.1,
        roofFront: 0.3,
        roofBack: -2.05,
        rearBase: -2.35,
      };
    case 'pickup':
      return {
        kind,
        length: 5.4,
        width: 2.0,
        wheelbase: 3.4,
        wheelR: 0.4,
        track: 1.7,
        top: [
          [2.7, 0.85],
          [2.62, 1.1],
          [2.2, 1.18],
          [1.45, 1.25],
          [0.85, 1.85],
          [-0.35, 1.86],
          [-0.45, 1.25],
          [-2.62, 1.22],
          [-2.7, 0.9],
        ],
        belt: 1.27,
        wsBase: 1.45,
        roofFront: 0.85,
        roofBack: -0.35,
        rearBase: -0.45,
        bedFront: -0.5,
      };
  }
}

// Monotone-in-z Catmull-Rom interpolation of the top profile.
function topAt(spec: CarSpec, z: number): number {
  const t = spec.top;
  if (z >= t[0][0]) return t[0][1];
  if (z <= t[t.length - 1][0]) return t[t.length - 1][1];
  let i = 0;
  while (i < t.length - 2 && z < t[i + 1][0]) i++;
  const p0 = t[Math.max(i - 1, 0)],
    p1 = t[i],
    p2 = t[i + 1],
    p3 = t[Math.min(i + 2, t.length - 1)];
  const u = (p1[0] - z) / (p1[0] - p2[0]);
  const u2 = u * u,
    u3 = u2 * u;
  // Hard corners at the greenhouse break points look better with a
  // tension that keeps segments nearly linear.
  const tension = 0.3;
  const m1 = ((p2[1] - p0[1]) / 2) * tension;
  const m2 = ((p3[1] - p1[1]) / 2) * tension;
  return (
    (2 * u3 - 3 * u2 + 1) * p1[1] +
    (u3 - 2 * u2 + u) * m1 +
    (-2 * u3 + 3 * u2) * p2[1] +
    (u3 - u2) * m2
  );
}

export interface MeshData {
  // pos3 normal3 mat1 pad1
  vertices: Float32Array;
  count: number;
}

const V_FLOATS = 8;

export function buildCarBody(spec: CarSpec): MeshData {
  const L = spec.length;
  const hw = spec.width / 2;
  const NS = 56; // stations
  const verts: number[] = [];
  const axleF = spec.wheelbase / 2,
    axleR = -spec.wheelbase / 2;
  const R = spec.wheelR;

  // Station z positions, denser near the ends.
  const zs: number[] = [];
  for (let i = 0; i < NS; ++i) {
    const t = i / (NS - 1);
    const e = 0.5 - 0.5 * Math.cos(t * Math.PI);
    zs.push(L / 2 - (0.6 * t + 0.4 * e) * L);
  }

  const bottomAt = (z: number) => {
    let b = 0.2;
    const zn = Math.abs(z) / (L / 2);
    b += (0.18 * Math.max(0, zn - 0.8)) / 0.2; // overhang lift
    // Wheel arches: raise the underside around each axle.
    for (const az of [axleF, axleR]) {
      const dz = Math.abs(z - az);
      const ar = R + 0.07;
      if (dz < ar) {
        const arch = Math.sqrt(ar * ar - dz * dz);
        b = Math.max(b, R + arch * 0.95);
      }
    }
    return b;
  };
  const widthAt = (z: number, y: number) => {
    const zn = z / (L / 2);
    const front = zn > 0;
    const e = front ? 3.2 : 4.5;
    let w = hw * Math.pow(Math.max(0, 1 - Math.pow(Math.abs(zn), e)), 1 / e);
    w = Math.max(w, hw * 0.55);
    // Slight bulge at wheel arches.
    for (const az of [axleF, axleR]) {
      const dz = Math.abs(z - az);
      w += 0.025 * Math.max(0, 1 - dz / (R + 0.3)) * (y < spec.belt ? 1 : 0);
    }
    return w;
  };

  // Ring for one station: right half from bottom center to top center.
  const ring = (z: number): Array<[number, number, number]> => {
    let top = topAt(spec, z);
    const bed =
      spec.bedFront !== undefined && z < spec.bedFront && z > -L / 2 + 0.15;
    const bottom = Math.min(bottomAt(z), top - 0.1);
    const belt = Math.min(spec.belt, top - 0.02);
    const w = widthAt(z, 0.5);
    const inCabin = z < spec.wsBase + 0.1 && z > spec.rearBase - 0.1;
    const wt = inCabin ? w * (top > spec.belt + 0.2 ? 0.74 : 0.9) : w * 0.93;
    if (bed) top = spec.belt - 0.02;
    return [
      [0, bottom, z],
      [w * 0.86, bottom, z],
      [w * 0.99, bottom + 0.1, z],
      [w, Math.max(bottom + 0.12, belt - 0.22), z],
      [w * 0.985, belt, z],
      [wt, Math.max(belt + 0.01, top - 0.05), z],
      [0, top, z],
    ];
  };

  // Full ring: right side (x negative) then left side (x positive) mirrored,
  // going around: bottom center -> right side -> top center -> left side ->
  // bottom center.
  const fullRing = (z: number): Array<[number, number, number]> => {
    const r = ring(z);
    const out: Array<[number, number, number]> = [];
    for (let i = 0; i < r.length; ++i) out.push([-r[i][0], r[i][1], z]);
    for (let i = r.length - 2; i >= 0; --i) out.push([r[i][0], r[i][1], z]);
    return out;
  };

  const rings = zs.map(fullRing);
  const RN = rings[0].length;

  // Smooth normals via central differences on the (station, ring) grid.
  const normalAt = (i: number, j: number): [number, number, number] => {
    const a = rings[Math.max(i - 1, 0)][j],
      b = rings[Math.min(i + 1, NS - 1)][j];
    const c = rings[i][(j - 1 + RN) % RN],
      d = rings[i][(j + 1) % RN];
    const du = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const dv = [d[0] - c[0], d[1] - c[1], d[2] - c[2]];
    let n: [number, number, number] = [
      du[1] * dv[2] - du[2] * dv[1],
      du[2] * dv[0] - du[0] * dv[2],
      du[0] * dv[1] - du[1] * dv[0],
    ];
    const l = Math.hypot(n[0], n[1], n[2]) || 1;
    n = [n[0] / l, n[1] / l, n[2] / l];
    return n;
  };

  const matFor = (i: number, j: number): number => {
    const z = (zs[i] + zs[i + 1]) / 2;
    // j indexes a segment between ring points j and j+1.
    const half = RN >> 1; // 6
    const k = j < half ? j : RN - 2 - j; // mirror to right-side segment idx
    if (k === 0) return MAT_UNDER;
    if (k === 1) return MAT_TRIM; // rocker / lower valance
    const inGlassZ = z < spec.wsBase - 0.05 && z > spec.rearBase + 0.05;
    if (k === 4 && inGlassZ) {
      // Side windows with A/B/C pillars.
      const bPillar = Math.abs(z - (spec.roofFront + spec.roofBack) / 2) < 0.06;
      const aPillar = z > spec.roofFront - 0.05;
      const cPillar = z < spec.roofBack + 0.05;
      if (
        !bPillar &&
        !(aPillar && z > spec.wsBase - 0.2) &&
        !(cPillar && z < spec.rearBase + 0.2)
      ) {
        return MAT_GLASS;
      }
      return MAT_TRIM;
    }
    if (k === 5) {
      if (z < spec.wsBase - 0.02 && z > spec.roofFront + 0.02) return MAT_GLASS;
      if (z < spec.roofBack - 0.02 && z > spec.rearBase + 0.02)
        return MAT_GLASS;
    }
    return MAT_PAINT;
  };

  const push = (p: number[], n: number[], m: number) => {
    verts.push(p[0], p[1], p[2], n[0], n[1], n[2], m, 0);
  };

  for (let i = 0; i < NS - 1; ++i) {
    for (let j = 0; j < RN - 1; ++j) {
      const a = rings[i][j],
        b = rings[i][j + 1],
        c = rings[i + 1][j],
        d = rings[i + 1][j + 1];
      const na = normalAt(i, j),
        nb = normalAt(i, j + 1),
        nc = normalAt(i + 1, j),
        nd = normalAt(i + 1, j + 1);
      const m = matFor(i, j);
      // Winding: outward-facing CCW.
      push(a, na, m);
      push(c, nc, m);
      push(b, nb, m);
      push(b, nb, m);
      push(c, nc, m);
      push(d, nd, m);
    }
  }
  // End caps (front and rear fascia).
  for (const [ri, mat, dir] of [
    [0, MAT_FRONT, 1],
    [NS - 1, MAT_REAR, -1],
  ] as Array<[number, number, number]>) {
    const r = rings[ri];
    let cx = 0,
      cy = 0;
    for (const p of r) {
      cx += p[0];
      cy += p[1];
    }
    const center = [cx / r.length, cy / r.length, r[0][2] + 0.02 * dir];
    const n = [0, 0, dir];
    for (let j = 0; j < RN - 1; ++j) {
      const a = r[j],
        b = r[j + 1];
      if (dir > 0) {
        push(center, n, mat);
        push(a, n, mat);
        push(b, n, mat);
      } else {
        push(center, n, mat);
        push(b, n, mat);
        push(a, n, mat);
      }
    }
  }
  // Pickup bed walls/floor.
  if (spec.bedFront !== undefined) {
    const z0 = spec.bedFront,
      z1 = -L / 2 + 0.15;
    const y0 = 0.75,
      y1 = spec.belt;
    const w = hw * 0.9;
    const quad = (p: number[][], n: number[], m: number) => {
      push(p[0], n, m);
      push(p[1], n, m);
      push(p[2], n, m);
      push(p[0], n, m);
      push(p[2], n, m);
      push(p[3], n, m);
    };
    quad(
      [
        [-w, y0, z0],
        [w, y0, z0],
        [w, y0, z1],
        [-w, y0, z1],
      ],
      [0, 1, 0],
      MAT_TRIM,
    );
    quad(
      [
        [-w, y1, z0],
        [w, y1, z0],
        [w, y0, z0],
        [-w, y0, z0],
      ],
      [0, 0, -1],
      MAT_PAINT,
    );
  }
  // Side mirrors.
  for (const sx of [-1, 1]) {
    const x = sx * (hw + 0.12),
      y = spec.belt + 0.08,
      z = spec.wsBase - 0.1;
    box(push, [x, y, z], [0.1, 0.07, 0.06], MAT_PAINT);
  }
  // Fix winding of everything so triangles face outward (compare with normal).
  const out = new Float32Array(verts);
  for (let t = 0; t < out.length / V_FLOATS; t += 3) {
    const o = t * V_FLOATS;
    const p0 = [out[o], out[o + 1], out[o + 2]];
    const p1 = [out[o + 8], out[o + 9], out[o + 10]];
    const p2 = [out[o + 16], out[o + 17], out[o + 18]];
    const e1 = [p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]];
    const e2 = [p2[0] - p0[0], p2[1] - p0[1], p2[2] - p0[2]];
    const fn = [
      e1[1] * e2[2] - e1[2] * e2[1],
      e1[2] * e2[0] - e1[0] * e2[2],
      e1[0] * e2[1] - e1[1] * e2[0],
    ];
    const n = [
      out[o + 3] + out[o + 11] + out[o + 19],
      out[o + 4] + out[o + 12] + out[o + 20],
      out[o + 5] + out[o + 13] + out[o + 21],
    ];
    if (fn[0] * n[0] + fn[1] * n[1] + fn[2] * n[2] < 0) {
      // swap vertices 1 and 2
      for (let k = 0; k < V_FLOATS; ++k) {
        const tmp = out[o + 8 + k];
        out[o + 8 + k] = out[o + 16 + k];
        out[o + 16 + k] = tmp;
      }
    }
  }
  return {vertices: out, count: out.length / V_FLOATS};
}

function box(
  push: (p: number[], n: number[], m: number) => void,
  c: number[],
  h: number[],
  m: number,
) {
  const faces: Array<[number[], number[], number[]]> = [
    [
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, 1],
    ],
    [
      [-1, 0, 0],
      [0, 1, 0],
      [0, 0, 1],
    ],
    [
      [0, 1, 0],
      [1, 0, 0],
      [0, 0, 1],
    ],
    [
      [0, -1, 0],
      [1, 0, 0],
      [0, 0, 1],
    ],
    [
      [0, 0, 1],
      [1, 0, 0],
      [0, 1, 0],
    ],
    [
      [0, 0, -1],
      [1, 0, 0],
      [0, 1, 0],
    ],
  ];
  for (const [n, u, v] of faces) {
    const p = (a: number, b: number) => [
      c[0] + (n[0] + u[0] * a + v[0] * b) * h[0],
      c[1] + (n[1] + u[1] * a + v[1] * b) * h[1],
      c[2] + (n[2] + u[2] * a + v[2] * b) * h[2],
    ];
    push(p(-1, -1), n, m);
    push(p(1, -1), n, m);
    push(p(1, 1), n, m);
    push(p(-1, -1), n, m);
    push(p(1, 1), n, m);
    push(p(-1, 1), n, m);
  }
}

// Wheel: tire (tread + sidewalls) and rim disc. Local: axle along x,
// centered at the origin, unit radius scaled per car in the shader.
export function buildWheel(): MeshData {
  const verts: number[] = [];
  const N = 32;
  const halfW = 0.36; // relative to radius (tire width ~ 0.24 m for r=0.33)
  const push = (p: number[], n: number[], m: number) =>
    verts.push(p[0], p[1], p[2], n[0], n[1], n[2], m, 0);
  const rimR = 0.68;
  for (let i = 0; i < N; ++i) {
    const a0 = (i / N) * Math.PI * 2,
      a1 = ((i + 1) / N) * Math.PI * 2;
    const c0 = Math.cos(a0),
      s0 = Math.sin(a0),
      c1 = Math.cos(a1),
      s1 = Math.sin(a1);
    // Tread (slightly rounded via normals).
    const q = (x: number, c: number, s: number, r: number) => [x, c * r, s * r];
    const tn = (c: number, s: number, x: number) => {
      const l = Math.hypot(c, s, x * 0.6);
      return [(x * 0.6) / l, c / l, s / l];
    };
    push(q(halfW, c0, s0, 1), tn(c0, s0, 1), 7);
    push(q(-halfW, c0, s0, 1), tn(c0, s0, -1), 7);
    push(q(halfW, c1, s1, 1), tn(c1, s1, 1), 7);
    push(q(halfW, c1, s1, 1), tn(c1, s1, 1), 7);
    push(q(-halfW, c0, s0, 1), tn(c0, s0, -1), 7);
    push(q(-halfW, c1, s1, 1), tn(c1, s1, -1), 7);
    for (const sx of [1, -1]) {
      // Sidewall ring from rimR to 1.
      const n = [sx, 0, 0];
      const x = sx * halfW;
      push(q(x * 0.9, c0, s0, rimR), n, 7);
      push(q(x, c0, s0, 1), n, 7);
      push(q(x * 0.9, c1, s1, rimR), n, 7);
      push(q(x * 0.9, c1, s1, rimR), n, 7);
      push(q(x, c0, s0, 1), n, 7);
      push(q(x, c1, s1, 1), n, 7);
      // Rim disc (recessed).
      const xr = x * 0.55;
      push([xr, 0, 0], n, 8);
      push(q(xr, c0, s0, rimR), n, 8);
      push(q(xr, c1, s1, rimR), n, 8);
      // Rim barrel lip.
      push(q(xr, c0, s0, rimR), [0, -c0, -s0], 8);
      push(q(x * 0.9, c0, s0, rimR), [0, -c0, -s0], 8);
      push(q(xr, c1, s1, rimR), [0, -c1, -s1], 8);
      push(q(xr, c1, s1, rimR), [0, -c1, -s1], 8);
      push(q(x * 0.9, c0, s0, rimR), [0, -c0, -s0], 8);
      push(q(x * 0.9, c1, s1, rimR), [0, -c1, -s1], 8);
    }
  }
  const out = new Float32Array(verts);
  // Orient triangles to their normals.
  for (let t = 0; t < out.length / V_FLOATS; t += 3) {
    const o = t * V_FLOATS;
    const e1 = [0, 1, 2].map(k => out[o + 8 + k] - out[o + k]);
    const e2 = [0, 1, 2].map(k => out[o + 16 + k] - out[o + k]);
    const fn = [
      e1[1] * e2[2] - e1[2] * e2[1],
      e1[2] * e2[0] - e1[0] * e2[2],
      e1[0] * e2[1] - e1[1] * e2[0],
    ];
    const n = [0, 1, 2].map(
      k => out[o + 3 + k] + out[o + 11 + k] + out[o + 19 + k],
    );
    if (fn[0] * n[0] + fn[1] * n[1] + fn[2] * n[2] < 0) {
      for (let k = 0; k < V_FLOATS; ++k) {
        const tmp = out[o + 8 + k];
        out[o + 8 + k] = out[o + 16 + k];
        out[o + 16 + k] = tmp;
      }
    }
  }
  return {vertices: out, count: out.length / V_FLOATS};
}
