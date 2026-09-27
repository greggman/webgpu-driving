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

import {BodyCurves, buildCurveBody} from './carBody';
import {SEDAN_BODY} from './bodies/sedan';
import {HATCH_BODY} from './bodies/hatch';
import {COUPE_BODY} from './bodies/coupe';
import {WAGON_BODY} from './bodies/wagon';
import {SUV_BODY} from './bodies/suv';

export type CarKind =
  | 'sedan'
  | 'hatch'
  | 'suv'
  | 'coupe'
  | 'wagon'
  | 'pickup'
  | 'semi'
  | 'bus'
  | 'trailer';
// Drivable vehicles (traffic and the player's choice). A semi tows a
// 'trailer', which is only drawn (see TRAILER below).
export const CAR_KINDS: CarKind[] = [
  'sedan',
  'hatch',
  'suv',
  'coupe',
  'wagon',
  'pickup',
  'semi',
  'bus',
];
// Everything with a mesh (render order / style index in the shader).
export const MESH_KINDS: CarKind[] = [...CAR_KINDS, 'trailer'];

// Semi rig geometry: the traffic sim treats a vehicle as symmetric about
// its arc length s, so for a semi s is the middle of the whole rig; the
// tractor and trailer centres are offset from it.
export const TRAILER = {
  length: 14.6,
  width: 2.6,
  kingpin: 1.0, // kingpin behind the trailer's front face
  axles: [-5.2, -6.45], // tandem, from the trailer centre
  wheelR: 0.5,
};
export function semiLayout() {
  const tr = carSpec('semi');
  const fifth = -tr.wheelbase / 2 + tr.axleShift - 0.66; // over the tandem
  const trailerCenter = fifth - (TRAILER.length / 2 - TRAILER.kingpin);
  const front = tr.length / 2;
  const rear = trailerCenter - TRAILER.length / 2;
  const mid = (front + rear) / 2;
  return {
    total: front - rear,
    tractor: -mid, // tractor centre relative to the rig's middle
    trailer: trailerCenter - mid,
  };
}

// Driver eye z (car-local).
export function driverZ(sp: CarSpec): number {
  // A driver's eyes sit ~1.25 m behind the base of the windscreen.
  return sp.wsBase - 1.25;
}

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
// Lamp / grille opening parts (curve-network bodies, see carBody.ts).
export const MAT_LAMP_HEAD = 23; // headlamp housing: chrome reflector
export const MAT_LAMP_TAIL = 24; // tail lamp body: red reflector
export const MAT_GRILLE = 25; // grille insert (mesh)
export const MAT_LENS = 26; // clear lamp lens (glass pass)
export const MAT_INTAKE = 27; // intake insert (dark mesh)
export const MAT_DRL = 28; // daytime running light strip (white LED)
export const MAT_PROJ = 29; // projector lens
export const MAT_LED = 30; // tail light guide (red LED)
export const MAT_MIRROR = 31; // door mirror glass

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
  thirdAxle?: number; // z of an extra (tandem) axle
  wheelWidth?: number; // wheel width scale (dual tyres)
  axleShift: number; // both axles moved forward by this (shorter front overhang)

  headlightY: number;
  taillightY: number;
  bedFront?: number; // pickup bed start (z)
  // Curve-network body (src/gen/bodies/*.ts); replaces the procedural
  // loft when present.
  body?: BodyCurves;
  // Compatibility with the shader / interior: [front cap y, ..., rear y].
  top: Array<[number, number]>;
  belt: number;
}

