// Procedural car bodies (second generation).
//
// A body is two lofts:
//  * the lower body ("tub"): stations along the length, each a superellipse
//    cross-section (boxy but rounded sheet metal) between the underside and a
//    top line that is the hood, the beltline, then the trunk deck; plan-view
//    taper, fender flares and wheel arches (the underside rises around each
//    axle) shape it; flat-ish end caps are the front / rear fascias (lamps,
//    grille, plates are drawn by the shader from local position);
//  * the greenhouse: stations from the rear-glass base to the windshield
//    base, a trapezoid section with tumblehome and rounded roof corners; the
//    windshield rake, roof and rear glass come from its top line. Glass vs.
//    pillars / frit / seals is assigned per quad.
// Plus mirrors on arms, door handles, exhaust tips and plates. All normals
// are smooth (finite differences over each loft grid).
//
// Local frame: +z forward, +y up, +x left; origin on the ground midway
// between the axles.

export type CarKind = 'sedan' | 'hatch' | 'suv' | 'coupe' | 'wagon' | 'pickup';
export const CAR_KINDS: CarKind[] = [
  'sedan',
  'hatch',
  'suv',
  'coupe',
  'wagon',
  'pickup',
];

// Material ids (see car.wgsl). 10-17 are cabin materials (interior.ts).
export const MAT_PAINT = 0;
export const MAT_GLASS = 1;
export const MAT_TRIM = 2;
export const MAT_FRONT = 3;
export const MAT_REAR = 4;
export const MAT_UNDER = 5;
export const MAT_CHROME = 6;
export const MAT_TIRE = 7;
export const MAT_RIM = 8;
export const MAT_PLATE = 20;
export const MAT_DISC = 21;
export const MAT_CALIPER = 22;

export interface CarSpec {
  kind: CarKind;
  length: number;
  width: number;
  wheelbase: number;
  wheelR: number;
  track: number;
  clearance: number;
  noseY: number; // top of the front fascia
  hoodY: number; // hood height at the cowl
  beltF: number; // beltline at the windshield base
  beltR: number; // beltline at the rear glass base
  deckY: number; // trunk / tailgate top
  tailY: number; // top of the rear fascia
  roofY: number;
  roofW: number; // roof half-width as a fraction of the body half-width
  wsBase: number; // windshield base (z)
  roofFront: number;
  roofBack: number;
  rearBase: number; // rear glass base (z)
  sideRear: number; // where the side glass ends (z)
  boxy: number; // superellipse exponent of the lower body section
  cladding: boolean; // black plastic arch / sill cladding
  quarter: boolean; // rear quarter window behind the C pillar
  flare: number; // rear fender flare (m)
  headlightY: number;
  taillightY: number;
  bedFront?: number; // pickup bed start (z)
  // Compatibility with the shader / interior: [front cap y, ..., rear y].
  top: Array<[number, number]>;
  belt: number;
}

function spec(
  s: Omit<CarSpec, 'top' | 'belt' | 'headlightY' | 'taillightY'>,
): CarSpec {
  const headlightY = s.noseY - 0.05;
  const taillightY = s.tailY - 0.1;
  return {
    ...s,
    headlightY,
    taillightY,
    top: [
      [s.length / 2, headlightY],
      [-s.length / 2, taillightY],
    ],
    belt: (s.beltF + s.beltR) / 2,
  };
}