function spec(
  s: Omit<CarSpec, 'top' | 'belt' | 'headlightY' | 'taillightY'>,
): CarSpec {
  // (With a plate height override the "lamp" heights follow the plates:
  // for curve bodies they only place the plates / plate texture.)
  const pf = s.body?.plateY?.front,
    pr = s.body?.plateY?.rear;
  const headlightY = pf !== undefined ? pf + 0.32 : s.noseY - 0.05;
  const taillightY = pr !== undefined ? pr + 0.3 : s.tailY - 0.16;
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
        body: SEDAN_BODY,
        axleShift: 0.1,
        boxy: 6,
        cladding: false,
        quarter: true,
        flare: 0.025,
        length: 4.82,
        width: 1.86,
        wheelbase: 2.85,
        wheelR: 0.372,
        track: 1.63,
        clearance: 0.135,
        noseY: 0.74,
        hoodY: 0.95,
        beltF: 0.99,
        beltR: 1.07,
        deckY: 1.03,
        tailY: 1.0,
        roofY: 1.44,
        roofW: 0.78,
        wsBase: 1.18,
        roofFront: 0.42,
        roofBack: -0.72,
        rearBase: -1.6,
        sideRear: -1.2,
      });
    case 'hatch':
      return spec({
        kind,
        body: HATCH_BODY,
        axleShift: -0.05,
        boxy: 5,
        cladding: false,
        quarter: false,
        flare: 0.03,
        length: 4.28,
        width: 1.79,
        wheelbase: 2.64,
        wheelR: 0.335,
        track: 1.57,
        clearance: 0.14,
        noseY: 0.84,
        hoodY: 0.97,
        beltF: 0.97,
        beltR: 1.06,
        deckY: 1.06,
        tailY: 1.1,
        roofY: 1.46,
        roofW: 0.74,
        wsBase: 1.08,
        roofFront: 0.2,
        roofBack: -1.4,
        rearBase: -2.05,
        sideRear: -1.2,
      });
    case 'suv':
      return spec({
        kind,
        body: SUV_BODY,
        axleShift: 0.05,
        boxy: 7,
        cladding: true,
        quarter: true,
        flare: 0.03,
        length: 4.65,
        width: 1.87,
        wheelbase: 2.7,
        wheelR: 0.39,
        track: 1.67,
        clearance: 0.2,
        noseY: 0.9,
        hoodY: 1.16,
        beltF: 1.155,
        beltR: 1.22,
        deckY: 1.21,
        tailY: 1.28,
        roofY: 1.67,
        roofW: 0.78,
        wsBase: 0.95,
        roofFront: 0.2,
        roofBack: -1.9,
        rearBase: -2.24,
        sideRear: -1.3,
      });
    case 'coupe':
      return spec({
        kind,
        body: COUPE_BODY,
        axleShift: 0.09,
        boxy: 4.5,
        cladding: false,
        quarter: false,
        flare: 0.05,
        length: 4.5,
        width: 1.85,
        wheelbase: 2.83,
        wheelR: 0.36,
        track: 1.64,
        clearance: 0.115,
        noseY: 0.64,
        hoodY: 0.78,
        beltF: 0.88,
        beltR: 0.96,
        deckY: 0.98,
        tailY: 1.0,
        roofY: 1.285,
        roofW: 0.68,
        wsBase: 0.95,
        roofFront: 0.16,
        roofBack: -0.55,
        rearBase: -1.82,
        sideRear: -1.55,
      });
    case 'wagon':
      return spec({
        kind,
        body: WAGON_BODY,
        axleShift: 0.12,
        boxy: 5.5,
        cladding: false,
        quarter: true,
        flare: 0.025,
        length: 4.95,
        width: 1.88,
        wheelbase: 2.93,
        wheelR: 0.37,
        track: 1.63,
        clearance: 0.15,
        noseY: 0.72,
        hoodY: 0.95,
        beltF: 0.99,
        beltR: 1.06,
        deckY: 1.045,
        tailY: 1.07,
        roofY: 1.485,
        roofW: 0.74,
        wsBase: 1.1,
        roofFront: 0.3,
        roofBack: -2.1,
        rearBase: -2.37,
        sideRear: -1.3,
      });
    case 'pickup':
      return spec({
        kind,
        axleShift: 0.12,
        boxy: 9,
        cladding: true,
        quarter: false,
        flare: 0.03,
        length: 5.5,
        width: 2.0,
        wheelbase: 3.45,
        wheelR: 0.44,
        track: 1.75,
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
    case 'semi':
      // Conventional tractor: long hood, tall cab with a sleeper; the
      // frame and fifth wheel extend behind the body over the tandem.
      return spec({
        kind,
        axleShift: -0.6,
        boxy: 12,
        cladding: false,
        quarter: false,
        flare: 0.03,
        thirdAxle: -4.22,
        wheelWidth: 1.7,
        length: 5.8,
        width: 2.5,
        wheelbase: 4.6,
        wheelR: 0.52,
        track: 2.0,
        clearance: 0.5,
        noseY: 1.4,
        hoodY: 1.8,
        beltF: 1.95,
        beltR: 2.0,
        deckY: 2.0,
        tailY: 1.95,
        roofY: 3.35,
        roofW: 0.92,
        wsBase: 0.55,
        roofFront: -0.05,
        roofBack: -2.55,
        rearBase: -2.85,
        sideRear: -0.95,
      });
    case 'bus':
      return spec({
        kind,
        axleShift: 0.4,
        boxy: 14,
        cladding: false,
        quarter: false,
        flare: 0.0,
        wheelWidth: 1.4,
        length: 12.2,
        width: 2.55,
        wheelbase: 6.2,
        wheelR: 0.5,
        track: 2.05,
        clearance: 0.3,
        noseY: 1.15,
        hoodY: 1.2,
        beltF: 1.25,
        beltR: 1.3,
        deckY: 1.3,
        tailY: 1.25,
        roofY: 3.25,
        roofW: 0.97,
        wsBase: 5.98,
        roofFront: 5.72,
        roofBack: -5.85,
        rearBase: -6.02,
        sideRear: -5.7,
      });
    case 'trailer':
      // Only its spec is used for the shader (lamps, wheels); the mesh is
      // buildTrailer().
      return spec({
        kind,
        axleShift: (TRAILER.axles[0] + TRAILER.axles[1]) / 2,
        boxy: 20,
        cladding: false,
        quarter: false,
        flare: 0,
        wheelWidth: 1.7,
        length: TRAILER.length,
        width: TRAILER.width,
        wheelbase: TRAILER.axles[0] - TRAILER.axles[1],
        wheelR: TRAILER.wheelR,
        track: 2.05,
        clearance: 1.2,
        noseY: 3.9,
        hoodY: 4.0,
        beltF: 4.0,
        beltR: 4.0,
        deckY: 4.0,
        tailY: 1.35,
        roofY: 4.1,
        roofW: 1,
        wsBase: 7.3,
        roofFront: 7.3,
        roofBack: -7.3,
        rearBase: -7.3,
        sideRear: -7.3,
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

export type P3 = [number, number, number];

// Grid of points [station][ring] -> triangles with smooth normals and a
// per-quad material.
export function emitGrid(
  push: (p: number[], n: number[], m: number) => void,
  grid: P3[][],
  mat: (i: number, j: number) => number,
  outward: (p: P3) => P3,
  closedRing: boolean,
  // One orientation for the whole grid (decided at [0][0]) instead of per
  // vertex: for folded surfaces (e.g. a rolled lip) where "outward" flips.
  globalSign = false,
) {
  const NS = grid.length,
    NR = grid[0].length;
  let sign = 0;
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
      if (globalSign) {
        if (sign === 0) {
          const o = outward(grid[i][j]);
          sign = n[0] * o[0] + n[1] * o[1] + n[2] * o[2] < 0 ? -1 : 1;
        }
        n = [n[0] * sign, n[1] * sign, n[2] * sign];
      } else {
        const o = outward(grid[i][j]);
        if (n[0] * o[0] + n[1] * o[1] + n[2] * o[2] < 0)
          n = [-n[0], -n[1], -n[2]];
      }
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

// Resolution of the distant-car LOD mesh (about 1/6 of the vertices).
export const LOD_RES = 0.5;
// Resolution of the shadow-caster mesh (closed skin, no openings).
export const SHADOW_RES = 0.25;

// res < 1 builds a coarser mesh (distant-car LOD; curve bodies only).
export function buildCarBody(
  sp: CarSpec,
  res = 1,
  shadowOnly = false,
): MeshData {
  if (sp.body) return buildCurveBody(sp, sp.body, res, shadowOnly);
  const verts: number[] = [];
  const push = (p: number[], n: number[], m: number) => {
    verts.push(p[0], p[1], p[2], n[0], n[1], n[2], m, 0);
  };
  const L = sp.length,
    HW = sp.width / 2,
    R = sp.wheelR;
  const axles = [
    sp.wheelbase / 2 + sp.axleShift,
    -sp.wheelbase / 2 + sp.axleShift,
  ];
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
      let hood =
        sp.noseY +
        (Math.min(sp.hoodY, sp.beltF) - sp.noseY) * (1 - Math.pow(t, 2.3));
      hood -= 0.05 * smooth(0.85, 1, t);
      // The front fender must clear the tyre (arch + sheet metal).
      const fz = (z - axles[0]) / (R + 0.5);
      hood = Math.max(hood, 2 * R + 0.09 - 0.5 * fz * fz);
      // No step at the cowl: blend into the beltline under the windscreen.
      const cowl = 1 - smooth(0, 0.3, z - sp.wsBase);
      return hood + (sp.beltF - 0.01 - hood) * cowl;
    }
    if (z >= sp.rearBase) return belt(z) - 0.005;
    // Deck, falling off into the tail.
    const t = clamp01((sp.rearBase - z) / (sp.rearBase - tail));
    if (pickup) return sp.deckY - 0.02 * smooth(0.96, 1, t);
    const deck =
      sp.tailY +
      (Math.max(sp.deckY, sp.beltR) - sp.tailY) * (1 - Math.pow(t, 7));
    // A small ducktail lip at the trailing edge of the lid.
    return (
      deck -
      0.03 * smooth(0.94, 1, t) +
      0.012 * smooth(0.8, 0.93, t) * (1 - smooth(0.95, 1, t))
    );
  };
  const halfWidth = (z: number) => {
    const zn = z / (L / 2);
    const e = zn > 0 ? 8 : pickup ? 14 : 10;
    let w = HW * Math.pow(Math.max(0, 1 - Math.pow(Math.abs(zn), e)), 1 / e);
    w = Math.max(w, HW * 0.82);
    for (const az of axles) {
      const dz = Math.abs(z - az);
      const f = az > 0 ? 0.025 : sp.flare;
      w += f * Math.max(0, 1 - Math.pow(dz / (R + 0.45), 2));
    }
    return w;
  };
  const archR = R + 0.018;
  const bottomLine = (z: number, top: number) => {
    const zn = Math.abs(z) / (L / 2);
    let b = sp.clearance + 0.1 * smooth(0.72, 1, zn);
    for (const az of axles) {
      const dz = Math.abs(z - az);
      if (dz < archR)
        b = Math.max(b, R + Math.sqrt(archR * archR - dz * dz) * 0.97);
    }
    return Math.min(b, top - 0.08);
  };

  // ---- Lower body loft ----
  const zs: number[] = [];
  const NS = 150;
  for (let i = 0; i < NS; ++i) {
    const t = i / (NS - 1);
    // Denser near both ends.
    const u = t - (Math.sin(t * Math.PI * 2) / (Math.PI * 2)) * 0.6;
    zs.push(nose - u * L);
  }
  // Extra stations around each wheel arch (a smooth lip).
  for (const az of axles)
    for (let q = 0; q < 30; ++q) {
      const z = az + (archR + 0.05) * ((q / 29) * 2 - 1);
      if (z < nose - 0.01 && z > tail + 0.01) zs.push(z);
    }
  zs.sort((a, b) => b - a);
  const NH = 44; // points per half section
  const kq = (k26: number) => Math.round((k26 * NH) / 26); // (tuned at NH=26)
  const nExp = sp.boxy;
  const section = (z: number, endFactor: number): P3[] => {
    const top = topLine(z);
    const bot = bottomLine(z, top);
    const yc = (top + bot) / 2,
      hh = ((top - bot) / 2) * (0.85 + 0.15 * endFactor);
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
      x *= 1 - 0.06 * Math.max(0, yn);
      const sh = top - 0.12;
      // Rocker tuck-under.
      x *= 1 - 0.05 * smooth(-0.55, -0.95, yn);
      // The lower door plane falls away below the shoulder (light / dark
      // split at midday).
      x -= 0.018 * smooth(sh - 0.03, sh - 0.3, y) * smooth(-0.6, 0.2, yn);
      // Fascias: the upper front leans back; the rear lamp line overhangs
      // an undercut bumper.
      if (z > nose - 0.25)
        x *= 1 - 0.06 * smooth(nose - 0.25, nose, z) * clamp01(yn + 0.3);
      if (z < tail + 0.35)
        x -=
          0.018 * smooth(0.1, -0.3, yn) * smooth(tail + 0.35, tail + 0.05, z);
      x +=
        0.03 * Math.exp(-Math.abs(y - sh) / 0.01) * smooth(0.3, 0.6, yn + 0.5);
      x -=
        0.022 *
        Math.exp(
          -Math.pow(
            (y - (bot + (top - bot) * (0.26 + 0.1 * clamp01((nose - z) / L)))) /
              0.05,
            2,
          ),
        );
      // The sill reads as its own piece below the doors.
      x -= 0.008 * smooth(-0.7, -0.8, yn);
      if (hood && s > 0) {
        // Hood: centre lowered between two creases running to the lamps.
        const xr = x / w;
        const f = smooth(sp.wsBase, sp.wsBase + 0.15, z);
        y -= 0.03 * f * Math.max(0, 1 - Math.pow(xr / 0.65, 2));
        y += 0.012 * f * Math.exp(-Math.pow((xr - 0.68) / 0.06, 2));
      }
      half.push([x, y]);
    }
    for (let k = 0; k <= NH; ++k) ring.push([-half[k][0], half[k][1], z]);
    for (let k = NH - 1; k >= 0; --k) ring.push([half[k][0], half[k][1], z]);
    return ring;
  };
  const endFactorAt = (z: number) => {
    const e = Math.min(nose - z, z - tail);
    // Fascias wrap round into the sides instead of ending in a flat plate.
    return Math.sqrt(clamp01(e / (pickup ? 0.08 : z < 0 ? 0.07 : 0.1)));
  };
  const lower: P3[][] = zs.map(z => section(z, endFactorAt(z)));
  const RN = lower[0].length;
  const lowerMat = (i: number, j: number): number => {
    const z = (zs[i] + zs[i + 1]) / 2;
    const k = j < NH ? j : RN - 2 - j; // 0 (bottom) .. NH-1 (top)
    const p = lower[i][j];
    // Quad-average height: material boundaries follow the surface, not the
    // mesh stair-step.
    const qy =
      (lower[i][j][1] +
        lower[i + 1][j][1] +
        lower[i][j + 1][1] +
        lower[i + 1][j + 1][1]) /
      4;
    if (k < kq(3)) return MAT_UNDER;
    // Rear diffuser / lower valance.
    if (z < tail + 0.25 && p[1] < bottomLine(z, topLine(z)) + 0.16)
      return MAT_TRIM;
    // Open the top of the tub over the cabin (and the pickup bed).
    const open =
      (z < sp.wsBase - 0.05 && z > sp.rearBase + 0.05) ||
      (pickup && z < sp.bedFront! && z > tail + 0.12);
    if (open && k >= NH - kq(4)) return -1;
    // Black lower cladding / sills.
    const bot = bottomLine(z, topLine(z));
    if (sp.cladding && p[1] < bot + 0.1) return MAT_TRIM;
    // Arch lips / liners: the downward-facing skin around each wheel.
    for (const az of axles) {
      if (Math.abs(z - az) < archR + 0.03 && qy < bot + 0.015) return MAT_UNDER;
    }
    const between = Math.abs(z - sp.axleShift) < sp.wheelbase / 2 - archR;
    if (between && qy < bot + 0.05) return MAT_TRIM;
    if (z > nose - 0.3) return MAT_FRONT;
    if (z < tail + 0.3) return MAT_REAR;
    if (pickup && z < sp.bedFront! && k > NH - kq(5)) return MAT_TRIM;
    return MAT_PAINT;
  };
  emitGrid(push, lower, lowerMat, p => [p[0], p[1] - 0.6, p[2] * 0.25], true);
  // Wheel-arch liners: a dark half tube over each wheel so the arches
  // don't show the inside of the body shell.
  for (const az of axles) {
    for (const sx of [-1, 1]) {
      const rad = archR + 0.01;
      const x0 = sx * 0.2,
        x1 = sx * halfWidth(az) * 0.92;
      const grid: P3[][] = [];
      for (let a = 0; a <= 16; ++a) {
        const th = ((-25 + (a / 16) * 230) * Math.PI) / 180;
        grid.push([
          [x0, R + Math.sin(th) * rad, az + Math.cos(th) * rad],
          [x1, R + Math.sin(th) * rad, az + Math.cos(th) * rad],
        ]);
      }
      emitGrid(
        push,
        grid,
        () => MAT_UNDER,
        p => [0, R - p[1], az - p[2]],
        false,
      );
      // Inner cap (the wheel-well wall on the car's centre side).
      const cn = [-sx, 0, 0];
      for (let a = 0; a < grid.length - 1; ++a) {
        push([x0, R, az], cn, MAT_UNDER);
        push(grid[a][0], cn, MAT_UNDER);
        push(grid[a + 1][0], cn, MAT_UNDER);
      }
    }
  }
  // Fascia end caps.
  for (const [row, dir] of [
    [lower[0], 1],
    [lower[lower.length - 1], -1],
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
  const GS = Math.max(90, Math.round((sp.wsBase - sp.rearBase) * 30));
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
    // Full tumblehome only where the greenhouse is tall; where it shrinks to
    // the beltline (windscreen / backlight bases) the glass spans the width.
    const tall = clamp01(h / Math.max(sp.roofY - belt(z), 0.05));
    const wt = wb + (w * sp.roofW - wb) * Math.pow(tall, 0.6);
    const rc = Math.min(0.11, h * 0.45); // roof corner radius
    const half: Array<[number, number]> = [];
    // Side from the base up to the corner (tumblehome), then the rounded
    // corner, then across the roof to the centre.
    const sideN = 6,
      cornerN = 6,
      roofN = GH - sideN - cornerN;
    // Row 0-1 is the thin (18 mm) window seal at the beltline.
    const t0 = Math.min(0.018 / Math.max(h - rc, 1e-3), 0.3);
    for (let k = 0; k < sideN; ++k) {
      const t = k === 0 ? 0 : t0 + ((1 - t0) * (k - 1)) / sideN;
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
    // Window seal on the beltline (a thin chrome line on sedans).
    if (k === 0) return sp.kind === 'sedan' ? MAT_CHROME : MAT_TRIM;
    const side = k < 6;
    const corner = k >= 6 && k < 12;
    if (side) {
      if (k >= 5) return MAT_TRIM; // drip rail / window frame
      if (z > sp.wsBase - 0.12) return MAT_PAINT; // A pillar base
      if (sp.quarter && z < sp.sideRear - 0.1 && z > sp.rearBase + 0.2)
        return k === 1 || k === 4 ? MAT_TRIM : MAT_GLASS; // quarter window
      if (z < sp.sideRear) return MAT_PAINT; // C pillar
      if (sp.kind === 'bus') {
        // Window pillars every 1.3 m and the entry door up front.
        const q = (z - sp.rearBase) / 1.3;
        if (Math.abs(q - Math.round(q)) * 1.3 < 0.06) return MAT_TRIM;
        return MAT_GLASS;
      }
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
      mh = 0.13,
      md = 0.09;
    const x0 = sx * (wz + 0.1);
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
    box(push, [x0, y, z - 0.028], [mw * 0.38, mh * 0.32, 0.003], MAT_TRIM);
    // Arm.
    box(push, [sx * (wz + 0.01), y - 0.06, z], [0.07, 0.03, 0.045], MAT_PAINT);
    box(push, [sx * wz, y - 0.085, z + 0.01], [0.05, 0.012, 0.07], MAT_TRIM);
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
  // Semi tractor: frame rails, fifth wheel, fuel tanks, exhaust stacks,
  // rear fenders over the tandem, and an air deflector on the sleeper.
  if (sp.kind === 'semi') {
    const zb = tail,
      ze = (sp.thirdAxle ?? -4.2) - 0.75;
    const fr = sp.clearance + 0.55;
    for (const sx of [-1, 1])
      box(
        push,
        [sx * 0.45, fr, (zb + ze) / 2],
        [0.1, 0.16, (zb - ze) / 2],
        MAT_UNDER,
      );
    const fifth = -sp.wheelbase / 2 + sp.axleShift - 0.66;
    box(push, [0, fr + 0.22, fifth], [0.7, 0.05, 0.75], MAT_TRIM);
    box(
      push,
      [0, fr + 0.14, (zb + ze) / 2],
      [0.55, 0.04, (zb - ze) / 2],
      MAT_UNDER,
    );
    for (const sx of [-1, 1]) {
      // Chrome fuel tanks under the doors.
      box(
        push,
        [sx * (HW - 0.3), sp.clearance + 0.35, -0.9],
        [0.3, 0.3, 0.7],
        MAT_CHROME,
      );
      // Exhaust stacks behind the cab.
      box(
        push,
        [sx * (HW - 0.2), 2.6, tail - 0.1],
        [0.08, 1.1, 0.08],
        MAT_CHROME,
      );
      // Quarter fenders and mud flaps over / behind the tandem.
      const rR = sp.wheelR;
      for (const az of [
        -sp.wheelbase / 2 + sp.axleShift,
        sp.thirdAxle ?? -4.2,
      ]) {
        box(
          push,
          [sx * (sp.track / 2), 2 * rR + 0.1, az],
          [0.32, 0.03, rR + 0.08],
          MAT_TRIM,
        );
      }
      box(
        push,
        [sx * (sp.track / 2), rR, ze + 0.1],
        [0.3, rR * 0.8, 0.02],
        MAT_UNDER,
      );
    }
    // Roof air deflector over the sleeper.
    box(
      push,
      [0, sp.roofY + 0.25, sp.roofBack + 0.5],
      [HW * 0.85, 0.25, 0.5],
      MAT_PAINT,
    );
  }
  if (sp.kind === 'bus') {
    // Roof air-conditioning unit.
    box(push, [0, sp.roofY + 0.14, -1.2], [0.8, 0.14, 1.6], MAT_TRIM);
  }
  // Plates.
  box(
    push,
    [0, sp.headlightY - 0.32, nose + 0.005],
    [0.26, 0.06, 0.006],
    MAT_PLATE,
  );
  box(
    push,
    [0, sp.taillightY - 0.3, tail - 0.005],
    [0.26, 0.065, 0.006],
    MAT_PLATE,
  );
  const out = orient(new Float32Array(verts));
  return {vertices: out, count: out.length / V_FLOATS};
}

// Makes every triangle wind counter-clockwise around its vertex normals, so
// front_facing in the shader tells outside from inside.
export function orient(out: Float32Array): Float32Array {
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

export function box(
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

// 53 ft box trailer (drawn behind a semi tractor): van body, rear doors and
// lamp sill, under-frame, side skirts, landing gear and rear bumper.
export function buildTrailer(): MeshData {
  const verts: number[] = [];
  const push = (p: number[], n: number[], m: number) => {
    verts.push(p[0], p[1], p[2], n[0], n[1], n[2], m, 0);
  };
  const L = TRAILER.length / 2,
    W = TRAILER.width / 2;
  const y0 = 1.4,
    y1 = 4.05;
  box(push, [0, (y0 + y1) / 2, 0], [W, (y1 - y0) / 2, L], MAT_PAINT);
  // Corner posts and top rails.
  for (const sx of [-1, 1]) {
    box(push, [sx * (W + 0.005), y1 - 0.04, 0], [0.02, 0.05, L], MAT_CHROME);
    box(push, [sx * (W + 0.005), y0 + 0.04, 0], [0.02, 0.05, L], MAT_CHROME);
    box(
      push,
      [sx * (W - 0.05), (y0 + y1) / 2, -L - 0.01],
      [0.06, (y1 - y0) / 2, 0.02],
      MAT_CHROME,
    );
  }
  // Rear doors (split) and the lamp sill below them.
  box(
    push,
    [0, (y0 + y1) / 2, -L - 0.012],
    [0.012, (y1 - y0) / 2 - 0.05, 0.01],
    MAT_TRIM,
  );
  box(push, [0, y0 - 0.15, -L + 0.05], [W - 0.05, 0.15, 0.06], MAT_REAR);
  // Under-frame and cross members.
  box(push, [0, y0 - 0.12, 0.3], [0.5, 0.12, L - 0.4], MAT_UNDER);
  // Side skirts (aero) between the landing gear and the tandem.
  for (const sx of [-1, 1])
    box(push, [sx * (W - 0.1), 0.95, 0.2], [0.02, 0.4, 3.6], MAT_TRIM);
  // Landing gear.
  for (const sx of [-1, 1])
    box(push, [sx * 0.8, 0.8, L - 2.4], [0.06, 0.6, 0.06], MAT_UNDER);
  // Rear under-ride bumper.
  box(push, [0, 0.6, -L + 0.2], [W - 0.2, 0.06, 0.06], MAT_TRIM);
  for (const sx of [-1, 1])
    box(push, [sx * (W - 0.4), 0.9, -L + 0.3], [0.05, 0.35, 0.05], MAT_UNDER);
  // Rear plate.
  box(push, [0.8, y0 - 0.2, -L - 0.03], [0.16, 0.06, 0.006], MAT_PLATE);
  const out = orient(new Float32Array(verts));
  return {vertices: out, count: out.length / V_FLOATS};
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
  // Five twin spokes: a concave dish (hub set back, the spokes curving out
  // to the lip) with a ridged face that splits the highlight.
  const spoke = (ang: number, width: number) => {
    const c = Math.cos(ang),
      s = Math.sin(ang);
    const t = [0, -s, c]; // tangent (perpendicular to the radial dir)
    const inner = 0.19,
      outer = 0.62;
    const xIn = hw * 0.45,
      xOut = hw * 0.8;
    const back = 0.05;
    // Across the spoke: back edge, face edge, face, ridge, face, edge, back.
    const across: Array<[number, number]> = [
      [-1, -back],
      [-1, 0],
      [-0.5, 0.008],
      [0, 0.015],
      [0.5, 0.008],
      [1, 0],
      [1, -back],
    ];
    const grid: P3[][] = [];
    for (let i = 0; i <= 6; ++i) {
      const u = i / 6;
      const r = inner + (outer - inner) * u;
      const x = xIn + (xOut - xIn) * Math.pow(u, 1.7);
      const w = width * (1 - 0.3 * u);
      grid.push(
        across.map(([o, dx]) => [
          x + dx,
          c * r + t[1] * o * w,
          s * r + t[2] * o * w,
        ]),
      );
    }
    emitGrid(
      push,
      grid,
      () => MAT_RIM,
      p => {
        const off = p[1] * t[1] + p[2] * t[2];
        const sg = Math.abs(off) < 1e-6 ? 0 : Math.sign(off);
        return [0.6, t[1] * sg, t[2] * sg];
      },
      false,
    );
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
  // Caliper (fixed; the shader doesn't spin it): a rounded body that
  // straddles the disc's edge, with capsule-like ends.
  {
    // Behind the axle at about 9 o'clock (seen in profile, out of the
    // arch's shadow).
    const aC = -Math.PI / 2 - 0.45,
      aSpan = 0.9;
    const rc = 0.5,
      rr = 0.14, // radial half size
      xc = 0.04,
      xr = 0.075; // axial half size
    const grid: P3[][] = [];
    for (let i = 0; i <= 10; ++i) {
      const tt = i / 10;
      const a = aC + tt * aSpan;
      const e = Math.pow(
        Math.sin(Math.PI * Math.min(Math.max(tt, 0.02), 0.98)),
        0.3,
      );
      const row: P3[] = [];
      for (let j = 0; j < 16; ++j) {
        const th = (j / 16) * Math.PI * 2;
        const cs = Math.cos(th),
          sn = Math.sin(th);
        // Rounded-rectangle section.
        const px = Math.sign(cs) * Math.pow(Math.abs(cs), 0.4),
          py = Math.sign(sn) * Math.pow(Math.abs(sn), 0.4);
        row.push(ring(rc + py * rr * e, xc + px * xr * e, a) as P3);
      }
      grid.push(row);
    }
    emitGrid(
      push,
      grid,
      () => MAT_CALIPER,
      p => {
        const a = Math.atan2(p[2], p[1]);
        const q = ring(rc, xc, a);
        return [p[0] - q[0], p[1] - q[1], p[2] - q[2]];
      },
      true,
    );
  }
  const out = orient(new Float32Array(v));
  return {vertices: out, count: out.length / V_FLOATS};
}