export function carSpec(kind: CarKind): CarSpec {
  switch (kind) {
    case 'sedan':
      return spec({
        kind,
        boxy: 5,
        cladding: false,
        quarter: false,
        flare: 0.025,
        length: 4.82,
        width: 1.86,
        wheelbase: 2.85,
        wheelR: 0.345,
        track: 1.6,
        clearance: 0.15,
        noseY: 0.66,
        hoodY: 0.9,
        beltF: 0.97,
        beltR: 1.02,
        deckY: 1.04,
        tailY: 0.96,
        roofY: 1.44,
        roofW: 0.72,
        wsBase: 0.98,
        roofFront: 0.05,
        roofBack: -0.85,
        rearBase: -1.45,
        sideRear: -1.0,
      });
    case 'hatch':
      return spec({
        kind,
        boxy: 5,
        cladding: false,
        quarter: false,
        flare: 0.03,
        length: 4.08,
        width: 1.8,
        wheelbase: 2.62,
        wheelR: 0.33,
        track: 1.55,
        clearance: 0.15,
        noseY: 0.66,
        hoodY: 0.97,
        beltF: 1.0,
        beltR: 1.06,
        deckY: 1.06,
        tailY: 1.0,
        roofY: 1.47,
        roofW: 0.74,
        wsBase: 0.88,
        roofFront: 0.05,
        roofBack: -1.38,
        rearBase: -1.86,
        sideRear: -1.45,
      });
    case 'suv':
      return spec({
        kind,
        boxy: 7,
        cladding: true,
        quarter: true,
        flare: 0.03,
        length: 4.85,
        width: 1.96,
        wheelbase: 2.9,
        wheelR: 0.405,
        track: 1.68,
        clearance: 0.24,
        noseY: 0.95,
        hoodY: 1.14,
        beltF: 1.15,
        beltR: 1.2,
        deckY: 1.2,
        tailY: 1.12,
        roofY: 1.75,
        roofW: 0.78,
        wsBase: 1.18,
        roofFront: 0.45,
        roofBack: -1.9,
        rearBase: -2.3,
        sideRear: -1.95,
      });
    case 'coupe':
      return spec({
        kind,
        boxy: 4.5,
        cladding: false,
        quarter: false,
        flare: 0.05,
        length: 4.55,
        width: 1.9,
        wheelbase: 2.68,
        wheelR: 0.355,
        track: 1.62,
        clearance: 0.13,
        noseY: 0.6,
        hoodY: 0.86,
        beltF: 0.9,
        beltR: 0.97,
        deckY: 0.96,
        tailY: 0.92,
        roofY: 1.26,
        roofW: 0.68,
        wsBase: 0.82,
        roofFront: -0.18,
        roofBack: -0.75,
        rearBase: -1.85,
        sideRear: -0.85,
      });
    case 'wagon':
      return spec({
        kind,
        boxy: 5.5,
        cladding: false,
        quarter: true,
        flare: 0.025,
        length: 4.9,
        width: 1.86,
        wheelbase: 2.88,
        wheelR: 0.345,
        track: 1.6,
        clearance: 0.15,
        noseY: 0.66,
        hoodY: 0.95,
        beltF: 0.98,
        beltR: 1.04,
        deckY: 1.04,
        tailY: 1.0,
        roofY: 1.46,
        roofW: 0.74,
        wsBase: 1.0,
        roofFront: 0.1,
        roofBack: -2.05,
        rearBase: -2.3,
        sideRear: -1.95,
      });
    case 'pickup':
      return spec({
        kind,
        boxy: 9,
        cladding: true,
        quarter: false,
        flare: 0.03,
        length: 5.5,
        width: 2.0,
        wheelbase: 3.45,
        wheelR: 0.42,
        track: 1.72,
        clearance: 0.27,
        noseY: 1.08,
        hoodY: 1.24,
        beltF: 1.26,
        beltR: 1.27,
        deckY: 1.25,
        tailY: 1.22,
        roofY: 1.9,
        roofW: 0.78,
        wsBase: 1.45,
        roofFront: 0.82,
        roofBack: -0.3,
        rearBase: -0.42,
        sideRear: -0.36,
        bedFront: -0.5,
      });
  }
}

export interface MeshData {
  // pos3 normal3 mat1 pad1
  vertices: Float32Array;
  count: number;
}

const V_FLOATS = 8;

function clamp01(x: number) {
  return Math.min(1, Math.max(0, x));
}
function smooth(a: number, b: number, x: number) {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
}

type P3 = [number, number, number];

// Grid of points [station][ring] -> triangles with smooth normals and a
// per-quad material.
function emitGrid(
  push: (p: number[], n: number[], m: number) => void,
  grid: P3[][],
  mat: (i: number, j: number) => number,
  outward: (p: P3) => P3,
  closedRing: boolean,
) {
  const NS = grid.length,
    NR = grid[0].length;
  const normals: P3[][] = [];
  for (let i = 0; i < NS; ++i) {
    const row: P3[] = [];
    for (let j = 0; j < NR; ++j) {
      const a = grid[Math.max(i - 1, 0)][j],
        b = grid[Math.min(i + 1, NS - 1)][j];
      const jm = closedRing ? (j - 1 + NR) % NR : Math.max(j - 1, 0);
      const jp = closedRing ? (j + 1) % NR : Math.min(j + 1, NR - 1);
      const c = grid[i][jm],
        d = grid[i][jp];
      const du = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
      const dv = [d[0] - c[0], d[1] - c[1], d[2] - c[2]];
      let n: P3 = [
        du[1] * dv[2] - du[2] * dv[1],
        du[2] * dv[0] - du[0] * dv[2],
        du[0] * dv[1] - du[1] * dv[0],
      ];
      const l = Math.hypot(n[0], n[1], n[2]) || 1;
      n = [n[0] / l, n[1] / l, n[2] / l];
      const o = outward(grid[i][j]);
      if (n[0] * o[0] + n[1] * o[1] + n[2] * o[2] < 0)
        n = [-n[0], -n[1], -n[2]];
      row.push(n);
    }
    normals.push(row);
  }
  for (let i = 0; i < NS - 1; ++i) {
    for (let j = 0; j < NR - 1; ++j) {
      const m = mat(i, j);
      if (m < 0) continue;
      const q = [
        [i, j],
        [i + 1, j],
        [i, j + 1],
        [i, j + 1],
        [i + 1, j],
        [i + 1, j + 1],
      ];
      for (const [a, b] of q) push(grid[a][b], normals[a][b], m);
    }
  }
}

export function buildCarBody(sp: CarSpec): MeshData {
  const verts: number[] = [];
  const push = (p: number[], n: number[], m: number) => {
    verts.push(p[0], p[1], p[2], n[0], n[1], n[2], m, 0);
  };
  const L = sp.length,
    HW = sp.width / 2,
    R = sp.wheelR;
  const axles = [sp.wheelbase / 2, -sp.wheelbase / 2];
  const nose = L / 2,
    tail = -L / 2;
  const pickup = sp.bedFront !== undefined;

  // ---- Profiles along z ----
  const belt = (z: number) =>
    sp.beltR +
    (sp.beltF - sp.beltR) *
      clamp01((z - sp.rearBase) / (sp.wsBase - sp.rearBase));
  const topLine = (z: number) => {
    if (z >= sp.wsBase) {
      // Hood: gently convex, rounding over into the nose.
      const t = clamp01((z - sp.wsBase) / (nose - sp.wsBase));
      const hood =
        sp.noseY +
        (Math.min(sp.hoodY, sp.beltF) - sp.noseY) * (1 - Math.pow(t, 2.4));
      return hood - 0.05 * smooth(0.9, 1, t);
    }
    if (z >= sp.rearBase) return belt(z) - 0.005;
    // Deck, falling off into the tail.
    const t = clamp01((sp.rearBase - z) / (sp.rearBase - tail));
    if (pickup) return sp.deckY - 0.02 * smooth(0.96, 1, t);
    const deck =
      sp.tailY +
      (Math.max(sp.deckY, sp.beltR) - sp.tailY) * (1 - Math.pow(t, 3));
    return deck - 0.04 * smooth(0.85, 1, t);
  };
  const halfWidth = (z: number) => {
    const zn = z / (L / 2);
    const e = zn > 0 ? 4.5 : pickup ? 14 : 6;
    let w = HW * Math.pow(Math.max(0, 1 - Math.pow(Math.abs(zn), e)), 1 / e);
    w = Math.max(w, HW * 0.82);
    for (const az of axles) {
      const dz = Math.abs(z - az);
      const f = az > 0 ? 0.022 : sp.flare;
      w += f * Math.max(0, 1 - Math.pow(dz / (R + 0.45), 2));
    }
    return w;
  };
  const archR = R + 0.045;
  const bottomLine = (z: number, top: number) => {
    const zn = Math.abs(z) / (L / 2);
    let b = sp.clearance + 0.1 * smooth(0.72, 1, zn);
    for (const az of axles) {
      const dz = Math.abs(z - az);
      if (dz < archR)
        b = Math.max(b, R + Math.sqrt(archR * archR - dz * dz) * 0.97);
    }
    return Math.min(b, top - 0.22);
  };

  // ---- Lower body loft ----
  const zs: number[] = [];
  const NS = 110;
  for (let i = 0; i < NS; ++i) {
    const t = i / (NS - 1);
    // Denser near both ends.
    const u = t - (Math.sin(t * Math.PI * 2) / (Math.PI * 2)) * 0.6;
    zs.push(nose - u * L);
  }
  const NH = 26; // points per half section
  const nExp = sp.boxy;
  const section = (z: number, endFactor: number): P3[] => {
    const top = topLine(z);
    const bot = bottomLine(z, top);
    const yc = (top + bot) / 2,
      hh = ((top - bot) / 2) * (0.75 + 0.25 * endFactor);
    const w = halfWidth(z) * (0.9 + 0.1 * endFactor);
    const hood = z > sp.wsBase;
    const ring: P3[] = [];
    // Right side (x < 0) from bottom centre up to top centre, then the left
    // side back down (closed ring).
    const half: Array<[number, number]> = [];
    for (let k = 0; k <= NH; ++k) {
      const th = -Math.PI / 2 + (k / NH) * Math.PI;
      const c = Math.cos(th),
        s = Math.sin(th);
      let x = w * Math.pow(Math.abs(c), 2 / nExp);
      let y = yc + hh * Math.sign(s) * Math.pow(Math.abs(s), 2 / nExp);
      // Tumblehome in the upper body, a sharp shoulder crease below the
      // beltline and a concave sculpt line low on the doors.
      const yn = (y - yc) / Math.max(hh, 1e-3);
      x *= 1 - 0.035 * Math.max(0, yn);
      const sh = top - 0.12;
      x +=
        0.014 *
        Math.exp(-Math.abs(y - sh) / 0.012) *
        smooth(0.3, 0.6, yn + 0.5);
      x -=
        0.01 * Math.exp(-Math.pow((y - (bot + (top - bot) * 0.3)) / 0.06, 2));
      if (hood && s > 0) {
        // Hood: centre lowered between two creases running to the lamps.
        const xr = x / w;
        const f = smooth(sp.wsBase, sp.wsBase + 0.15, z);
        y -= 0.035 * f * Math.max(0, 1 - Math.pow(xr / 0.55, 2));
        y += 0.008 * f * Math.exp(-Math.pow((xr - 0.58) / 0.05, 2));
      }
      half.push([x, y]);
    }
    for (let k = 0; k <= NH; ++k) ring.push([-half[k][0], half[k][1], z]);
    for (let k = NH - 1; k >= 0; --k) ring.push([half[k][0], half[k][1], z]);
    return ring;
  };
  const endFactorAt = (z: number) => {
    const e = Math.min(nose - z, z - tail);
    return Math.sqrt(clamp01(e / 0.06));
  };
  const lower: P3[][] = zs.map(z => section(z, endFactorAt(z)));
  const RN = lower[0].length;
  const lowerMat = (i: number, j: number): number => {
    const z = (zs[i] + zs[i + 1]) / 2;
    const k = j < NH ? j : RN - 2 - j; // 0 (bottom) .. NH-1 (top)
    const p = lower[i][j];
    if (k < 3) return MAT_UNDER;
    // Open the top of the tub over the cabin (and the pickup bed).
    const open =
      (z < sp.wsBase - 0.05 && z > sp.rearBase + 0.05) ||
      (pickup && z < sp.bedFront! && z > tail + 0.12);
    if (open && k >= NH - 4) return -1;
    // Black lower cladding / sills.
    const bot = bottomLine(z, topLine(z));
    if (sp.cladding && p[1] < bot + 0.1) return MAT_TRIM;
    const between = Math.abs(z) < sp.wheelbase / 2 - archR;
    if (between && p[1] < bot + 0.05) return MAT_TRIM;
    if (z > nose - 0.3) return MAT_FRONT;
    if (z < tail + 0.3) return MAT_REAR;
    if (pickup && z < sp.bedFront! && k > NH - 5) return MAT_TRIM;
    return MAT_PAINT;
  };
  emitGrid(push, lower, lowerMat, p => [p[0], p[1] - 0.6, p[2] * 0.25], true);
  // Fascia end caps.
  for (const [row, dir] of [
    [lower[0], 1],
    [lower[NS - 1], -1],
  ] as Array<[P3[], number]>) {
    let cx = 0,
      cy = 0;
    for (const p of row) {
      cx += p[0];
      cy += p[1];
    }
    const c = [cx / row.length, cy / row.length, row[0][2] + 0.004 * dir];
    const n = [0, 0, dir];
    for (let j = 0; j < RN - 1; ++j) {
      push(c, n, dir > 0 ? MAT_FRONT : MAT_REAR);
      push(row[j], n, dir > 0 ? MAT_FRONT : MAT_REAR);
      push(row[j + 1], n, dir > 0 ? MAT_FRONT : MAT_REAR);
    }
  }

  // ---- Greenhouse loft ----
  const gz0 = sp.rearBase,
    gz1 = sp.wsBase;
  const GS = 70;
  const gzs: number[] = [];
  for (let i = 0; i < GS; ++i) gzs.push(gz1 - (i / (GS - 1)) * (gz1 - gz0));
  const roofLine = (z: number) => {
    const b = belt(z);
    if (z >= sp.roofFront) {
      const t = clamp01((z - sp.roofFront) / (sp.wsBase - sp.roofFront));
      return b + (sp.roofY - b) * (1 - t * t * (0.6 + 0.4 * t));
    }
    if (z >= sp.roofBack) {
      const t = (z - sp.roofBack) / (sp.roofFront - sp.roofBack);
      return sp.roofY + 0.025 * Math.sin(t * Math.PI);
    }
    const t = clamp01((sp.roofBack - z) / (sp.roofBack - sp.rearBase));
    return b + (sp.roofY - b) * (1 - Math.pow(t, 1.7));
  };
  const GH = 16; // points per half section
  const gsection = (z: number): P3[] => {
    const base = belt(z) - 0.015;
    const top = roofLine(z);
    const h = Math.max(top - base, 0.001);
    const w = halfWidth(z);
    const wb = w * 0.955;
    const wt = w * sp.roofW;
    const rc = Math.min(0.11, h * 0.45); // roof corner radius
    const half: Array<[number, number]> = [];
    // Side from the base up to the corner (tumblehome), then the rounded
    // corner, then across the roof to the centre.
    const sideN = 6,
      cornerN = 6,
      roofN = GH - sideN - cornerN;
    for (let k = 0; k < sideN; ++k) {
      const t = k / sideN;
      const y = base + (h - rc) * t;
      half.push([wb + (wt + rc * 0.4 - wb) * Math.pow(t, 1.3), y]);
    }
    for (let k = 0; k < cornerN; ++k) {
      const a = (k / cornerN) * (Math.PI / 2);
      half.push([
        wt - rc * 0.6 + rc * Math.cos(a),
        top - rc + rc * Math.sin(a) * 0.98,
      ]);
    }
    for (let k = 0; k <= roofN; ++k) {
      const t = k / roofN;
      half.push([
        (wt - rc * 0.6) * (1 - t),
        top - 0.02 * (1 - t) * (1 - t) * 0 + 0.012 * t,
      ]);
    }
    const ring: P3[] = [];
    for (let k = 0; k < half.length; ++k)
      ring.push([-half[k][0], half[k][1], z]);
    for (let k = half.length - 2; k >= 0; --k)
      ring.push([half[k][0], half[k][1], z]);
    return ring;
  };
  const green: P3[][] = gzs.map(gsection);
  const GR = green[0].length;
  const halfLen = (GR + 1) / 2;
  const bPillar = (sp.roofFront + Math.max(sp.roofBack, sp.sideRear)) / 2;
  const greenMat = (i: number, j: number): number => {
    const z = (gzs[i] + gzs[i + 1]) / 2;
    const k = j < halfLen - 1 ? j : GR - 2 - j; // 0 at the base, rising to the roof centre
    if (k === 0) return MAT_TRIM; // window seal on the beltline
    const side = k < 6;
    const corner = k >= 6 && k < 12;
    if (side) {
      if (k >= 5) return MAT_TRIM; // drip rail / window frame
      if (z > sp.wsBase - 0.12) return MAT_PAINT; // A pillar base
      if (sp.quarter && z < sp.sideRear - 0.1 && z > sp.rearBase + 0.2)
        return k === 1 || k === 4 ? MAT_TRIM : MAT_GLASS; // quarter window
      if (z < sp.sideRear) return MAT_PAINT; // C pillar
      if (sp.kind !== 'coupe' && Math.abs(z - bPillar) < 0.055) return MAT_TRIM; // B pillar
      return MAT_GLASS;
    }
    const windshield = z > sp.roofFront + 0.02;
    const rearGlass = z < sp.roofBack - 0.02;
    if (corner) {
      // The windscreen and backlight wrap into the roof corner; the lower
      // part of the corner is the A / C pillar.
      if ((windshield || rearGlass) && k >= 9) {
        if (windshield && z > sp.wsBase - 0.04) return MAT_TRIM;
        if (rearGlass && z < sp.rearBase + 0.04) return MAT_TRIM;
        return k === 9 ? MAT_TRIM : MAT_GLASS;
      }
      return MAT_PAINT;
    }
    if (windshield) return z > sp.wsBase - 0.04 ? MAT_TRIM : MAT_GLASS;
    if (rearGlass) return z < sp.rearBase + 0.04 ? MAT_TRIM : MAT_GLASS;
    return MAT_PAINT; // roof
  };
  emitGrid(push, green, greenMat, p => [p[0], p[1] - 0.6, p[2] * 0.2], false);

  // ---- Details ----
  const quad = (p: number[][], m: number) => {
    const e1 = [p[1][0] - p[0][0], p[1][1] - p[0][1], p[1][2] - p[0][2]];
    const e2 = [p[3][0] - p[0][0], p[3][1] - p[0][1], p[3][2] - p[0][2]];
    const n = [
      e1[1] * e2[2] - e1[2] * e2[1],
      e1[2] * e2[0] - e1[0] * e2[2],
      e1[0] * e2[1] - e1[1] * e2[0],
    ];
    const l = Math.hypot(n[0], n[1], n[2]) || 1;
    const nn = n.map(x => x / l);
    for (const k of [0, 1, 2, 0, 2, 3]) push(p[k], nn, m);
  };
  // Pickup bed: floor, bulkhead, inner walls, rail caps and tailgate.
  if (pickup) {
    const z0 = sp.bedFront! - 0.04,
      z1 = tail + 0.1;
    const y0 = sp.clearance + 0.55,
      y1 = sp.beltR + 0.005;
    const w = HW * 0.84;
    quad(
      [
        [w, y0, z1],
        [-w, y0, z1],
        [-w, y0, z0],
        [w, y0, z0],
      ],
      MAT_TRIM,
    );
    // Floor ribs.
    for (let r = -3; r <= 3; ++r) {
      box(
        push,
        [r * w * 0.28, y0 + 0.012, (z0 + z1) / 2],
        [0.03, 0.012, (z0 - z1) / 2],
        MAT_TRIM,
      );
    }
    quad(
      [
        [-w, y1, z0],
        [w, y1, z0],
        [w, y0, z0],
        [-w, y0, z0],
      ],
      MAT_PAINT,
    );
    quad(
      [
        [w, y1, z1],
        [-w, y1, z1],
        [-w, y0, z1],
        [w, y0, z1],
      ],
      MAT_PAINT,
    );
    for (const sx of [-1, 1]) {
      quad(
        [
          [sx * w, y1, z1],
          [sx * w, y1, z0],
          [sx * w, y0, z0],
          [sx * w, y0, z1],
        ],
        MAT_PAINT,
      );
      // Rail cap.
      box(
        push,
        [sx * (HW * 0.9), y1 + 0.012, (z0 + z1) / 2 - 0.04],
        [HW * 0.08, 0.014, (z0 - z1) / 2 + 0.04],
        MAT_TRIM,
      );
    }
    box(push, [0, y1 + 0.012, z1 - 0.02], [HW * 0.84, 0.014, 0.07], MAT_TRIM);
  }
  // Roof rails.
  if (sp.kind === 'suv' || sp.kind === 'wagon') {
    const n = 14;
    const za = sp.roofFront - 0.05,
      zb = sp.roofBack + 0.1;
    for (const sx of [-1, 1]) {
      for (let q = 0; q < n; ++q) {
        const zq = za + ((zb - za) * (q + 0.5)) / n;
        const x = sx * halfWidth(zq) * sp.roofW * 0.82;
        box(
          push,
          [x, roofLine(zq) + 0.055, zq],
          [0.018, 0.014, Math.abs(zb - za) / n / 2 + 0.004],
          MAT_CHROME,
        );
      }
      for (const zf of [za + 0.05, zb - 0.05]) {
        const x = sx * halfWidth(zf) * sp.roofW * 0.82;
        box(push, [x, roofLine(zf) + 0.025, zf], [0.02, 0.03, 0.05], MAT_TRIM);
      }
    }
  }
  // Mirrors: a rounded housing (lofted ellipses) on an arm from the door
  // sail, with the glass facing back.
  for (const sx of [-1, 1]) {
    const z = sp.wsBase - 0.16;
    const wz = halfWidth(z) * 0.96;
    const y = belt(z) + 0.1;
    const mw = 0.2,
      mh = 0.1,
      md = 0.09;
    const x0 = sx * (wz + 0.07);
    const grid: P3[][] = [];
    const NX = 10,
      NA = 16;
    for (let a = 0; a <= NX; ++a) {
      const t = a / NX; // across the housing
      const sc = Math.pow(
        Math.sin(Math.PI * Math.min(1, 0.08 + t * 0.92)),
        0.35,
      );
      const row: P3[] = [];
      for (let b = 0; b <= NA; ++b) {
        const th = (b / NA) * Math.PI * 2;
        const cz = Math.cos(th),
          sy = Math.sin(th);
        // Flat back (glass side), rounded front.
        const dz = cz > 0 ? cz * md : cz * 0.012;
        row.push([
          x0 + sx * (t - 0.5) * mw,
          y + sy * mh * 0.5 * sc,
          z - 0.02 + dz * sc,
        ]);
      }
      grid.push(row);
    }
    emitGrid(
      push,
      grid,
      () => MAT_PAINT,
      p => [p[0] - x0, p[1] - y, p[2] - z + 0.02],
      true,
    );
    box(push, [x0, y, z - 0.034], [mw * 0.46, mh * 0.44, 0.003], MAT_CHROME);
    // Arm.
    box(
      push,
      [sx * (wz + 0.035), y - 0.035, z - 0.01],
      [0.05, 0.022, 0.04],
      MAT_PAINT,
    );
  }
  // Door handles.
  for (const sx of [-1, 1]) {
    for (const z of [bPillar + 0.45, bPillar - 0.55]) {
      if (z < sp.sideRear || z > sp.wsBase) continue;
      const y = belt(z) - 0.1;
      box(
        push,
        [sx * (halfWidth(z) * 0.985 + 0.006), y, z],
        [0.008, 0.013, 0.07],
        MAT_CHROME,
      );
    }
  }
  // Plates.
  box(
    push,
    [0, sp.headlightY - 0.3, nose + 0.005],
    [0.26, 0.06, 0.006],
    MAT_PLATE,
  );
  box(
    push,
    [0, sp.taillightY - 0.3, tail - 0.005],
    [0.26, 0.065, 0.006],
    MAT_PLATE,
  );
  // Exhaust tips.
  if (sp.kind !== 'suv') {
    for (const sx of [-0.55, 0.55]) {
      box(
        push,
        [sx * HW, sp.clearance + 0.1, tail + 0.12],
        [0.038, 0.026, 0.05],
        MAT_TRIM,
      );
    }
  }
  const out = orient(new Float32Array(verts));
  return {vertices: out, count: out.length / V_FLOATS};
}

// Makes every triangle wind counter-clockwise around its vertex normals, so
// front_facing in the shader tells outside from inside.
function orient(out: Float32Array): Float32Array {
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
  return out;
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
      [0, 0, 1],
      [0, 1, 0],
    ],
    [
      [0, 1, 0],
      [0, 0, 1],
      [1, 0, 0],
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
      [0, 1, 0],
      [1, 0, 0],
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

// Wheel (unit radius; axle along x, outer face at +x): a revolved tyre with
// rounded shoulders, a rim barrel, a disc face with five twin spokes (real
// geometry), a centre cap, a slotted brake disc and a caliper (which the
// shader keeps from spinning). Scaled by the wheel radius in the shader.
export function buildWheel(): MeshData {
  const v: number[] = [];
  const push = (p: number[], n: number[], m: number) =>
    v.push(p[0], p[1], p[2], n[0], n[1], n[2], m, 0);
  const N = 48;
  // Tyre profile (radius, x) around the outer face -> tread -> inner face.
  const prof: Array<[number, number]> = [];
  const hw = 0.33; // half width
  const rim = 0.7;
  prof.push([rim, hw * 0.92]);
  prof.push([0.82, hw * 1.02]);
  prof.push([0.93, hw * 0.98]);
  for (let k = 0; k <= 6; ++k) {
    const a = (k / 6) * Math.PI;
    // Rounded tread crown.
    prof.push([0.965 + 0.035 * Math.sin(a), hw * 0.92 * Math.cos(a)]);
  }
  prof.push([0.93, -hw * 0.98]);
  prof.push([0.82, -hw * 1.02]);
  prof.push([rim, -hw * 0.92]);
  const ring = (r: number, x: number, a: number) => [
    x,
    Math.cos(a) * r,
    Math.sin(a) * r,
  ];
  for (let i = 0; i < N; ++i) {
    const a0 = (i / N) * Math.PI * 2,
      a1 = ((i + 1) / N) * Math.PI * 2;
    for (let k = 0; k < prof.length - 1; ++k) {
      const [r0, x0] = prof[k],
        [r1, x1] = prof[k + 1];
      // Profile normal (in r-x plane), outward.
      const dr = r1 - r0,
        dx = x1 - x0;
      const nl = Math.hypot(dr, dx) || 1;
      const nr = dx / nl,
        nx = -dr / nl;
      const n = (a: number) => [nx, Math.cos(a) * nr, Math.sin(a) * nr];
      const P = [
        ring(r0, x0, a0),
        ring(r1, x1, a0),
        ring(r1, x1, a1),
        ring(r0, x0, a1),
      ];
      const Nn = [n(a0), n(a0), n(a1), n(a1)];
      for (const q of [0, 1, 2, 0, 2, 3]) push(P[q], Nn[q], MAT_TIRE);
    }
    // Rim barrel (inside the tyre bead), facing inward.
    const bx0 = hw * 0.92,
      bx1 = -hw * 0.8;
    const rb = rim - 0.01;
    const nb = (a: number) => [0, -Math.cos(a), -Math.sin(a)];
    const B = [
      ring(rb, bx0, a0),
      ring(rb, bx1, a0),
      ring(rb, bx1, a1),
      ring(rb, bx0, a1),
    ];
    for (const q of [0, 2, 1, 0, 3, 2])
      push(B[q], nb(q === 1 || q === 0 ? a0 : a1), MAT_RIM);
    // Rim lip (outer ring of the face).
    const lip = [
      ring(rim, hw * 0.92, a0),
      ring(0.6, hw * 0.8, a0),
      ring(0.6, hw * 0.8, a1),
      ring(rim, hw * 0.92, a1),
    ];
    for (const q of [0, 1, 2, 0, 2, 3]) push(lip[q], [1, 0, 0], MAT_RIM);
    // Recessed dark face between the spokes (the "hole", shows the disc).
    const face = [
      ring(0.6, hw * 0.35, a0),
      ring(0.2, hw * 0.35, a0),
      ring(0.2, hw * 0.35, a1),
      ring(0.6, hw * 0.35, a1),
    ];
    // Brake disc behind the spokes.
    const disc = [
      ring(0.58, hw * 0.1, a0),
      ring(0.25, hw * 0.1, a0),
      ring(0.25, hw * 0.1, a1),
      ring(0.58, hw * 0.1, a1),
    ];
    for (const q of [0, 1, 2, 0, 2, 3]) push(disc[q], [1, 0, 0], MAT_DISC);
    void face;
  }
  // Five twin spokes: slightly concave, raised above the disc.
  const spoke = (ang: number, width: number) => {
    const c = Math.cos(ang),
      s = Math.sin(ang);
    const t = [0, -s, c]; // tangent (perpendicular to the radial dir)
    const rad = [0, c, s];
    const pts = (r: number, x: number, off: number) => [
      x,
      rad[1] * r + t[1] * off,
      rad[2] * r + t[2] * off,
    ];
    const w0 = width,
      w1 = width * 0.7;
    const inner = 0.19,
      outer = 0.62;
    const xIn = hw * 0.45,
      xOut = hw * 0.8; // concave dish: hub set back from the lip
    // Face.
    const f = [
      pts(inner, xIn, -w0),
      pts(outer, xOut, -w1),
      pts(outer, xOut, w1),
      pts(inner, xIn, w0),
    ];
    for (const q of [0, 1, 2, 0, 2, 3]) push(f[q], [1, 0, 0], MAT_RIM);
    // Sides (give the spoke depth).
    for (const sgn of [-1, 1]) {
      const ww0 = w0 * sgn,
        ww1 = w1 * sgn;
      const sd = [
        pts(inner, xIn, ww0),
        pts(outer, xOut, ww1),
        pts(outer, xOut - 0.12, ww1),
        pts(inner, xIn - 0.12, ww0),
      ];
      const nn = [0, t[1] * sgn, t[2] * sgn];
      for (const q of [0, 1, 2, 0, 2, 3]) push(sd[q], nn, MAT_RIM);
    }
  };
  for (let k = 0; k < 5; ++k) {
    const a = (k / 5) * Math.PI * 2;
    spoke(a - 0.1, 0.035);
    spoke(a + 0.1, 0.035);
  }
  // Centre cap (hub).
  for (let i = 0; i < 20; ++i) {
    const a0 = (i / 20) * Math.PI * 2,
      a1 = ((i + 1) / 20) * Math.PI * 2;
    const P = [
      [hw * 0.52, 0, 0],
      ring(0.2, hw * 0.47, a0),
      ring(0.2, hw * 0.47, a1),
    ];
    for (const p of P) push(p, [1, 0, 0], MAT_RIM);
  }
  // Lug nuts.
  for (let k = 0; k < 5; ++k) {
    const a = ((k + 0.5) / 5) * Math.PI * 2;
    box(
      push,
      [hw * 0.53, Math.cos(a) * 0.14, Math.sin(a) * 0.14],
      [0.03, 0.022, 0.022],
      MAT_CHROME,
    );
  }
  // Caliper (fixed; the shader doesn't spin it): a curved block at the rear top.
  for (let i = 0; i < 6; ++i) {
    const a0 = Math.PI * 0.62 + (i / 6) * 0.55,
      a1 = Math.PI * 0.62 + ((i + 1) / 6) * 0.55;
    const P = [
      ring(0.56, hw * 0.3, a0),
      ring(0.4, hw * 0.3, a0),
      ring(0.4, hw * 0.3, a1),
      ring(0.56, hw * 0.3, a1),
    ];
    for (const q of [0, 1, 2, 0, 2, 3]) push(P[q], [1, 0, 0], MAT_CALIPER);
    const T = [
      ring(0.56, hw * 0.3, a0),
      ring(0.56, -hw * 0.1, a0),
      ring(0.56, -hw * 0.1, a1),
      ring(0.56, hw * 0.3, a1),
    ];
    const nt = (a: number) => [0, Math.cos(a), Math.sin(a)];
    for (const q of [0, 1, 2, 0, 2, 3])
      push(T[q], nt(q < 2 ? a0 : a1), MAT_CALIPER);
  }
  const out = orient(new Float32Array(v));
  return {vertices: out, count: out.length / V_FLOATS};
}
